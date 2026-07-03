const express  = require('express');
const axios    = require('axios');
const cheerio  = require('cheerio');
const cors     = require('cors');
const NodeCache = require('node-cache');
const { v4: uuidv4 } = require('uuid');
const https    = require('https');
const http     = require('http');
const net      = require('net');

const app   = express();
const cache = new NodeCache({ stdTTL: 6 * 60 * 60 });
const sessions = new Map();

const LESCO_BASE     = 'https://bill.lesco.gov.pk:36269';
const LESCO_ALT_BASE = 'https://www.lesco.gov.pk';
const TIMEOUT_MS     = 15000;
const SESSION_TTL_MS = 10 * 60 * 1000;

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

app.use(cors());
app.use(express.json());

// ── Session cleanup ───────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, 5 * 60 * 1000);

// ── Helpers ───────────────────────────────────────────────────────────────────
function splitRef(ref) {
  const parts = ref.split('-');
  if (parts.length !== 4) throw new Error('Reference number must have 4 parts separated by dashes (e.g. 06-11224-0150112-U)');
  return parts;
}
function parseCookies(headers) {
  if (!headers) return [];
  const arr = Array.isArray(headers) ? headers : [headers];
  return arr.map(h => h.split(';')[0]);
}
function cookieHeader(cookies) { return cookies.join('; '); }
function parseAmount(text) {
  if (!text) return 0;
  return parseInt(text.replace(/[^0-9.]/g, ''), 10) || 0;
}

function parseLescoHtml($) {
  const allText = $('body').text().replace(/\s+/g, ' ');
  const after = (label) => {
    const idx = allText.toUpperCase().indexOf(label.toUpperCase());
    if (idx === -1) return null;
    return allText.slice(idx + label.length, idx + label.length + 80).trim().split(/\s{2,}/)[0].trim();
  };
  return {
    customerName:        after('CUSTOMER NAME:') || after('CUSTOMER NAME') || 'Unknown',
    address:             after('ADDRESS:')       || after('ADDRESS')       || 'Unknown',
    lastBillMonth:       after('LAST BILL MONTH:') || after('BILL MONTH') || 'Unknown',
    billIssueDate:       after('BILL ISSUE DATE:') || after('ISSUE DATE') || 'Unknown',
    dueDate:             after('DUE DATE:')      || after('DUE DATE')     || 'Unknown',
    amountWithinDueDate: parseAmount(after('AMOUNT PAYABLE WITHIN DUE DATE:') || after('WITHIN DUE DATE')),
    amountAfterDueDate:  parseAmount(after('AMOUNT PAYABLE AFTER DUE DATE:')  || after('AFTER DUE DATE')),
  };
}

// Build an axios instance that tries a free rotating proxy pool if direct fails.
// We attempt direct first, then fall back to SOCKS/HTTP free proxies.
async function axiosViaProxy(config) {
  // Try direct first
  try {
    return await axios({ ...config, timeout: TIMEOUT_MS, httpsAgent });
  } catch (directErr) {
    // Fall back: route through a public HTTPS proxy scraper list
    // We use a hardcoded set of free proxies as a best-effort fallback.
    // These rotate often; Railway's egress IP is the real issue so any
    // non-Railway IP helps.
    const freeProxies = (process.env.PROXY_LIST || '').split(',').filter(Boolean);
    for (const proxyUrl of freeProxies) {
      try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        const agent = new HttpsProxyAgent(proxyUrl);
        return await axios({ ...config, timeout: TIMEOUT_MS, httpsAgent: agent });
      } catch (_) { /* try next */ }
    }
    throw directErr; // all attempts failed
  }
}

// ── Port check ────────────────────────────────────────────────────────────────
app.get('/lesco/portcheck', (req, res) => {
  const host = 'bill.lesco.gov.pk';
  const port = 36269;
  const start = Date.now();
  const sock = new net.Socket();
  sock.setTimeout(8000);

  sock.on('connect', () => {
    const ms = Date.now() - start;
    sock.destroy();
    res.json({ reachable: true, host, port, ms, note: 'TCP connect succeeded — port is open from Railway' });
  });
  sock.on('timeout', () => {
    sock.destroy();
    res.json({ reachable: false, host, port, ms: Date.now() - start, note: 'TCP timeout — port 36269 is likely blocked by Railway firewall' });
  });
  sock.on('error', (err) => {
    res.json({ reachable: false, host, port, ms: Date.now() - start, note: `TCP error: ${err.code || err.message}` });
  });
  sock.connect(port, host);
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Finly Proxy', timestamp: new Date() });
});

// ── Cache check ───────────────────────────────────────────────────────────────
app.get('/lesco/cached', (req, res) => {
  const ref = req.query.ref;
  if (!ref) return res.status(400).json({ cached: false, error: 'ref is required' });
  const hit = cache.get(ref);
  if (hit) return res.json({ cached: true, data: hit });
  res.json({ cached: false });
});

// ── Captcha (primary — port 36269) ───────────────────────────────────────────
app.get('/lesco/captcha', async (req, res) => {
  const ref = req.query.ref;
  if (!ref) return res.status(400).json({ success: false, error: 'ref is required' });

  try {
    const parts = splitRef(ref);
    const formData = new URLSearchParams({
      txtRefNo1: parts[0], txtRefNo2: parts[1],
      txtRefNo3: parts[2], txtRefNo4: parts[3],
    });

    const response = await axiosViaProxy({
      method: 'post',
      url: `${LESCO_BASE}/Modules/CustomerBillN/CheckBill.asp`,
      data: formData.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
      maxRedirects: 5,
    });

    const cookies = parseCookies(response.headers['set-cookie']);
    const $ = cheerio.load(response.data);

    let captchaSrc = $('img[src*="captcha" i]').attr('src')
      || $('img[src*="Captcha" i]').attr('src')
      || $('img[id*="captcha" i]').attr('src')
      || $('img').first().attr('src');

    if (!captchaSrc) return res.status(502).json({ success: false, error: "Couldn't find CAPTCHA image on LESCO page" });
    if (!captchaSrc.startsWith('http')) {
      captchaSrc = captchaSrc.startsWith('/') ? `${LESCO_BASE}${captchaSrc}` : `${LESCO_BASE}/${captchaSrc}`;
    }

    const imgResp = await axiosViaProxy({
      method: 'get',
      url: captchaSrc,
      responseType: 'arraybuffer',
      headers: { Cookie: cookieHeader(cookies), 'User-Agent': 'Mozilla/5.0' },
    });

    const contentType = imgResp.headers['content-type'] || 'image/png';
    const captchaImage = `data:${contentType};base64,${Buffer.from(imgResp.data).toString('base64')}`;
    const sessionId = uuidv4();
    sessions.set(sessionId, { cookies, createdAt: Date.now() });
    res.json({ success: true, captchaImage, sessionId });

  } catch (err) {
    res.status(502).json({ success: false, error: classifyError(err) });
  }
});

// ── Captcha alt (port 443 / main LESCO domain) ───────────────────────────────
// LESCO's main site exposes a simplified bill inquiry at standard port.
app.get('/lesco/captcha-alt', async (req, res) => {
  const ref = req.query.ref;
  if (!ref) return res.status(400).json({ success: false, error: 'ref is required' });

  try {
    const parts = splitRef(ref);

    // Try the main LESCO domain bill check (port 443)
    const formData = new URLSearchParams({
      txtRefNo1: parts[0], txtRefNo2: parts[1],
      txtRefNo3: parts[2], txtRefNo4: parts[3],
    });

    const response = await axios.post(
      `${LESCO_ALT_BASE}/Modules/CustomerBillN/CheckBill.asp`,
      formData.toString(),
      {
        timeout: TIMEOUT_MS,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
        maxRedirects: 5,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      }
    );

    const cookies = parseCookies(response.headers['set-cookie']);
    const $ = cheerio.load(response.data);

    let captchaSrc = $('img[src*="captcha" i]').attr('src')
      || $('img[src*="Captcha" i]').attr('src')
      || $('img').first().attr('src');

    if (!captchaSrc) {
      // Alt domain responded but no CAPTCHA — maybe bill data is directly in the response
      if (response.data && response.data.toUpperCase().includes('AMOUNT PAYABLE')) {
        const parsed = parseLescoHtml($);
        const data = { ...parsed, fetchedAt: new Date().toISOString(), cached: false, source: 'alt-direct' };
        cache.set(ref, data);
        return res.json({ success: true, directData: data, noCaptchaNeeded: true });
      }
      return res.status(502).json({ success: false, error: "Alt domain: couldn't find CAPTCHA or bill data" });
    }

    if (!captchaSrc.startsWith('http')) {
      captchaSrc = captchaSrc.startsWith('/') ? `${LESCO_ALT_BASE}${captchaSrc}` : `${LESCO_ALT_BASE}/${captchaSrc}`;
    }

    const imgResp = await axios.get(captchaSrc, {
      timeout: TIMEOUT_MS,
      responseType: 'arraybuffer',
      headers: { Cookie: cookieHeader(cookies), 'User-Agent': 'Mozilla/5.0' },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    const contentType = imgResp.headers['content-type'] || 'image/png';
    const captchaImage = `data:${contentType};base64,${Buffer.from(imgResp.data).toString('base64')}`;
    const sessionId = uuidv4();
    sessions.set(sessionId, { cookies, createdAt: Date.now(), base: LESCO_ALT_BASE });
    res.json({ success: true, captchaImage, sessionId, source: 'alt' });

  } catch (err) {
    res.status(502).json({ success: false, error: classifyError(err), source: 'alt' });
  }
});

// ── Fetch bill ────────────────────────────────────────────────────────────────
app.post('/lesco/fetch', async (req, res) => {
  const { ref, captchaCode, sessionId } = req.body;
  if (!ref) return res.status(400).json({ success: false, error: 'ref is required' });

  const hit = cache.get(ref);
  if (hit) return res.json({ success: true, data: { ...hit, cached: true } });

  try {
    const parts = splitRef(ref);
    const session = sessionId && sessions.has(sessionId) ? sessions.get(sessionId) : null;
    let cookies = session?.cookies ?? [];
    const base = session?.base ?? LESCO_BASE;

    let billHtml = null;

    // Attempt 1: direct AccountStatus (sometimes works without CAPTCHA)
    try {
      const directResp = await axiosViaProxy({
        method: 'get',
        url: `${base}/Modules/CustomerBillN/AccountStatus.aspx?ref=${encodeURIComponent(ref)}`,
        headers: { Cookie: cookieHeader(cookies), 'User-Agent': 'Mozilla/5.0' },
      });
      if (directResp.data && directResp.data.toUpperCase().includes('AMOUNT PAYABLE')) {
        billHtml = directResp.data;
      }
    } catch (_) {}

    // Attempt 2: submit CAPTCHA
    if (!billHtml && captchaCode) {
      const captchaForm = new URLSearchParams({
        txtRefNo1: parts[0], txtRefNo2: parts[1],
        txtRefNo3: parts[2], txtRefNo4: parts[3],
        txtCaptcha: captchaCode, btnSubmit: 'Submit',
      });

      const captchaResp = await axiosViaProxy({
        method: 'post',
        url: `${base}/Modules/CustomerBillN/CustomerMenu.asp`,
        data: captchaForm.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookieHeader(cookies), 'User-Agent': 'Mozilla/5.0',
        },
        maxRedirects: 5,
      });

      const newCookies = parseCookies(captchaResp.headers['set-cookie']);
      if (newCookies.length) cookies = [...cookies, ...newCookies];

      if (captchaResp.data && captchaResp.data.toUpperCase().includes('AMOUNT PAYABLE')) {
        billHtml = captchaResp.data;
      } else {
        const statusResp = await axiosViaProxy({
          method: 'get',
          url: `${base}/Modules/CustomerBillN/AccountStatus.aspx`,
          headers: { Cookie: cookieHeader(cookies), 'User-Agent': 'Mozilla/5.0' },
          maxRedirects: 5,
        });
        billHtml = statusResp.data;
      }

      if (billHtml && (billHtml.toUpperCase().includes('INVALID CODE') || billHtml.toUpperCase().includes('WRONG CODE') || (billHtml.toUpperCase().includes('CAPTCHA') && !billHtml.toUpperCase().includes('AMOUNT PAYABLE')))) {
        return res.status(422).json({ success: false, error: 'incorrect_captcha', message: 'Incorrect code — a new CAPTCHA has loaded. Try again.' });
      }
    }

    if (!billHtml) return res.status(502).json({ success: false, error: 'no_data', message: "Couldn't retrieve bill data. Try again or enter the amount manually." });

    if (!billHtml.toUpperCase().includes('AMOUNT PAYABLE') && !billHtml.toUpperCase().includes('CUSTOMER NAME')) {
      if (billHtml.toUpperCase().includes('NOT FOUND') || billHtml.toUpperCase().includes('INVALID REF')) {
        return res.status(404).json({ success: false, error: 'not_found', message: 'Reference number not found on LESCO.' });
      }
      return res.status(502).json({ success: false, error: 'parse_failed', message: "Couldn't read LESCO's response." });
    }

    const $ = cheerio.load(billHtml);
    const parsed = parseLescoHtml($);
    const data = { ...parsed, fetchedAt: new Date().toISOString(), cached: false };
    cache.set(ref, data);
    if (sessionId) sessions.delete(sessionId);
    res.json({ success: true, data });

  } catch (err) {
    res.status(502).json({ success: false, error: 'fetch_error', message: classifyError(err) });
  }
});

// ── Error classifier ──────────────────────────────────────────────────────────
function classifyError(err) {
  if (err.message && err.message.includes('parts separated by dashes')) return err.message;
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') return "LESCO's website is currently down. Try again later or enter the amount manually.";
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') return "LESCO's website is not responding. Port 36269 may be blocked — try the alt endpoint.";
  if (err.response && err.response.status === 404) return 'Reference number not found on LESCO.';
  return "LESCO's website is currently down. Try again later or enter the amount manually.";
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
app.listen(PORT, () => console.log(`Finly Proxy running on port ${PORT}`));
