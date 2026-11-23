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
// v1.3.0 (Muse B's 3 ideas, tin #42/#43):
//   1) GitHub webhook → thread: POST /api/github-webhook (HMAC SHA-256)
//      đăng tin push/PR/issue/release vào mailbox, Martin thấy ngay trên
//      Telegram mà không cần ai tự check GitHub.
//   2) Watchdog tự phục hồi trên PC: deploy/watchdog.sh + systemd
//      timer giám sát bridge + cloudflared, tự restart khi chết, báo
//      Telegram khi không lên được; GET /status cho Martin xem.
//   3) Nhắc việc + digest định kỳ: mỗi sáng DIGEST_TIME tự đăng digest
//      các task đang mở (todo/doing) + nhắc task quá hạn chưa cập nhật;
//      POST /api/digest để kích hoạt ngay, GET /api/digest để xem trước.
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
const VERSION = '1.3.0';

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
const DIGEST_STATE_FILE = path.join(__dirname, 'digest-state.json');
const WATCHDOG_FILE = (() => {
  const raw = process.env.WATCHDOG_FILE || 'watchdog.json';
  return path.isAbsolute(raw) ? raw : path.join(__dirname, raw);
})();
// GitHub webhook (v1.3.0): secret để verify chữ ký HMAC; để trống = webhook
// tắt hẳn (fail closed — không nhận event không ký). Repos được phép, cách
// nhau bằng dấu phẩy, dạng owner/repo.
const GITHUB_WEBHOOK_SECRET = (process.env.GITHUB_WEBHOOK_SECRET || '').trim();
const GITHUB_WEBHOOK_REPOS = (process.env.GITHUB_WEBHOOK_REPOS
  || 'tuanxminhxgi/muse2muse,tuanxminhxgi/agent-tools')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Digest + nhắc việc (v1.3.0): giờ địa phương trên máy chạy bridge (PC Martin
// đang ở giờ VN). DIGEST_ENABLED=false để tắt hẳn.
const DIGEST_ENABLED = (process.env.DIGEST_ENABLED || 'true').toLowerCase() !== 'false';
const DIGEST_TIME = (process.env.DIGEST_TIME || '08:00').trim();
const DIGEST_REMINDER_HOURS = Number(process.env.DIGEST_REMINDER_HOURS || 24);
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const TELEGRAM_POLL_MS = Number(process.env.TELEGRAM_POLL_MS || 2000);
const SENDERS = ['muse-a', 'muse-b', 'muse-c', 'martin', 'user', 'telegram', 'github', 'bridge'];
// 'github' = tin tự động từ GitHub webhook; 'bridge' = digest/nhắc việc tự động.
// Hai sender này chỉ server tự dùng, không có trong form gửi tay trên board.
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

// ---------- Watchdog heartbeat (v1.3.0) ----------
// deploy/watchdog.sh (chạy bằng systemd timer trên PC Martin) ghi heartbeat
// vào WATCHDOG_FILE sau mỗi lần kiểm tra bridge + cloudflared. /status đọc
// file này để Martin biết lần kiểm tra cuối là khi nào và có phải restart
// gì không. File vắng mặt = watchdog chưa từng chạy.
function readWatchdogHeartbeat() {
  try {
    const raw = JSON.parse(fs.readFileSync(WATCHDOG_FILE, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch { /* no heartbeat yet, or unreadable — report as null */ }
  return null;
}

// ---------- GitHub webhook → thread (v1.3.0) ----------
// POST /api/github-webhook nhận event push / pull_request / issues / release
// từ GitHub. Chỉ nhận khi GITHUB_WEBHOOK_SECRET đã đặt và chữ ký
// x-hub-signature-256 khớp (HMAC SHA-256 trên raw body). Repo ngoài
// GITHUB_WEBHOOK_REPOS thì bỏ qua. Event ping chỉ trả 200, không đăng tin.
// GitHub gửi lại (retry) cùng 1 delivery id khi bridge lỗi — nhớ 200 id gần
// nhất để không đăng trùng.
const seenDeliveries = new Set();
function verifyGitHubSignature(rawBody, signature) {
  if (!GITHUB_WEBHOOK_SECRET || !signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET)
    .update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function formatGitHubEvent(event, payload) {
  const repo = payload.repository?.full_name || 'unknown repo';
  const sender = payload.sender?.login || 'unknown';
  if (event === 'push') {
    const branch = String(payload.ref || '').replace(/^refs\/heads\//, '');
    const commits = payload.commits || [];
    const first = commits[0]?.message?.split('\n')[0] || '';
    const extra = commits.length > 1 ? ` (+${commits.length - 1} commit nữa)` : '';
    return `[github] push ${repo}@${branch} — ${commits.length} commit bởi ${sender}: "${first}"${extra}${payload.compare ? `\n${payload.compare}` : ''}`;
  }
  if (event === 'pull_request') {
    const pr = payload.pull_request || {};
    const action = payload.action || '';
    const merged = action === 'closed' && pr.merged ? ' (đã merge)' : '';
    return `[github] PR #${pr.number} ${repo} — ${action}${merged}: "${pr.title}" bởi ${sender}\n${pr.html_url || ''}`;
  }
  if (event === 'issues') {
    const issue = payload.issue || {};
    return `[github] Issue #${issue.number} ${repo} — ${payload.action}: "${issue.title}" bởi ${sender}\n${issue.html_url || ''}`;
  }
  if (event === 'release') {
    const rel = payload.release || {};
    return `[github] Release ${repo} — ${payload.action}: ${rel.tag_name || ''} "${rel.name || ''}" bởi ${sender}\n${rel.html_url || ''}`;
  }
  return null; // event khác (fork, star...) thì bỏ qua, không đăng tin
}

async function handleGitHubWebhook(req, res) {
  if (!GITHUB_WEBHOOK_SECRET) return json(res, 503, { ok: false, error: 'github webhook not configured (set GITHUB_WEBHOOK_SECRET)' });
  const rawBody = await readBody(req);
  const signature = req.headers['x-hub-signature-256'] || '';
  if (!verifyGitHubSignature(rawBody, signature)) {
    return json(res, 401, { ok: false, error: 'bad github signature' });
  }
  const deliveryId = req.headers['x-github-delivery'] || '';
  if (deliveryId) {
    if (seenDeliveries.has(deliveryId)) return json(res, 200, { ok: true, ignored: 'duplicate delivery' });
    seenDeliveries.add(deliveryId);
    if (seenDeliveries.size > 200) seenDeliveries.clear();
  }
  const event = req.headers['x-github-event'] || '';
  if (event === 'ping') return json(res, 200, { ok: true, event: 'ping' });
  let payload = {};
  try { payload = JSON.parse(rawBody); } catch {
    return json(res, 400, { ok: false, error: 'invalid JSON payload' });
  }
  const repo = payload.repository?.full_name || '';
  if (repo && !GITHUB_WEBHOOK_REPOS.includes(repo)) {
    return json(res, 200, { ok: true, ignored: `repo not allowed: ${repo}` });
  }
  const text = formatGitHubEvent(event, payload);
  if (!text) return json(res, 200, { ok: true, ignored: `unsupported event: ${event}` });
  const msg = addMessage({ sender: 'github', text, source: 'github-webhook' });
  console.log(`[github] #${msg.id} ${event} ${repo}`);
  forwardToTelegram(msg);
  return json(res, 200, { ok: true, message: msg });
}

// ---------- Scheduled reminders + digest (v1.3.0) ----------
// Mỗi sáng lúc DIGEST_TIME (giờ địa phương của máy chạy bridge), server tự
// đăng 1 tin digest: các task đang mở (todo/doing) theo từng assignee, và
// nhắc riêng các task đã quá DIGEST_REMINDER_HOURS giờ chưa cập nhật. Ngày
// nào không có task mở thì không đăng (tránh spam). Ngày đã đăng được ghi
// vào digest-state.json để restart server cũng không đăng trùng.
let lastDigestDate = null;
try {
  lastDigestDate = JSON.parse(fs.readFileSync(DIGEST_STATE_FILE, 'utf8')).lastDigestDate || null;
} catch { /* first run: no state yet */ }

function localDayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function openTasks() {
  return messages.filter((m) => m.task && (m.task.status === 'todo' || m.task.status === 'doing'));
}

function buildDigestText() {
  const open = openTasks();
  if (open.length === 0) return null;
  const staleMs = DIGEST_REMINDER_HOURS * 3_600_000;
  const stale = open.filter((m) => Date.now() - new Date(m.ts).getTime() > staleMs);
  const byAssignee = {};
  for (const m of open) {
    const key = m.task.assignee || 'chưa giao';
    (byAssignee[key] = byAssignee[key] || []).push(m);
  }
  const lines = [`Digest ${localDayKey()} — ${open.length} task đang mở:`];
  for (const [assignee, list] of Object.entries(byAssignee)) {
    lines.push('', `${assignee} (${list.length}):`);
    for (const m of list) {
      lines.push(`  #${m.id} [${m.task.status}] ${m.sender}: ${String(m.text).split('\n')[0].slice(0, 80)}`);
    }
  }
  if (stale.length > 0) {
    lines.push('', `Nhắc: ${stale.length} task quá ${DIGEST_REMINDER_HOURS}h chưa cập nhật: ${stale.map((m) => `#${m.id}`).join(', ')}`);
  }
  return lines.join('\n');
}

function digestDueNow(now = new Date()) {
  if (!DIGEST_ENABLED) return false;
  const [hh, mm] = DIGEST_TIME.split(':').map((n) => Number(n) || 0);
  const target = new Date(now);
  target.setHours(hh, mm, 0, 0);
  return now >= target && lastDigestDate !== localDayKey(now);
}

// force=true: đăng ngay bất kể giờ (dùng cho POST /api/digest). Trả về
// {posted, reason?, message?} để route quyết định status code.
function triggerDigest(force = false) {
  if (!force && !digestDueNow()) return { posted: false, reason: 'not due yet' };
  const text = buildDigestText();
  if (!text) return { posted: false, reason: 'no open tasks' };
  const msg = addMessage({ sender: 'bridge', text, source: 'digest' });
  lastDigestDate = localDayKey();
  try { fs.writeFileSync(DIGEST_STATE_FILE, JSON.stringify({ lastDigestDate }) + '\n'); } catch (e) {
    console.error('[digest] could not save state:', e.message);
  }
  console.log(`[digest] #${msg.id} posted (${openTasks().length} open tasks)`);
  forwardToTelegram(msg);
  return { posted: true, message: msg };
}

function checkDigestDue() {
  try {
    const r = triggerDigest(false);
    if (r.posted) console.log('[digest] morning digest posted');
  } catch (e) {
    console.error('[digest] error:', e.message);
  }
}

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
<p style="color:#888;font-size:12px">API: GET /api/messages?since=&lt;id&gt;&amp;token=... · POST /api/msg {"sender","text","token"} · GET /api/tasks?token=... · GET /api/events?token=... (SSE live) · GET /status · GET /api/digest?token=... · POST /api/github-webhook</p>
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
      githubWebhook: Boolean(GITHUB_WEBHOOK_SECRET),
      digest: { enabled: DIGEST_ENABLED, time: DIGEST_TIME, lastDigestDate, openTasks: openTasks().length },
      watchdog: readWatchdogHeartbeat(),
    });
  }

  // Public status page (v1.3.0): Martin xem bridge + tunnel đang sống hay
  // chết mà không cần token. Không lộ token hay nội dung thread.
  if (p === '/status' && req.method === 'GET') {
    const wd = readWatchdogHeartbeat();
    const wdRows = wd
      ? `<tr><td>Watchdog kiểm tra cuối</td><td>${esc(wd.checkedAt || '—')}</td></tr>
      <tr><td>Bridge (theo watchdog)</td><td>${wd.bridgeOk ? 'đang chạy' : 'CHẾT / không phản hồi'}</td></tr>
      <tr><td>Cloudflared (theo watchdog)</td><td>${wd.cloudflaredOk ? 'đang chạy' : 'CHẾT / không phản hồi'}</td></tr>
      <tr><td>Watchdog đã restart</td><td>${esc(String(wd.restarts ?? 0))} lần</td></tr>
      <tr><td>Cảnh báo Telegram cuối</td><td>${esc(wd.lastAlertAt || 'chưa có')}</td></tr>`
      : `<tr><td>Watchdog</td><td>chưa chạy lần nào (xem deploy/watchdog.sh)</td></tr>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8">
<title>Muse Bridge — Status</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px">
<h1>Muse Bridge — Status</h1>
<table border="1" cellpadding="6" cellspacing="0">
<tr><td>Version</td><td>${esc(VERSION)}</td></tr>
<tr><td>Đang chạy từ</td><td>${esc(startedAt)} (uptime ${Math.round(process.uptime())}s)</td></tr>
<tr><td>Tin nhắn</td><td>${messages.length} (task đang mở: ${openTasks().length})</td></tr>
<tr><td>Telegram</td><td>${telegramEnabled ? 'BẬT' : 'TẮT'}</td></tr>
<tr><td>Telegram poll cuối</td><td>${esc(lastTelegramPollAt || 'chưa poll')}</td></tr>
<tr><td>Lỗi Telegram cuối</td><td>${esc(lastTelegramError || 'không có')}</td></tr>
<tr><td>Outbox chờ gửi lại</td><td>${outbox.length}</td></tr>
<tr><td>GitHub webhook</td><td>${GITHUB_WEBHOOK_SECRET ? 'BẬT' : 'TẮT (chưa đặt GITHUB_WEBHOOK_SECRET)'}</td></tr>
<tr><td>Digest sáng</td><td>${DIGEST_ENABLED ? `BẬT — ${esc(DIGEST_TIME)} (đã đăng gần nhất: ${esc(lastDigestDate || 'chưa')})` : 'TẮT'}</td></tr>
${wdRows}
</table>
<p style="color:#888;font-size:12px">JSON: <a href="/api/status">/api/status</a> · Health: <a href="/health">/health</a></p>
</body></html>`);
  }

  if (p === '/api/status' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      version: VERSION,
      startedAt,
      uptime_s: Math.round(process.uptime()),
      messages: messages.length,
      openTasks: openTasks().length,
      telegram: telegramEnabled,
      lastTelegramPollAt,
      lastTelegramError,
      outbox: outbox.length,
      sseClients: sseClients.size,
      githubWebhook: Boolean(GITHUB_WEBHOOK_SECRET),
      digest: { enabled: DIGEST_ENABLED, time: DIGEST_TIME, lastDigestDate },
      watchdog: readWatchdogHeartbeat(),
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

  // Digest preview (v1.3.0): GET /api/digest?token=... — xem trước nội dung
  // digest sẽ đăng, không đăng thật.
  if (p === '/api/digest' && req.method === 'GET') {
    if (!requireToken()) return;
    const text = buildDigestText();
    return json(res, 200, { ok: true, due: digestDueNow(), openTasks: openTasks().length, text });
  }

  // Trigger digest ngay (v1.3.0): POST /api/digest {"token"} — đăng digest
  // bất kể giờ, để Martin hoặc Muse kích hoạt thủ công khi cần.
  if (p === '/api/digest' && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { ok: false, error: 'rate limited' });
    let data = {};
    try { data = JSON.parse(await readBody(req)); } catch {}
    if (data.token !== BRIDGE_TOKEN) {
      if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
      return json(res, 401, { ok: false, error: 'bad token' });
    }
    if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
    const r = triggerDigest(true);
    if (!r.posted) return json(res, 200, { ok: true, posted: false, reason: r.reason });
    return json(res, 200, { ok: true, posted: true, message: r.message });
  }

  // GitHub webhook (v1.3.0): POST /api/github-webhook — xem
  // handleGitHubWebhook ở trên. Không dùng token của board, dùng chữ ký
  // HMAC với GITHUB_WEBHOOK_SECRET.
  if (p === '/api/github-webhook' && req.method === 'POST') {
    return handleGitHubWebhook(req, res);
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
  console.log(`Health: http://${HOST}:${PORT}/health`);
  console.log(`Status: http://${HOST}:${PORT}/status`);
  console.log(`GitHub webhook: ${GITHUB_WEBHOOK_SECRET ? `BẬT — POST /api/github-webhook (repos: ${GITHUB_WEBHOOK_REPOS.join(', ')})` : 'TẮT — chưa đặt GITHUB_WEBHOOK_SECRET'}`);
  console.log(`Digest sáng: ${DIGEST_ENABLED ? `BẬT — ${DIGEST_TIME} giờ địa phương` : 'TẮT'}`);
  if (telegramEnabled) pollTelegram();
  // Digest định kỳ: kiểm tra mỗi phút, đăng khi tới giờ (xem checkDigestDue).
  setInterval(checkDigestDue, 60_000);
  checkDigestDue();
});
