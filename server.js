const express = require('express');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

// Optional API token set korar jonno Render Environment Variables-e EXTRACTOR_TOKEN dite paren
const REQUIRED_TOKEN = process.env.EXTRACTOR_TOKEN || '';

app.use(cors());
app.use(express.json());

function cleanText(str) {
  return String(str || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function guessNameFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    let path = decodeURIComponent(u.pathname || '');
    path = path.replace(/\/(?:p|dp|gp\/product)\/[a-zA-Z0-9_-]+.*$/i, '');
    const segments = path.split('/').filter(Boolean);
    let best = '';
    for (const seg of segments) {
      const cleaned = seg
        .replace(/[-_]+/g, ' ')
        .replace(/\b(?:buy|online|india|flipkart|meesho|shopsy|amazon|item|product)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned.length > best.length && !/^\d+$/.test(cleaned)) {
        best = cleaned;
      }
    }
    return best ? best.replace(/\b\w/g, c => c.toUpperCase()) : '';
  } catch {
    return '';
  }
}

function parsePrice(val) {
  if (val === undefined || val === null) return '';
  const cleaned = String(val).replace(/[^0-9.]/g, '');
  if (!cleaned) return '';
  const num = parseFloat(cleaned);
  return Number.isFinite(num) && num > 0 ? String(num) : '';
}

function extractFromHtml(html, targetUrl) {
  const $ = cheerio.load(html);
  const out = {
    name: '',
    price: '',
    image: '',
    description: '',
    source_url: targetUrl
  };

  // 1. JSON-LD Product Schema
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed['@graph'])
        ? parsed['@graph']
        : Array.isArray(parsed)
          ? parsed
          : [parsed];

      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const typeStr = Array.isArray(item['@type']) ? item['@type'].join(',') : String(item['@type'] || '');
        if (/product/i.test(typeStr)) {
          if (!out.name && item.name) out.name = cleanText(item.name);
          if (!out.description && item.description) out.description = cleanText(item.description);
          if (!out.image && item.image) {
            const img = Array.isArray(item.image) ? item.image[0] : item.image;
            if (typeof img === 'string') out.image = img.trim();
            else if (img && typeof img.url === 'string') out.image = img.url.trim();
          }
          if (!out.price && item.offers) {
            const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
            if (offer && typeof offer === 'object') {
              out.price = parsePrice(offer.price ?? offer.lowPrice ?? offer.highPrice);
            }
          }
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  });

  // 2. OpenGraph & Meta Tags
  if (!out.name) {
    out.name = cleanText(
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="twitter:title"]').attr('content') ||
      $('title').first().text()
    );
  }

  if (!out.image) {
    out.image = cleanText(
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content')
    );
  }

  if (!out.description) {
    out.description = cleanText(
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content')
    );
  }

  if (!out.price) {
    out.price = parsePrice(
      $('meta[property="product:price:amount"]').attr('content') ||
      $('meta[itemprop="price"]').attr('content')
    );
  }

  // 3. Site-specific & generic DOM/Image/Price fallbacks
  if (!out.image) {
    const imgMatch =
      html.match(/https?:\/\/rukminim[12]\.[a-z0-9.-]+\/image\/[^"\'\s<>]+/i) ||
      html.match(/https?:\/\/images\.meesho\.com\/images\/products\/[^"\'\s<>]+/i);
    if (imgMatch) out.image = imgMatch[0];
  }

  if (!out.price) {
    const jsonPrice = html.match(/"(?:finalPrice|sellingPrice|discounted_price|specialPrice)"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/i);
    const rupeePrice = html.match(/(?:₹|Rs\.?|INR)\s*([0-9,]{2,8})/i);
    if (jsonPrice) out.price = parsePrice(jsonPrice[1]);
    else if (rupeePrice) out.price = parsePrice(rupeePrice[1]);
  }

  // Clean common store suffixes from name
  out.name = out.name
    .replace(/\s*[-|:]\s*(Buy Online.*|Flipkart\.com|Meesho|Shopsy).*$/i, '')
    .trim();

  if (!out.name) {
    out.name = guessNameFromUrl(targetUrl);
  }

  return out;
}

async function fetchTargetPage(targetUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    const html = await response.text();
    return { ok: response.ok, status: response.status, html };
  } finally {
    clearTimeout(timer);
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'THE ARCHIVE Product Extractor API' });
});

app.get('/extract', async (req, res) => {
  const token = req.headers['x-api-token'] || req.query.token || '';
  if (REQUIRED_TOKEN && token !== REQUIRED_TOKEN) {
    return res.status(401).json({ error: 'Invalid API token' });
  }

  const targetUrl = String(req.query.url || '').trim();
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: 'Only http/https URLs allowed' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid product URL' });
  }

  try {
    const page = await fetchTargetPage(parsedUrl.toString());
    const extracted = extractFromHtml(page.html || '', parsedUrl.toString());
    const hasCoreData = Boolean(extracted.name || extracted.price || extracted.image);

    return res.json({
      ...extracted,
      http_status: page.status,
      partial: !(extracted.name && extracted.price && extracted.image),
      message: hasCoreData
        ? 'Render API theke details extract hoyeche! Proyojon hole edit kore Save korun.'
        : 'Site-ta anti-bot challenge dekhachhe tai kichu field faka thakte pare; niche manually edit kore Save korun.'
    });
  } catch (err) {
    const fallbackName = guessNameFromUrl(parsedUrl.toString());
    return res.json({
      name: fallbackName,
      price: '',
      image: '',
      description: '',
      source_url: parsedUrl.toString(),
      partial: true,
      message: 'Connection/block hoyeche. Ja pawa geche fill kora hoyeche — niche edit kore Save korun.'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Extractor API running on port ${PORT}`);
});
