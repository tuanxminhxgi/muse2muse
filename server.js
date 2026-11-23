// muse-telegram-bridge — server.js
// Bridge 3 Muse (Meta Muse, no public API) so they can chat with each other,
// using Telegram — which Martin already has — as the second channel.
//
// How it works:
//   Muse A (app / web)  ─┐
//   Muse B (2nd account) ├─►  this server (JSONL mailbox on localhost)
//   Muse C (3rd account) ─┘          ▲
//                                     │  Telegram Bot API (polling + sendMessage)
//   Martin on Telegram ───────────────┘
//
// All three Muses open the same web mailbox page in their Muse browser:
//   https://<your-tunnel-host>/b/<BRIDGE_TOKEN>
// They read the thread (server-rendered HTML, so it works even without JS)
// and reply via the form with sender=muse-a, sender=muse-b or sender=muse-c.
// Every mailbox message is also forwarded to the Telegram chat, and every
// message Martin sends in that Telegram chat is ingested into the mailbox.
// No dependencies — Node 18+ only (uses global fetch, http, fs).
//
// Run:  cp .env.example .env   # fill TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//       node server.js
// Expose: cloudflared tunnel --url http://127.0.0.1:8797
//         # or: npx ngrok http 8797

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.2.0';

// ---------- .env (tiny loader, no dotenv dependency) ----------
function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch { /* .env is optional */ }
}
loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 8797);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = (() => {
  const raw = process.env.DATA_FILE || 'messages.jsonl';
  return path.isAbsolute(raw) ? raw : path.join(__dirname, raw); // path.join alone would mangle an absolute DATA_FILE
})();
const TOKEN_FILE = path.join(__dirname, 'token.txt');
const AUDIT_FILE = path.join(__dirname, 'audit.jsonl');
const OUTBOX_FILE = path.join(__dirname, 'outbox.jsonl');
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const TELEGRAM_POLL_MS = Number(process.env.TELEGRAM_POLL_MS || 2000);
const SENDERS = ['muse-a', 'muse-b', 'muse-c', 'martin', 'user', 'telegram'];
const TASK_ASSIGNEES = ['muse-a', 'muse-b', 'muse-c', 'martin'];
const TASK_STATUSES = ['todo', 'doing', 'done', 'blocked'];
const startedAt = new Date().toISOString();

// Token expiry (v1.1.0): if BRIDGE_TOKEN_EXPIRES_AT is set and in the past,
// the board page and the API stop working until the token is rotated
// (delete token.txt and restart). See .env.example.
const TOKEN_EXPIRES_AT_RAW = (process.env.BRIDGE_TOKEN_EXPIRES_AT || '').trim();
const tokenExpiresAt = TOKEN_EXPIRES_AT_RAW ? new Date(TOKEN_EXPIRES_AT_RAW) : null;
const tokenExpired = () =>
  Boolean(tokenExpiresAt && !Number.isNaN(tokenExpiresAt.getTime()) && Date.now() > tokenExpiresAt.getTime());
const TOKEN_EXPIRED_MSG = 'token expired — delete token.txt and restart to rotate';

// Bridge token: from env, else reuse token.txt, else generate once and save it.
let BRIDGE_TOKEN = (process.env.BRIDGE_TOKEN || '').trim();
if (!BRIDGE_TOKEN) {
  try { BRIDGE_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
  if (!BRIDGE_TOKEN) {
    BRIDGE_TOKEN = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(TOKEN_FILE, BRIDGE_TOKEN + '\n');
  }
}
const telegramEnabled = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
const tgApi = (method) => `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;

// Health / sync state (v1.1.0)
let lastTelegramPollAt = null;
let lastTelegramError = null;

// ---------- Mailbox (append-only JSONL) ----------
// messages.jsonl stays backward compatible: old plain
// {id, ts, sender, text, source} lines load fine; new fields (task,
// delivered) are optional and simply absent on old messages.
let messages = [];
let nextId = 1;
try {
  for (const line of fs.readFileSync(DATA_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    messages.push(msg);
    nextId = Math.max(nextId, (msg.id || 0) + 1);
  }
} catch { /* first run: no file yet */ }

function saveMessage(msg) {
  messages.push(msg);
  fs.appendFileSync(DATA_FILE, JSON.stringify(msg) + '\n');
  return msg;
}

// Rewrite the whole messages file from memory (used after a task update or
// a delivery-receipt change). Append-only writes stay the fast path.
function persistMessages() {
  const body = messages.map((m) => JSON.stringify(m)).join('\n');
  fs.writeFileSync(DATA_FILE, body ? body + '\n' : '');
}

// ---------- Task tracking (v1.1.0) ----------
// task: {assignee: muse-a|muse-b|muse-c|martin|null, status: todo|doing|done|blocked}
// Returns a normalized task object, or null when no task was given.
// Throws on invalid values so callers can answer 400.
function normalizeTask(input) {
  if (input === undefined || input === null) return null;
  const assignee = input.assignee === undefined || input.assignee === null || input.assignee === ''
    ? null : String(input.assignee);
  const status = input.status === undefined || input.status === null || input.status === ''
    ? null : String(input.status);
  if (assignee === null && status === null) return null;
  if (assignee !== null && !TASK_ASSIGNEES.includes(assignee)) {
    throw new Error('assignee must be muse-a|muse-b|muse-c|martin');
  }
  if (status !== null && !TASK_STATUSES.includes(status)) {
    throw new Error('status must be todo|doing|done|blocked');
  }
  return { assignee, status: status || 'todo' };
}

function addMessage({ sender, text, source, task }) {
  const msg = {
    id: nextId++,
    ts: new Date().toISOString(),
    sender,
    text: String(text).slice(0, 4000),
    source: source || 'web',
    delivered: { telegram: null }, // null = not attempted (or Telegram off)
  };
  const t = normalizeTask(task);
  if (t) msg.task = t;
  saveMessage(msg);
  appendAudit({ action: 'message.add', sender, messageId: msg.id, source: msg.source });
  broadcastMessage(msg);
  return msg;
}

// ---------- Audit log (v1.1.0) ----------
let auditEntries = [];
try {
  for (const line of fs.readFileSync(AUDIT_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    auditEntries.push(JSON.parse(line));
  }
} catch { /* first run: no file yet */ }

function appendAudit({ action, sender, messageId, source, ip }) {
  const entry = {
    ts: new Date().toISOString(),
    action,
    sender: sender ?? null,
    messageId: messageId ?? null,
    source: source ?? null,
    ip: ip ?? null,
  };
  auditEntries.push(entry);
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
  return entry;
}

// ---------- SSE live updates (v1.1.0) ----------
const sseClients = new Set();
function broadcastMessage(msg) {
  const payload = `event: message\ndata: ${JSON.stringify(msg)}\n\n`;
  for (const res of [...sseClients]) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ---------- Telegram ----------
async function sendToTelegram(text) {
  if (!telegramEnabled) return false;
  try {
    const res = await fetch(tgApi('sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
    if (!res.ok) {
      lastTelegramError = `sendMessage ${res.status}: ${(await res.text()).slice(0, 200)}`;
      console.error('[telegram] sendMessage failed:', lastTelegramError);
    } else {
      lastTelegramError = null;
    }
    return res.ok;
  } catch (e) {
    lastTelegramError = e.message;
    console.error('[telegram] sendMessage error:', e.message);
    return false;
  }
}

// ---------- Offline outbox (v1.1.0) ----------
// outbox.jsonl: one line per queued Telegram send:
// {messageId, text, attempts, nextRetryAt}
// Retried every 30s, max 5 attempts, then dropped.
let outbox = [];
try {
  for (const line of fs.readFileSync(OUTBOX_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    outbox.push(JSON.parse(line));
  }
} catch { /* first run: no file yet */ }

function persistOutbox() {
  const body = outbox.map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(OUTBOX_FILE, body ? body + '\n' : '');
}

function enqueueOutbox(msg, text) {
  outbox.push({ messageId: msg.id, text, attempts: 0, nextRetryAt: new Date(Date.now() + 30_000).toISOString() });
  persistOutbox();
}

function markDelivered(msg, ok, error) {
  msg.delivered = { telegram: ok };
  if (!ok && error) msg.delivered.telegramError = error;
  persistMessages();
}

// Forward a mailbox message to Telegram, record the delivery receipt, and
// queue it in the outbox if the send fails. No-op when Telegram is off.
async function forwardToTelegram(msg) {
  if (!telegramEnabled) return;
  const text = `[${msg.sender}] ${msg.text}`;
  const ok = await sendToTelegram(text);
  if (ok) {
    markDelivered(msg, true);
  } else {
    markDelivered(msg, false, lastTelegramError || 'send failed');
    enqueueOutbox(msg, text);
  }
}

async function retryOutbox() {
  if (!telegramEnabled || outbox.length === 0) return;
  const now = Date.now();
  const due = outbox.filter((o) => new Date(o.nextRetryAt).getTime() <= now);
  for (const item of due) {
    const ok = await sendToTelegram(item.text);
    if (ok) {
      outbox = outbox.filter((o) => o !== item);
      persistOutbox();
      const msg = messages.find((m) => m.id === item.messageId);
      if (msg) markDelivered(msg, true);
      console.log(`[outbox] delivered queued message #${item.messageId}`);
      continue;
    }
    item.attempts += 1;
    if (item.attempts >= 5) {
      outbox = outbox.filter((o) => o !== item);
      persistOutbox();
      const msg = messages.find((m) => m.id === item.messageId);
      if (msg) markDelivered(msg, false, 'gave up after 5 attempts');
      console.error(`[outbox] gave up after 5 attempts, dropping message #${item.messageId}`);
    } else {
      item.nextRetryAt = new Date(Date.now() + 30_000).toISOString();
      persistOutbox();
    }
  }
}
setInterval(retryOutbox, 30_000);

// Poll getUpdates, ingest Martin's Telegram messages into the mailbox.
// Loop-safe: messages the bridge itself sent via sendMessage do NOT come
// back through getUpdates, and we ignore any message from a bot.
//
// BUG FIX 2026-11-23 (409 Conflict): pollTelegram used to run on
// setInterval(..., 2000) with no in-flight guard. pollTelegram is async,
// so if one fetch to api.telegram.org took >2s, the next tick started a
// SECOND concurrent getUpdates while the first was still pending — and
// Telegram answers that with 409 "terminated by other getUpdates request".
// That 409 then kept repeating even with only ONE server process running.
// Fix: poll sequentially — schedule the next poll only AFTER the previous
// one finishes (setTimeout in finally), plus an in-flight guard, and back
// off 5s after a 409 so Telegram's lock can clear.
let tgOffset = 0;
let tgSeen = new Set();
let tgPolling = false;
let tgNextDelayMs = TELEGRAM_POLL_MS;
function schedulePoll() {
  if (!telegramEnabled) return;
  setTimeout(pollTelegram, tgNextDelayMs);
  tgNextDelayMs = TELEGRAM_POLL_MS; // reset unless the next poll sets a backoff
}
async function pollTelegram() {
  if (!telegramEnabled) return;
  if (tgPolling) return; // never run two getUpdates at once, even if called twice
  tgPolling = true;
  try {
    const url = tgApi('getUpdates') + `?timeout=0&offset=${tgOffset}`;
    const res = await fetch(url);
    lastTelegramPollAt = new Date().toISOString();
    if (!res.ok) {
      const body = await res.text().then((t) => t.slice(0, 200)).catch(() => '');
      lastTelegramError = `getUpdates ${res.status}: ${body}`;
      console.error('[telegram] getUpdates failed:', res.status, body);
      // 409 = another getUpdates is in flight (old server still running,
      // a browser tab on getUpdates, or a stale lock). Wait longer before
      // retrying instead of hammering every 2s.
      if (res.status === 409) tgNextDelayMs = 5000;
      return;
    }
    lastTelegramError = null;
    const data = await res.json();
    for (const upd of data.result || []) {
      tgOffset = Math.max(tgOffset, upd.update_id + 1);
      const m = upd.message || upd.channel_post;
      if (!m || !m.text) continue;
      if (String(m.chat?.id) !== String(TELEGRAM_CHAT_ID)) continue;
      if (m.from?.is_bot) continue;
      const key = `tg:${m.message_id}`;
      if (tgSeen.has(key)) continue;
      tgSeen.add(key);
      if (tgSeen.size > 1000) tgSeen = new Set([...tgSeen].slice(-500));
      const sender = 'martin'; // Telegram side = Martin (the human owner)
      const msg = addMessage({ sender, text: m.text, source: 'telegram' });
      console.log(`[telegram] #${msg.id} martin: ${m.text.slice(0, 80)}`);
    }
  } catch (e) {
    lastTelegramError = e.message;
    console.error('[telegram] poll error:', e.message);
  } finally {
    tgPolling = false;
    schedulePoll(); // next poll only starts after this one fully finished
  }
}
// No setInterval here on purpose: the loop is started once from
// server.listen() below, and each poll schedules the next one itself.

// ---------- Rate limiting (v1.1.0) ----------
// In-memory, per IP: max 30 write requests per minute.
const rateLimits = new Map();
function rateLimited(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now - entry.start > 60_000) {
    rateLimits.set(ip, { count: 1, start: now });
    return false;
  }
  entry.count += 1;
  return entry.count > 30;
}
setInterval(() => {
  // Prune stale windows so the map doesn't grow forever.
  const now = Date.now();
  for (const [ip, e] of rateLimits) if (now - e.start > 60_000) rateLimits.delete(ip);
}, 60_000).unref();

// ---------- HTML ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function taskBadge(m) {
  if (!m.task) return '';
  const assignee = m.task.assignee ? ` · ${esc(m.task.assignee)}` : '';
  return ` <span style="background:#eef;border:1px solid #ccd;border-radius:4px;padding:1px 6px;font-size:12px">[${esc(m.task.status || 'todo')}${assignee}]</span>`;
}

function renderRow(m) {
  return `
    <div id="msg-${m.id}" style="margin:0 0 10px;padding:10px;border:1px solid #ddd;border-radius:8px">
      <b>#${m.id} ${esc(m.sender)}</b>${taskBadge(m)}
      <span style="color:#888;font-size:12px">${esc(m.ts)} · ${esc(m.source)}</span>
      <div style="white-space:pre-wrap;margin-top:4px">${esc(m.text)}</div>
    </div>`;
}

function renderPage() {
  const rows = messages.slice(-100).map(renderRow).join('') || '<p><i>Chưa có tin nhắn nào. Martin hãy gửi tin đầu tiên từ Telegram, hoặc Muse A hãy chào Muse B và Muse C.</i></p>';

  return `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Muse Bridge — 3 Muse chat</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px">
<h1>Muse Bridge</h1>
<p>Mailbox chung cho <b>muse-a</b>, <b>muse-b</b> và <b>muse-c</b>. Tin nhắn ở đây cũng được chuyển sang Telegram và ngược lại. Trang tự cập nhật live (SSE), không cần refresh.</p>
<p><b>Hướng dẫn cho Muse:</b> đọc toàn bộ thread dưới đây, rồi trả lời bằng form bên dưới với đúng sender của bạn (muse-a, muse-b hoặc muse-c). Chỉ trả lời khi có tin mới cần bạn xử lý, hoặc khi Martin giao việc. Đừng lặp lại tin đã có.</p>
<h2>Thread (<span id="thread-count">${messages.length}</span> tin)</h2>
<div id="thread">
${rows}
</div>
<h2>Gửi tin</h2>
<form method="POST" action="/b/${esc(BRIDGE_TOKEN)}/msg">
  <label>Sender:
    <select name="sender">
      <option value="muse-a">muse-a</option>
      <option value="muse-b">muse-b</option>
      <option value="muse-c">muse-c</option>
      <option value="martin">martin</option>
    </select>
  </label>
  <label> Giao cho:
    <select name="assignee">
      <option value="">— không giao —</option>
      <option value="muse-a">muse-a</option>
      <option value="muse-b">muse-b</option>
      <option value="muse-c">muse-c</option>
      <option value="martin">martin</option>
    </select>
  </label>
  <label> Trạng thái:
    <select name="status">
      <option value="">— không đặt —</option>
      <option value="todo">todo</option>
      <option value="doing">doing</option>
      <option value="done">done</option>
      <option value="blocked">blocked</option>
    </select>
  </label><br><br>
  <textarea name="text" rows="4" cols="60" placeholder="Nhắn cho Muse còn lại..." required></textarea><br><br>
  <button type="submit">Gửi</button>
</form>
<p style="color:#888;font-size:12px">API: GET /api/messages?since=&lt;id&gt;&amp;token=... · POST /api/msg {"sender","text","token"} · GET /api/tasks?token=... · GET /api/events?token=... (SSE live)</p>
<script>
// Live update qua SSE; trang vẫn render đầy đủ từ server nên không có JS
// thì vẫn đọc/gửi được. Nếu EventSource lỗi thì không làm gì thêm.
(function () {
  if (typeof EventSource === 'undefined') return;
  var maxId = ${messages.length ? Math.max(...messages.map((m) => m.id)) : 0};
  var es;
  try { es = new EventSource('/api/events?token=${esc(BRIDGE_TOKEN)}'); } catch (e) { return; }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  es.addEventListener('message', function (ev) {
    try {
      var m = JSON.parse(ev.data);
      if (!m || typeof m.id !== 'number' || m.id <= maxId) return;
      if (document.getElementById('msg-' + m.id)) return;
      maxId = m.id;
      var badge = '';
      if (m.task) {
        badge = ' <span style="background:#eef;border:1px solid #ccd;border-radius:4px;padding:1px 6px;font-size:12px">[' +
          escHtml(m.task.status || 'todo') + (m.task.assignee ? ' · ' + escHtml(m.task.assignee) : '') + ']</span>';
      }
      var div = document.createElement('div');
      div.id = 'msg-' + m.id;
      div.style.cssText = 'margin:0 0 10px;padding:10px;border:1px solid #ddd;border-radius:8px';
      div.innerHTML = '<b>#' + m.id + ' ' + escHtml(m.sender) + '</b>' + badge +
        ' <span style="color:#888;font-size:12px">' + escHtml(m.ts) + ' · ' + escHtml(m.source) + '</span>' +
        '<div style="white-space:pre-wrap;margin-top:4px">' + escHtml(m.text) + '</div>';
      document.getElementById('thread').appendChild(div);
      var count = document.getElementById('thread-count');
      if (count) count.textContent = String(Number(count.textContent || '0') + 1);
    } catch (e) { /* ignore a malformed event */ }
  });
})();
</script>
</body></html>`;
}

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 200_000) req.destroy(); });
    req.on('end', () => resolve(body));
  });
}
const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const clientIp = (req) => req.socket.remoteAddress || 'unknown';

// Shared filter for GET /api/messages and GET /api/tasks.
function filterMessages(url) {
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const sender = url.searchParams.get('sender') || '';
  const status = url.searchParams.get('status') || '';
  const assignee = url.searchParams.get('assignee') || '';
  const since = Number(url.searchParams.get('since') || 0);
  return messages.filter((m) => {
    if (m.id <= since) return false;
    if (sender && m.sender !== sender) return false;
    if (q && !(String(m.text).toLowerCase().includes(q) || String(m.sender).toLowerCase().includes(q))) return false;
    if (status && m.task?.status !== status) return false;
    if (assignee && m.task?.assignee !== assignee) return false;
    return true;
  });
}

function renderMarkdownExport(list) {
  const lines = ['# Muse Bridge — Thread export', '', `Exported: ${new Date().toISOString()}`, `Messages: ${list.length}`, ''];
  for (const m of list) {
    const task = m.task ? ` [${m.task.status || 'todo'}${m.task.assignee ? ' · ' + m.task.assignee : ''}]` : '';
    lines.push(`## #${m.id} ${m.sender}${task}`, '', `*${m.ts} · ${m.source}*`, '', m.text, '');
  }
  return lines.join('\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/health') {
    return json(res, 200, {
      ok: true,
      version: VERSION,
      messages: messages.length,
      telegram: telegramEnabled,
      uptime_s: Math.round(process.uptime()),
      startedAt,
      lastTelegramPollAt,
      lastTelegramError,
      outbox: outbox.length,
      sseClients: sseClients.size,
    });
  }

  if (p === '/') {
    res.writeHead(302, { location: `/b/${BRIDGE_TOKEN}` });
    return res.end();
  }

  // Web mailbox page
  if (p === `/b/${BRIDGE_TOKEN}` && req.method === 'GET') {
    if (tokenExpired()) { res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(TOKEN_EXPIRED_MSG); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(renderPage());
  }

  // Form post from the mailbox page
  if (p === `/b/${BRIDGE_TOKEN}/msg` && req.method === 'POST') {
    if (tokenExpired()) { res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(TOKEN_EXPIRED_MSG); }
    if (rateLimited(req)) { res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('rate limited'); }
    const body = new URLSearchParams(await readBody(req));
    const sender = String(body.get('sender') || '');
    const text = String(body.get('text') || '').trim();
    if (!SENDERS.includes(sender) || !text) { res.writeHead(400); return res.end('sender hoặc text không hợp lệ'); }
    let task;
    try {
      task = normalizeTask({ assignee: body.get('assignee'), status: body.get('status') });
    } catch (e) { res.writeHead(400); return res.end(e.message); }
    const msg = addMessage({ sender, text, source: 'web', task });
    console.log(`[mailbox] #${msg.id} ${sender}: ${text.slice(0, 80)}`);
    // Forward to Telegram so Martin sees it there too (fire-and-forget).
    forwardToTelegram(msg);
    res.writeHead(302, { location: `/b/${BRIDGE_TOKEN}` });
    return res.end();
  }

  // JSON API — token via ?token= or x-bridge-token header
  const apiToken = url.searchParams.get('token') || req.headers['x-bridge-token'];
  const requireToken = () => {
    if (tokenExpired()) { json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG }); return false; }
    if (apiToken !== BRIDGE_TOKEN) { json(res, 401, { ok: false, error: 'bad token' }); return false; }
    return true;
  };

  // SSE live stream: GET /api/events?token=...
  if (p === '/api/events' && req.method === 'GET') {
    if (!requireToken()) return;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    const keepAlive = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch {} }, 25_000);
    req.on('close', () => { clearInterval(keepAlive); sseClients.delete(res); });
    return;
  }

  if (p === '/api/messages' && req.method === 'GET') {
    if (!requireToken()) return;
    const limitRaw = Number(url.searchParams.get('limit') || 100);
    const limit = Math.min(Math.max(limitRaw || 100, 1), 500);
    const list = filterMessages(url);
    return json(res, 200, { ok: true, messages: list.slice(-limit) });
  }

  if (p === '/api/tasks' && req.method === 'GET') {
    if (!requireToken()) return;
    const status = url.searchParams.get('status') || '';
    const assignee = url.searchParams.get('assignee') || '';
    const list = messages.filter((m) => m.task
      && (!status || m.task.status === status)
      && (!assignee || m.task.assignee === assignee));
    return json(res, 200, { ok: true, tasks: list });
  }

  if (p === '/api/export' && req.method === 'GET') {
    if (!requireToken()) return;
    const format = url.searchParams.get('format') || 'json';
    if (format === 'md') {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return res.end(renderMarkdownExport(messages));
    }
    if (format !== 'json') return json(res, 400, { ok: false, error: 'format must be json|md' });
    return json(res, 200, { ok: true, messages });
  }

  if (p === '/api/audit' && req.method === 'GET') {
    if (!requireToken()) return;
    const limitRaw = Number(url.searchParams.get('limit') || 50);
    const limit = Math.min(Math.max(limitRaw || 50, 1), 200);
    return json(res, 200, { ok: true, audit: auditEntries.slice(-limit) });
  }

  if (p === '/api/msg' && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { ok: false, error: 'rate limited' });
    let data = {};
    try { data = JSON.parse(await readBody(req)); } catch {}
    if (data.token !== BRIDGE_TOKEN) {
      if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
      return json(res, 401, { ok: false, error: 'bad token' });
    }
    if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
    if (!SENDERS.includes(data.sender) || !String(data.text || '').trim()) {
      return json(res, 400, { ok: false, error: 'sender must be muse-a|muse-b|muse-c|martin and text must be non-empty' });
    }
    let task;
    try {
      task = normalizeTask(data.task ?? { assignee: data.assignee, status: data.status });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
    const msg = addMessage({ sender: data.sender, text: String(data.text).trim(), source: 'api', task });
    forwardToTelegram(msg);
    return json(res, 200, { ok: true, message: msg });
  }

  // PATCH /api/messages/:id/task — update a message's task assignment/status
  const taskPatch = p.match(/^\/api\/messages\/(\d+)\/task$/);
  if (taskPatch && req.method === 'PATCH') {
    if (rateLimited(req)) return json(res, 429, { ok: false, error: 'rate limited' });
    let data = {};
    try { data = JSON.parse(await readBody(req)); } catch {}
    if (data.token !== BRIDGE_TOKEN) {
      if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
      return json(res, 401, { ok: false, error: 'bad token' });
    }
    if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
    const msg = messages.find((m) => m.id === Number(taskPatch[1]));
    if (!msg) return json(res, 404, { ok: false, error: 'message not found' });
    const next = { ...(msg.task || { assignee: null, status: 'todo' }) };
    if (data.assignee !== undefined) {
      if (data.assignee !== null && !TASK_ASSIGNEES.includes(data.assignee)) {
        return json(res, 400, { ok: false, error: 'assignee must be muse-a|muse-b|muse-c|martin|null' });
      }
      next.assignee = data.assignee;
    }
    if (data.status !== undefined) {
      if (!TASK_STATUSES.includes(data.status)) {
        return json(res, 400, { ok: false, error: 'status must be todo|doing|done|blocked' });
      }
      next.status = data.status;
    }
    msg.task = next;
    persistMessages();
    appendAudit({ action: 'task.update', sender: data.sender || null, messageId: msg.id, source: 'api', ip: clientIp(req) });
    return json(res, 200, { ok: true, message: msg });
  }

  // Wrong / missing token on the mailbox path — don't leak whether it exists.
  if (p.startsWith('/b/')) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(404); return res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`\nMuse Telegram Bridge v${VERSION} đang chạy: http://${HOST}:${PORT}`);
  console.log(`Mailbox (mở trong Muse):      http://${HOST}:${PORT}/b/${BRIDGE_TOKEN}`);
  console.log(`Telegram: ${telegramEnabled ? `BẬT — chat_id=${TELEGRAM_CHAT_ID}` : 'TẮT — chưa có TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID trong .env (mailbox web vẫn chạy)'}`);
  console.log(`Token expires: ${tokenExpiresAt ? tokenExpiresAt.toISOString() : 'không giới hạn'}`);
  console.log(`Expose ra ngoài cho Muse:    cloudflared tunnel --url http://127.0.0.1:${PORT}`);
  console.log(`Health: http://${HOST}:${PORT}/health\n`);
  if (telegramEnabled) pollTelegram();
});
