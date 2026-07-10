const express   = require('express');
const axios     = require('axios');
const cheerio   = require('cheerio');
const cors      = require('cors');
const NodeCache = require('node-cache');
const net       = require('net');

const app   = express();
const cache = new NodeCache({ stdTTL: 6 * 60 * 60 });

// ── PITC endpoints (port 443, no CAPTCHA, reachable from any cloud provider) ──
const PITC_LESCO = 'https://bill.pitc.com.pk/lescobill/general';
const TIMEOUT_MS = 15000;

app.use(cors());
app.use(express.json());

// ── Helpers ───────────────────────────────────────────────────────────────────

// Convert "06-11224-0150112-U" → "0611224015012" (14-digit numeric refno for PITC)
// PITC drops the trailing letter — only the numeric parts joined.
function toRefno(ref) {
  const parts = ref.split('-');
  if (parts.length < 3) throw new Error('Reference number must be in XX-XXXXX-XXXXXXX-X format');
  return parts.slice(0, 3).join('');
}

function parseAmount(text) {
  if (!text) return 0;
  return parseInt(text.replace(/[^0-9]/g, ''), 10) || 0;
}

// Parse PITC HTML — tries selector-based first, falls back to text scan.
function parsePitcHtml($, rawHtml) {
  // Strategy 1: scan structured rows
  // PITC renders rows like: <div class="row"> <div>Label</div><div>Value</div> </div>
  const fields = {};
  $('tr, .row, .row-shaded').each((_, el) => {
    const cells = $(el).find('td, th, div, strong, span');
    if (cells.length >= 2) {
      const label = $(cells[0]).text().trim().toUpperCase().replace(/\s+/g, ' ');
      const value = $(cells[1]).text().trim();
      if (label && value) fields[label] = value;
    }
  });

  // Strategy 2: plain text scan (most reliable across layout changes)
  const allText = (rawHtml || $('body').text()).replace(/\s+/g, ' ');
  const after = (label) => {
    const idx = allText.toUpperCase().indexOf(label.toUpperCase());
    if (idx === -1) return null;
    return allText.slice(idx + label.length, idx + label.length + 100).trim().split(/\s{2,}/)[0].trim();
  };

  const get = (...labels) => {
    for (const l of labels) {
      const v = fields[l.toUpperCase()] || after(l);
      if (v && v.length < 80) return v;
    }
    return null;
  };

  const customerName        = get('CUSTOMER NAME:', 'NAME:', 'CONSUMER NAME:') || 'Unknown';
  const address             = get('ADDRESS:', 'INSTALLATION ADDRESS:') || 'Unknown';
  const lastBillMonth       = get('BILL MONTH:', 'LAST BILL MONTH:', 'MONTH:') || 'Unknown';
  const billIssueDate       = get('BILL ISSUE DATE:', 'ISSUE DATE:', 'BILL DATE:') || 'Unknown';
  const dueDate             = get('DUE DATE:', 'PAYABLE DATE:', 'LAST DATE:') || 'Unknown';
  const amountWithinDueDate = parseAmount(get('AMOUNT PAYABLE WITHIN DUE DATE:', 'AMOUNT WITHIN DUE DATE:', 'PAYABLE WITHIN DUE DATE:', 'WITHIN DUE DATE:'));
  const amountAfterDueDate  = parseAmount(get('AMOUNT PAYABLE AFTER DUE DATE:', 'AMOUNT AFTER DUE DATE:', 'AFTER DUE DATE:'));
  const unitsConsumed       = get('UNITS CONSUMED:', 'UNITS:') || null;

  return { customerName, address, lastBillMonth, billIssueDate, dueDate, amountWithinDueDate, amountAfterDueDate, unitsConsumed };
}

// Core PITC fetch — called by multiple routes
async function fetchPitcBill(ref) {
  const refno = toRefno(ref);
  console.log(`[PITC] Fetching ref=${ref} refno=${refno}`);

  const response = await axios.get(PITC_LESCO, {
    params: { refno },
    timeout: TIMEOUT_MS,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
  });

  console.log(`[PITC] HTTP ${response.status} — body length: ${response.data?.length ?? 0}`);

  const html  = response.data || '';
  const upper = html.toUpperCase();

  // Detect "not found" before parsing
  if (
    upper.includes('NO RECORD FOUND') ||
    upper.includes('NOT FOUND') ||
    upper.includes('INVALID REF') ||
    upper.includes('RECORD NOT FOUND') ||
    (html.length < 300 && !upper.includes('AMOUNT'))
  ) {
    console.log('[PITC] Not found / invalid ref');
    return { notFound: true };
  }

  if (!upper.includes('AMOUNT') && !upper.includes('CUSTOMER') && !upper.includes('CONSUMER')) {
    console.log('[PITC] Response does not look like bill data');
    console.log('[PITC] First 500 chars:', html.slice(0, 500));
    return { unparseable: true, snippet: html.slice(0, 500) };
  }

  const $ = cheerio.load(html);
  const parsed = parsePitcHtml($, html);
  console.log('[PITC] Parsed:', JSON.stringify(parsed));
  return { ok: true, parsed };
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Finly Proxy (PITC)', timestamp: new Date() });
});

// ── PITC port check (443 — should always be reachable) ───────────────────────
app.get('/pitc/portcheck', (req, res) => {
  const host = 'bill.pitc.com.pk';
  const port = 443;
  const start = Date.now();
  const sock  = new net.Socket();
  sock.setTimeout(6000);
  sock.on('connect', () => { const ms = Date.now() - start; sock.destroy(); res.json({ reachable: true, host, port, ms, note: 'TCP connect OK — PITC is reachable on port 443' }); });
  sock.on('timeout', () => { sock.destroy(); res.json({ reachable: false, host, port, ms: Date.now() - start, note: 'TCP timeout on port 443 — unexpected' }); });
  sock.on('error',   (e) => { res.json({ reachable: false, host, port, ms: Date.now() - start, note: `TCP error: ${e.code || e.message}` }); });
  sock.connect(port, host);
});

// ── PITC raw test — inspect exactly what we get ──────────────────────────────
app.get('/lesco/pitc-test', async (req, res) => {
  const ref = req.query.ref;
  if (!ref) return res.status(400).json({ error: 'ref is required — e.g. ?ref=06-11224-0150112-U' });

  let refno;
  try { refno = toRefno(ref); } catch (e) { return res.status(400).json({ error: e.message }); }

  const result = { ref, refno, url: `${PITC_LESCO}?refno=${refno}`, attempts: [] };

  // Attempt 1: numeric refno (parts 0-2 joined)
  for (const params of [{ refno }, { appno: refno }, { refno: ref.split('-').slice(0,3).join('') }]) {
    try {
      const r = await axios.get(PITC_LESCO, {
        params,
        timeout: TIMEOUT_MS,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'text/html,*/*' },
      });
      const html = r.data || '';
      const upper = html.toUpperCase();
      const hasAmount   = upper.includes('AMOUNT');
      const hasCustomer = upper.includes('CUSTOMER') || upper.includes('CONSUMER');
      result.attempts.push({
        params,
        status: r.status,
        bodyLength: html.length,
        hasAmount,
        hasCustomer,
        snippet: html.slice(0, 800),
      });
      if (hasAmount || hasCustomer) {
        const $ = cheerio.load(html);
        result.parsed = parsePitcHtml($, html);
        result.success = true;
        break;
      }
    } catch (e) {
      result.attempts.push({ params, error: e.message, code: e.code, status: e.response?.status, snippet: e.response?.data?.slice?.(0, 400) });
    }
  }

  res.json(result);
});

// ── Cache check ───────────────────────────────────────────────────────────────
app.get('/lesco/cached', (req, res) => {
  const ref = req.query.ref;
  if (!ref) return res.status(400).json({ cached: false, error: 'ref is required' });
  const hit = cache.get(ref);
  if (hit) return res.json({ cached: true, data: hit });
  res.json({ cached: false });
});

// ── /lesco/captcha — now PITC-backed, no CAPTCHA needed ──────────────────────
// Returns { success, noCaptchaNeeded: true, data } when PITC works.
// App checks noCaptchaNeeded and skips the CAPTCHA UI entirely.
app.get('/lesco/captcha', async (req, res) => {
  const ref = req.query.ref;
  if (!ref) return res.status(400).json({ success: false, error: 'ref is required' });

  // Cache hit — return immediately
  const hit = cache.get(ref);
  if (hit) return res.json({ success: true, noCaptchaNeeded: true, data: { ...hit, cached: true } });

  try {
    const result = await fetchPitcBill(ref);

    if (result.notFound) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Reference number not found on PITC/LESCO.' });
    }
    if (result.unparseable) {
      return res.status(502).json({ success: false, error: 'parse_failed', message: "Couldn't read bill data from PITC. Try again.", debug: result.snippet });
    }

    const data = { ...result.parsed, fetchedAt: new Date().toISOString(), cached: false, source: 'pitc' };
    cache.set(ref, data);
    return res.json({ success: true, noCaptchaNeeded: true, data });

  } catch (err) {
    console.error('[PITC] /lesco/captcha error:', err.message);
    return res.status(502).json({ success: false, error: classifyError(err) });
  }
});

// ── /lesco/fetch — PITC-backed, captchaCode ignored ──────────────────────────
app.post('/lesco/fetch', async (req, res) => {
  const { ref } = req.body;
  if (!ref) return res.status(400).json({ success: false, error: 'ref is required' });

  const hit = cache.get(ref);
  if (hit) return res.json({ success: true, data: { ...hit, cached: true } });

  try {
    const result = await fetchPitcBill(ref);

    if (result.notFound) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Reference number not found on PITC/LESCO.' });
    }
    if (result.unparseable) {
      return res.status(502).json({ success: false, error: 'parse_failed', message: "Couldn't read bill data from PITC. Try again or enter the amount manually." });
    }

    const data = { ...result.parsed, fetchedAt: new Date().toISOString(), cached: false, source: 'pitc' };
    cache.set(ref, data);
    res.json({ success: true, data });

  } catch (err) {
    console.error('[PITC] /lesco/fetch error:', err.message);
    res.status(502).json({ success: false, error: 'fetch_error', message: classifyError(err) });
  }
});

// ── Error classifier ──────────────────────────────────────────────────────────
function classifyError(err) {
  if (err.message?.includes('format')) return err.message;
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') return "PITC bill portal is currently unreachable. Try again later or enter the amount manually.";
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') return "PITC bill portal timed out. Try again or enter the amount manually.";
  if (err.response?.status === 404) return 'Reference number not found.';
  if (err.response?.status === 503) return 'PITC portal is temporarily unavailable. Try again later.';
  return "Couldn't retrieve bill data. Try again or enter the amount manually.";
}

// ── Keep-alive ping (Render free tier spins down after 15 min inactivity) ────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => {
    axios.get(`${RENDER_URL}/health`).catch(() => {});
  }, 10 * 60 * 1000);
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Finly Proxy (PITC) running on port ${PORT}`));
