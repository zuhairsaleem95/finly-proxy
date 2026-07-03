const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cors    = require('cors');
const NodeCache = require('node-cache');
const { v4: uuidv4 } = require('uuid');
const https   = require('https');

const app   = express();
const cache = new NodeCache({ stdTTL: 6 * 60 * 60 }); // 6 hour TTL
const sessions = new Map(); // sessionId -> { cookies, createdAt }

const LESCO_BASE = 'https://bill.lesco.gov.pk:36269';
const TIMEOUT_MS = 15000;
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Ignore self-signed certs on LESCO's server
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

app.use(cors());
app.use(express.json());

// Clean up expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, 5 * 60 * 1000);

// ── Helpers ──────────────────────────────────────────────────────────────────

function splitRef(ref) {
  const parts = ref.split('-');
  if (parts.length !== 4) throw new Error('Reference number must have 4 parts separated by dashes (e.g. 06-11224-0150112-U)');
  return parts;
}

function parseCookies(setCookieHeaders) {
  if (!setCookieHeaders) return [];
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  return headers.map(h => h.split(';')[0]);
}

function cookieHeader(cookies) {
  return cookies.join('; ');
}

function parseAmount(text) {
  if (!text) return 0;
  const cleaned = text.replace(/[^0-9.]/g, '');
  return parseInt(cleaned, 10) || 0;
}

function parseLescoHtml($) {
  const text = $.html();

  const extract = (label) => {
    const regex = new RegExp(label + '[\\s\\S]*?<[^>]+>([^<]+)<', 'i');
    const m = text.match(regex);
    return m ? m[1].trim() : null;
  };

  // Try td-based extraction (common in LESCO table layout)
  const allText = $('body').text().replace(/\s+/g, ' ');

  const after = (label) => {
    const idx = allText.toUpperCase().indexOf(label.toUpperCase());
    if (idx === -1) return null;
    return allText.slice(idx + label.length, idx + label.length + 80).trim().split(/\s{2,}/)[0].trim();
  };

  const customerName        = after('CUSTOMER NAME:') || after('CUSTOMER NAME') || extract('CUSTOMER NAME');
  const address             = after('ADDRESS:') || after('ADDRESS') || extract('ADDRESS');
  const lastBillMonth       = after('LAST BILL MONTH:') || after('LAST BILL MONTH') || after('BILL MONTH');
  const billIssueDate       = after('BILL ISSUE DATE:') || after('BILL ISSUE DATE') || after('ISSUE DATE');
  const dueDate             = after('DUE DATE:') || after('DUE DATE');
  const amountWithinRaw     = after('AMOUNT PAYABLE WITHIN DUE DATE:') || after('AMOUNT PAYABLE WITHIN DUE DATE') || after('WITHIN DUE DATE');
  const amountAfterRaw      = after('AMOUNT PAYABLE AFTER DUE DATE:') || after('AMOUNT PAYABLE AFTER DUE DATE') || after('AFTER DUE DATE');

  return {
    customerName:          customerName || 'Unknown',
    address:               address      || 'Unknown',
    lastBillMonth:         lastBillMonth || 'Unknown',
    billIssueDate:         billIssueDate || 'Unknown',
    dueDate:               dueDate      || 'Unknown',
    amountWithinDueDate:   parseAmount(amountWithinRaw),
    amountAfterDueDate:    parseAmount(amountAfterRaw),
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Finly Proxy', timestamp: new Date() });
});

// GET /lesco/cached?ref=...
app.get('/lesco/cached', (req, res) => {
  const ref = req.query.ref;
  if (!ref) return res.status(400).json({ cached: false, error: 'ref is required' });
  const hit = cache.get(ref);
  if (hit) return res.json({ cached: true, data: hit });
  res.json({ cached: false });
});

// GET /lesco/captcha?ref=...
app.get('/lesco/captcha', async (req, res) => {
  const ref = req.query.ref;
  if (!ref) return res.status(400).json({ success: false, error: 'ref is required' });

  try {
    const parts = splitRef(ref);
    const formData = new URLSearchParams({
      txtRefNo1: parts[0],
      txtRefNo2: parts[1],
      txtRefNo3: parts[2],
      txtRefNo4: parts[3],
    });

    const response = await axios.post(
      `${LESCO_BASE}/Modules/CustomerBillN/CheckBill.asp`,
      formData.toString(),
      {
        httpsAgent,
        timeout: TIMEOUT_MS,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
        maxRedirects: 5,
      }
    );

    const cookies = parseCookies(response.headers['set-cookie']);
    const $ = cheerio.load(response.data);

    // Find CAPTCHA image
    let captchaSrc = $('img[src*="captcha" i]').attr('src')
      || $('img[src*="Captcha" i]').attr('src')
      || $('img[id*="captcha" i]').attr('src')
      || $('img[name*="captcha" i]').attr('src');

    if (!captchaSrc) {
      // Fallback: first img tag
      captchaSrc = $('img').first().attr('src');
    }

    if (!captchaSrc) {
      return res.status(502).json({ success: false, error: "Couldn't find CAPTCHA image on LESCO page" });
    }

    // Make absolute URL
    if (!captchaSrc.startsWith('http')) {
      captchaSrc = captchaSrc.startsWith('/') ? `${LESCO_BASE}${captchaSrc}` : `${LESCO_BASE}/${captchaSrc}`;
    }

    // Fetch CAPTCHA image as base64
    const imgResp = await axios.get(captchaSrc, {
      httpsAgent,
      timeout: TIMEOUT_MS,
      responseType: 'arraybuffer',
      headers: { Cookie: cookieHeader(cookies), 'User-Agent': 'Mozilla/5.0' },
    });

    const contentType = imgResp.headers['content-type'] || 'image/png';
    const base64 = Buffer.from(imgResp.data).toString('base64');
    const captchaImage = `data:${contentType};base64,${base64}`;

    const sessionId = uuidv4();
    sessions.set(sessionId, { cookies, createdAt: Date.now() });

    res.json({ success: true, captchaImage, sessionId });

  } catch (err) {
    const msg = classifyError(err);
    res.status(502).json({ success: false, error: msg });
  }
});

// POST /lesco/fetch  { ref, captchaCode, sessionId }
app.post('/lesco/fetch', async (req, res) => {
  const { ref, captchaCode, sessionId } = req.body;
  if (!ref) return res.status(400).json({ success: false, error: 'ref is required' });

  // Check cache first
  const hit = cache.get(ref);
  if (hit) return res.json({ success: true, data: { ...hit, cached: true } });

  try {
    const parts = splitRef(ref);
    let cookies = [];

    if (sessionId && sessions.has(sessionId)) {
      cookies = sessions.get(sessionId).cookies;
    }

    // Attempt 1: direct AccountStatus fetch (sometimes works without CAPTCHA)
    let billHtml = null;
    try {
      const directResp = await axios.get(
        `${LESCO_BASE}/Modules/CustomerBillN/AccountStatus.aspx?ref=${encodeURIComponent(ref)}`,
        {
          httpsAgent,
          timeout: TIMEOUT_MS,
          headers: { Cookie: cookieHeader(cookies), 'User-Agent': 'Mozilla/5.0' },
        }
      );
      if (directResp.data && directResp.data.toUpperCase().includes('AMOUNT PAYABLE')) {
        billHtml = directResp.data;
      }
    } catch (_) {
      // Expected to fail often — continue to CAPTCHA path
    }

    // Attempt 2: submit CAPTCHA then fetch
    if (!billHtml && captchaCode) {
      const captchaForm = new URLSearchParams({
        txtRefNo1: parts[0],
        txtRefNo2: parts[1],
        txtRefNo3: parts[2],
        txtRefNo4: parts[3],
        txtCaptcha: captchaCode,
        btnSubmit: 'Submit',
      });

      const captchaResp = await axios.post(
        `${LESCO_BASE}/Modules/CustomerBillN/CustomerMenu.asp`,
        captchaForm.toString(),
        {
          httpsAgent,
          timeout: TIMEOUT_MS,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookieHeader(cookies),
            'User-Agent': 'Mozilla/5.0',
          },
          maxRedirects: 5,
        }
      );

      // Merge any new cookies
      const newCookies = parseCookies(captchaResp.headers['set-cookie']);
      if (newCookies.length) cookies = [...cookies, ...newCookies];

      // Check if CAPTCHA submission itself shows the bill
      if (captchaResp.data && captchaResp.data.toUpperCase().includes('AMOUNT PAYABLE')) {
        billHtml = captchaResp.data;
      } else {
        // Fetch the account status page
        const statusResp = await axios.get(
          `${LESCO_BASE}/Modules/CustomerBillN/AccountStatus.aspx`,
          {
            httpsAgent,
            timeout: TIMEOUT_MS,
            headers: { Cookie: cookieHeader(cookies), 'User-Agent': 'Mozilla/5.0' },
            maxRedirects: 5,
          }
        );
        billHtml = statusResp.data;
      }

      // Wrong CAPTCHA check
      if (billHtml && (billHtml.toUpperCase().includes('INVALID CODE') || billHtml.toUpperCase().includes('WRONG CODE') || billHtml.toUpperCase().includes('CAPTCHA'))) {
        return res.status(422).json({ success: false, error: 'incorrect_captcha', message: 'Incorrect code — a new CAPTCHA has loaded. Try again.' });
      }
    }

    if (!billHtml) {
      return res.status(502).json({ success: false, error: 'no_data', message: "Couldn't retrieve bill data from LESCO. Try again or enter the amount manually." });
    }

    if (!billHtml.toUpperCase().includes('AMOUNT PAYABLE') && !billHtml.toUpperCase().includes('CUSTOMER NAME')) {
      // Page changed or wrong ref
      if (billHtml.toUpperCase().includes('NOT FOUND') || billHtml.toUpperCase().includes('INVALID REF')) {
        return res.status(404).json({ success: false, error: 'not_found', message: 'Reference number not found on LESCO. Double-check and try again.' });
      }
      return res.status(502).json({ success: false, error: 'parse_failed', message: "Couldn't read LESCO's response. The bill page may have changed — contact support." });
    }

    const $ = cheerio.load(billHtml);
    const parsed = parseLescoHtml($);

    const data = {
      ...parsed,
      fetchedAt: new Date().toISOString(),
      cached: false,
    };

    cache.set(ref, data);
    if (sessionId) sessions.delete(sessionId);

    res.json({ success: true, data });

  } catch (err) {
    const msg = classifyError(err);
    res.status(502).json({ success: false, error: 'fetch_error', message: msg });
  }
});

// ── Error classifier ──────────────────────────────────────────────────────────
function classifyError(err) {
  if (err.message && err.message.includes('parts separated by dashes')) return err.message;
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') return "LESCO's website is currently down. Try again later or enter the amount manually.";
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') return "LESCO's website is responding slowly. Try again or enter manually.";
  if (err.response && err.response.status === 404) return 'Reference number not found on LESCO. Double-check and try again.';
  return "LESCO's website is currently down. Try again later or enter the amount manually.";
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Finly Proxy running on port ${PORT}`));
