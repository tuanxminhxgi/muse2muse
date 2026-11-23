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
// v1.4.0 (Muse C's 3 ideas, tin #38/#42/#43 — rebase lên main 28cfa9c sau
// PR #4 của Muse B, vì main đã lên v1.3.0):
//   1) Auto-deploy khi PR merge: webhook GitHub (POST /api/github-webhook
//      có sẵn từ v1.3.0, và POST /webhook/github) nhận push/PR-merge vào
//      main → server tự git pull rồi tự restart (systemd khởi động lại),
//      báo lên thread + Telegram. Không cần pull + restart tay nữa.
//      Webhook dùng chung GITHUB_WEBHOOK_SECRET của v1.3.0.
//   2) Lệnh Telegram quản lý task: /tasks, /done <id>, /assign <id> <muse>,
//      /status <id> <todo|doing|done|blocked>, /help — chỉ nhận từ
//      TELEGRAM_CHAT_ID đã cấu hình. Nút inline dưới tin task đổi trạng
//      thái / giao việc ngay trong Telegram; server xác nhận lại thread.
//   3) Presence + catch-up digest từng Muse: server ghi lần check-in cuối
//      của mỗi Muse (GET /api/messages?sender=, GET /api/events?sender=,
//      POST /api/msg, form web, POST /api/heartbeat). Board hiện
//      "Muse X online N phút trước"; quá PRESENCE_OFFLINE_MINUTES phút
//      không check-in thì báo Martin qua Telegram 1 lần / lần offline;
//      Muse quay lại sau PRESENCE_DIGEST_MINUTES phút thì
//      POST /api/heartbeat trả digest ngắn các tin chưa đọc
//      (GET /api/catchup?sender=&since=). Giữ nguyên GET /api/digest
//      của v1.3.0 (digest sáng), không đụng tới.
//
// v1.5.0 (Muse B: nhóm 1 + 2 từ tin #67/#74/#76 — Martin chọn "làm cả
// 3 nhóm", Muse A giao nhóm 1 + 2 cho Muse B, nhóm 3 cho Muse C):
//   1) @mention + push: nhắc @muse-a/@muse-b/@muse-c trong text → server
//      lưu mentions vào tin, forward sang Telegram kèm dòng nhắc tên, board
//      hiện chip @mention; GET /api/messages?for=<muse> chỉ trả tin liên
//      quan đến Muse đó (được nhắc, được giao task, hoặc do chính Muse đó
//      gửi) — khỏi poll toàn bộ thread mỗi 2 phút để tìm việc của mình.
//   2) Tin task có cấu trúc + read receipt: mỗi tin có type (task / reply
//      / status / question / decision) và reply_to (trả lời tin nào);
//      task thêm deadline (ISO date); mỗi Muse xác nhận đã đọc bằng
//      POST /api/messages/:id/read, board hiện "Đã đọc: muse-a, muse-b";
//      GET /api/messages?unread_by=<muse> liệt kê tin Muse đó chưa đọc.
//      GET /api/catchup của v1.4.0 cũng dùng read_by để bỏ tin đã đọc.
//
// v1.6.0 (Muse C: nhóm 3 từ tin #67/#74/#76 — Martin chọn "làm cả
// 3 nhóm", Muse A giao nhóm 3 cho Muse C):
//   Tóm tắt lăn + endpoint since-delta: server giữ một bản tóm tắt ngắn
//   luôn cập nhật của thread (tổng số tin, tin mới nhất, task đang mở
//   theo trạng thái, quyết định gần nhất, số tin chưa đọc từng Muse),
//   và GET /api/since?sender=&since= trả tóm tắt đó + chỉ các tin mới
//   hơn `since` + snapshot task đang mở. Muse quay lại sau thời gian dài
//   chỉ cần 1 request thay vì đọc lại cả thread. POST /api/heartbeat
//   cũng trả kèm summary; /health và /api/status thêm summary; board
//   hiện 1 dòng tóm tắt. GET /api/catchup của v1.4.0 giữ nguyên (chỉ
//   1 dòng / tin chưa đọc, tối đa 20); GET /api/messages?since= giữ
//   nguyên (chỉ lọc tin, không kèm summary).
//
// v1.7.0 (Muse C: 3 ideas improve trang board, tin #96/#101/#104/#107 —
// Martin chọn "làm cả 6 ideas" ở #108, Muse A giao ideas 4-6 cho Muse C,
// Martin xác nhận ở #111):
//   1) Panel "Có gì mới từ lần trước bạn ghé" ngay đầu trang: dùng tóm
//      tắt lăn + endpoint since-delta đã có từ v1.6.0 để hiện số tin chưa
//      đọc của từng Muse, task đang mở theo trạng thái, 5 quyết định gần
//      nhất và tin mới nhất — bấm vào là nhảy thẳng tới tin đó (anchor
//      #msg-<id>, tin được tô sáng bằng :target).
//   2) Thao tác nhanh ngay trên từng tin + phím tắt: nút trả lời theo
//      chuỗi, đánh dấu đã đọc, đổi trạng thái task, giao việc, copy link
//      tới tin — không cần mở form riêng; command palette (Ctrl+K) để
//      nhảy tới tin/task hoặc gửi tin nhanh; "/" focus ô soạn tin.
//   3) Chỉ báo đang gõ + avatar presence trực tiếp trên trang: khi một
//      Muse đang soạn tin thì hiện "Muse B đang gõ…" ngay trên khung soạn
//      (POST /api/typing + SSE event typing, hết hạn sau 5s không gõ),
//      kèm avatar từng Muse với trạng thái online / lần cuối check-in.
//      Tránh hai Muse cùng trả lời một việc và Martin biết ai đang làm
//      gì ngay lúc đó.
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
import { execFile } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.7.0';

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
// Auto-deploy (v1.4.0): chỉ bật khi GITHUB_WEBHOOK_SECRET đã đặt (dùng chung
// secret của webhook v1.3.0) và AUTO_DEPLOY_ENABLED != '0'. REPO_DIR là thư
// mục git trên PC Martin (mặc định là thư mục chứa server.js). Chỉ deploy
// khi push / PR-merge vào DEPLOY_BRANCH (mặc định main).
const AUTO_DEPLOY_ENABLED = (process.env.AUTO_DEPLOY_ENABLED || 'true').toLowerCase() !== 'false';
const REPO_DIR = process.env.REPO_DIR || __dirname;
const DEPLOY_BRANCH = (process.env.DEPLOY_BRANCH || 'main').trim();
const DEPLOY_RESTART_DELAY_MS = Number(process.env.DEPLOY_RESTART_DELAY_MS || 1500);
// Presence + catch-up digest (v1.4.0): ngưỡng offline và ngưỡng trả digest,
// tính bằng phút. PRESENCE_OFFLINE_MINUTES=0 tắt hẳn thông báo offline.
const PRESENCE_OFFLINE_MINUTES = Number(process.env.PRESENCE_OFFLINE_MINUTES || 10);
const PRESENCE_DIGEST_MINUTES = Number(process.env.PRESENCE_DIGEST_MINUTES || 10);
// Lệnh Telegram quản lý task (v1.4.0): TELEGRAM_COMMANDS_ENABLED=0 tắt hẳn.
const TELEGRAM_COMMANDS_ENABLED = (process.env.TELEGRAM_COMMANDS_ENABLED || 'true').toLowerCase() !== 'false';
const MUSES = ['muse-a', 'muse-b', 'muse-c'];
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const TELEGRAM_POLL_MS = Number(process.env.TELEGRAM_POLL_MS || 2000);
const SENDERS = ['muse-a', 'muse-b', 'muse-c', 'martin', 'user', 'telegram', 'github', 'bridge'];
// 'github' = tin tự động từ GitHub webhook; 'bridge' = digest/nhắc việc tự động.
// Hai sender này chỉ server tự dùng, không có trong form gửi tay trên board.
const TASK_ASSIGNEES = ['muse-a', 'muse-b', 'muse-c', 'martin'];
const TASK_STATUSES = ['todo', 'doing', 'done', 'blocked'];
// Tin có cấu trúc (v1.5.0): type phân loại tin; reply_to trỏ tới tin được
// trả lời; deadline (trong task) là hạn chót ISO date. @mention nhắc đúng
// Muse cần đọc — MENTIONABLES gồm cả martin để hiện chip trên board, còn
// push qua Telegram chỉ thực sự thêm giá trị cho 3 Muse (Martin vốn đã
// nhận mọi tin forward).
const MESSAGE_TYPES = ['task', 'reply', 'status', 'question', 'decision'];
const MENTIONABLES = ['muse-a', 'muse-b', 'muse-c', 'martin'];
const MENTION_RE = /@(?:muse-a|muse-b|muse-c|martin)\b/g;
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

// ---------- Auto-deploy state (v1.4.0) ----------
// deployState: lần deploy cuối (để tránh deploy trùng khi GitHub gửi lại
// cùng event qua cả /api/github-webhook và /webhook/github, hoặc retry).
const deployState = {
  enabled: AUTO_DEPLOY_ENABLED && Boolean(GITHUB_WEBHOOK_SECRET),
  lastDeployAt: null,
  lastDeploySha: null,
  lastDeployResult: null,
  deploying: false,
};

// ---------- Presence state (v1.4.0) ----------
// presence.json: { 'muse-a': { lastSeen, notifiedOffline }, ... } — lưu
// trên disk để restart server không mất. lastSeen là ISO time của lần
// check-in cuối (qua API có ?sender=, POST /api/msg, form web, heartbeat).
const PRESENCE_FILE = path.join(__dirname, 'presence.json');
const PRESENCE_OFFLINE_MS = PRESENCE_OFFLINE_MINUTES * 60_000;
const PRESENCE_DIGEST_MS = PRESENCE_DIGEST_MINUTES * 60_000;
let presence = {};
try { presence = JSON.parse(fs.readFileSync(PRESENCE_FILE, 'utf8')) || {}; } catch { /* first run */ }
function persistPresence() {
  try { fs.writeFileSync(PRESENCE_FILE, JSON.stringify(presence, null, 2) + '\n'); } catch (e) {
    console.error('[presence] could not save presence:', e.message);
  }
}
function recordHeartbeat(sender) {
  if (!MUSES.includes(sender)) return null;
  const prev = presence[sender];
  const wasOffline = Boolean(prev && prev.notifiedOffline);
  presence[sender] = { lastSeen: new Date().toISOString(), notifiedOffline: false };
  persistPresence();
  return { prev, wasOffline };
}
// Digest catch-up: các tin sau sinceId (tối đa 20), dạng tóm tắt 1 dòng / tin.
// Từ v1.5.0, tin sender đã xác nhận đọc (read_by) thì không tính là chưa đọc.
function buildCatchupDigest(sender, sinceId) {
  const unread = messages.filter((m) => m.id > sinceId && m.sender !== sender
    && !(m.read_by || []).includes(sender));
  const lines = unread.slice(-20).map((m) => {
    const first = String(m.text).split('\n')[0].slice(0, 120);
    return `#${m.id} ${m.sender}: ${first}`;
  });
  return { unreadCount: unread.length, lines, latestId: messages.length ? messages[messages.length - 1].id : 0 };
}

// Tóm tắt lăn (v1.6.0): bản tóm tắt ngắn của thread, tính trực tiếp từ
// `messages` trong bộ nhớ nên luôn cập nhật theo từng tin mới — không cần
// file riêng, restart server cũng không lệch. Dùng cho GET /api/since,
// /health, /api/status và POST /api/heartbeat. Tin cũ (chưa có type /
// read_by) vẫn tính bình thường.
function buildRollingSummary() {
  const total = messages.length;
  const latest = total ? messages[total - 1] : null;
  const open = openTasks();
  const openByStatus = {};
  for (const m of open) openByStatus[m.task.status] = (openByStatus[m.task.status] || 0) + 1;
  const perSender = {};
  for (const m of messages) perSender[m.sender] = (perSender[m.sender] || 0) + 1;
  const decisions = messages.filter((m) => m.type === 'decision').slice(-5).map((m) => ({
    id: m.id, sender: m.sender, text: String(m.text).split('\n')[0].slice(0, 120),
  }));
  const lastDecision = decisions.length ? decisions[decisions.length - 1] : null;
  const text = total === 0
    ? 'Thread chưa có tin nhắn nào.'
    : `Thread: ${total} tin, mới nhất #${latest.id} (${latest.sender}, ${latest.ts}). `
      + `${open.length} task đang mở${Object.keys(openByStatus).length ? ` (${Object.entries(openByStatus).map(([s, n]) => `${s} ${n}`).join(', ')})` : ''}.`
      + (lastDecision ? ` Quyết định gần nhất: #${lastDecision.id} ${lastDecision.sender}: ${lastDecision.text}` : ' Chưa có quyết định nào.');
  return {
    total,
    latestId: latest ? latest.id : 0,
    latestTs: latest ? latest.ts : null,
    latestSender: latest ? latest.sender : null,
    openTasks: open.length,
    openByStatus,
    perSender,
    decisions,
    unread: unreadCounts(),
    text,
  };
}
function presenceStatus() {
  const now = Date.now();
  return MUSES.map((muse) => {
    const p = presence[muse];
    const lastSeen = p?.lastSeen ? new Date(p.lastSeen).getTime() : null;
    const agoMin = lastSeen === null ? null : Math.floor((now - lastSeen) / 60_000);
    return { muse, lastSeen: p?.lastSeen || null, agoMinutes: agoMin, online: agoMin !== null && agoMin < 2 };
  });
}
// Mỗi phút: Muse nào quá PRESENCE_OFFLINE_MINUTES phút không check-in thì
// báo Martin qua Telegram đúng 1 lần / lần offline (cờ notifiedOffline;
// khi Muse quay lại thì recordHeartbeat xóa cờ).
async function checkPresenceOffline() {
  if (!telegramEnabled || !PRESENCE_OFFLINE_MS) return;
  const now = Date.now();
  for (const muse of MUSES) {
    const p = presence[muse];
    if (!p?.lastSeen || p.notifiedOffline) continue;
    if (now - new Date(p.lastSeen).getTime() <= PRESENCE_OFFLINE_MS) continue;
    presence[muse] = { ...p, notifiedOffline: true };
    persistPresence();
    const agoMin = Math.floor((now - new Date(p.lastSeen).getTime()) / 60_000);
    const text = `[bridge] ${muse} đã offline ${agoMin} phút (không check-in từ ${p.lastSeen}).`;
    const msg = addMessage({ sender: 'bridge', text, source: 'presence' });
    console.log(`[presence] offline notice #${msg.id} ${muse} (${agoMin}m)`);
    await forwardToTelegram(msg);
    appendAudit({ action: 'presence.offline', sender: 'bridge', messageId: msg.id, source: 'presence' });
  }
}

// ---------- Mailbox (append-only JSONL) ----------
// messages.jsonl stays backward compatible: old plain
// {id, ts, sender, text, source} lines load fine; new fields (task,
// delivered, type, reply_to, mentions, read_by) are optional and simply
// absent on old messages.
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

// ---------- Task tracking (v1.1.0) + tin có cấu trúc (v1.5.0) ----------
// task: {assignee: muse-a|muse-b|muse-c|martin|null, status: todo|doing|done|blocked, deadline?: ISO date}
// deadline (v1.5.0): chuỗi ngày ISO (YYYY-MM-DD hoặc đầy đủ), phải parse
// được; sai định dạng thì throw để caller trả 400.
// Returns a normalized task object, or null when no task was given.
// Throws on invalid values so callers can answer 400.
function normalizeTask(input) {
  if (input === undefined || input === null) return null;
  const assignee = input.assignee === undefined || input.assignee === null || input.assignee === ''
    ? null : String(input.assignee);
  const status = input.status === undefined || input.status === null || input.status === ''
    ? null : String(input.status);
  const deadline = input.deadline === undefined || input.deadline === null || input.deadline === ''
    ? null : String(input.deadline);
  if (assignee === null && status === null && deadline === null) return null;
  if (assignee !== null && !TASK_ASSIGNEES.includes(assignee)) {
    throw new Error('assignee must be muse-a|muse-b|muse-c|martin');
  }
  if (status !== null && !TASK_STATUSES.includes(status)) {
    throw new Error('status must be todo|doing|done|blocked');
  }
  if (deadline !== null && Number.isNaN(Date.parse(deadline))) {
    throw new Error('deadline must be an ISO date, e.g. 2026-11-30');
  }
  const task = { assignee, status: status || 'todo' };
  if (deadline !== null) task.deadline = deadline;
  return task;
}

// Tin có cấu trúc (v1.5.0): type + reply_to. type mặc định: 'task' khi tin
// mang task, còn lại 'reply'. reply_to phải là id tin đã có trong thread.
// Throws on invalid values so callers can answer 400.
function normalizeMeta(input, hasTask) {
  const raw = input || {};
  const type = raw.type === undefined || raw.type === null || raw.type === ''
    ? (hasTask ? 'task' : 'reply') : String(raw.type);
  if (!MESSAGE_TYPES.includes(type)) {
    throw new Error('type must be task|reply|status|question|decision');
  }
  let replyTo = null;
  if (raw.reply_to !== undefined && raw.reply_to !== null && raw.reply_to !== '') {
    replyTo = Number(raw.reply_to);
    if (!Number.isInteger(replyTo) || replyTo <= 0 || !messages.some((m) => m.id === replyTo)) {
      throw new Error('reply_to must be the id of an existing message');
    }
  }
  return { type, replyTo };
}

// @mention (v1.5.0): quét text lấy các @muse-a/@muse-b/@muse-c/@martin,
// giữ thứ tự xuất hiện, bỏ trùng. Chỉ text mới quyết định mentions —
// client không tự khai mentions để tránh giả mạo nhắc tên.
function parseMentions(text) {
  const found = [];
  for (const m of String(text || '').matchAll(MENTION_RE)) {
    const name = m[0].slice(1);
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

function addMessage({ sender, text, source, task, type, reply_to }) {
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
  const meta = normalizeMeta({ type, reply_to }, Boolean(t));
  msg.type = meta.type;
  if (meta.replyTo !== null) msg.reply_to = meta.replyTo;
  const mentions = parseMentions(msg.text);
  if (mentions.length > 0) msg.mentions = mentions;
  // Người gửi đương nhiên đã đọc tin của chính mình; các Muse khác đọc
  // sau thì xác nhận bằng POST /api/messages/:id/read.
  msg.read_by = MUSES.includes(sender) ? [sender] : [];
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
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...sseClients]) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}
function broadcastMessage(msg) {
  broadcast('message', msg);
}

// ---------- Typing indicator (v1.7.0) ----------
// typing: { 'muse-b': { until: <epoch ms> } } — chỉ giữ trong bộ nhớ,
// không lưu file: trạng thái gõ hết hạn sau TYPING_TTL_MS không có ping
// mới. Client gửi ping tối đa 1 lần / 2s trong lúc gõ; POST
// {typing:false} để xóa ngay (khi gửi tin xong hoặc rời ô soạn). Hết hạn
// thì sweep mỗi 2s broadcast typing:false để các tab khác tắt dòng
// "đang gõ…".
const TYPING_TTL_MS = 5000;
const typing = {};
function currentTypists() {
  const now = Date.now();
  return MUSES.filter((muse) => typing[muse] && typing[muse].until > now);
}
function broadcastTyping() {
  broadcast('typing', { typing: currentTypists() });
}
function setTyping(sender, on) {
  if (!MUSES.includes(sender)) return null;
  if (on) {
    typing[sender] = { until: Date.now() + TYPING_TTL_MS };
  } else {
    delete typing[sender];
  }
  broadcastTyping();
  return currentTypists();
}
setInterval(() => {
  // Dọn các trạng thái gõ đã hết hạn; chỉ broadcast khi có thay đổi.
  const now = Date.now();
  let changed = false;
  for (const muse of Object.keys(typing)) {
    if (typing[muse].until <= now) { delete typing[muse]; changed = true; }
  }
  if (changed) broadcastTyping();
}, 2000).unref();

// ---------- Telegram ----------
async function sendToTelegram(text, replyMarkup) {
  if (!telegramEnabled) return false;
  try {
    const body = { chat_id: TELEGRAM_CHAT_ID, text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(tgApi('sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
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

// ---------- Telegram task controls (v1.4.0) ----------
// Lệnh chỉ nhận từ TELEGRAM_CHAT_ID đã cấu hình (pollTelegram kiểm tra
// chat id trước). Lệnh không bao giờ được đưa vào mailbox như tin chat
// thường — nó đổi trạng thái task rồi server đăng tin xác nhận lại thread
// (sender martin, source telegram) để cả 3 Muse đều thấy.
// /tasks — liệt kê task đang mở; /done <id>; /assign <id> <muse>;
// /status <id> <todo|doing|done|blocked>; /help.
const TASK_COMMANDS_HELP = [
  'Lệnh quản lý task:',
  '/tasks — liệt kê task đang mở',
  '/done <id> — đánh dấu task #id là done',
  '/assign <id> <muse-a|muse-b|muse-c|martin> — giao task',
  '/status <id> <todo|doing|done|blocked> — đổi trạng thái',
  '/help — xem lại danh sách này',
].join('\n');

function parseTelegramCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].split('@')[0].toLowerCase();
  if (cmd === '/tasks' && parts.length === 1) return { cmd: 'tasks' };
  if (cmd === '/help' && parts.length === 1) return { cmd: 'help' };
  if (cmd === '/done' && parts.length === 2) {
    const id = Number(parts[1]);
    return Number.isInteger(id) && id > 0 ? { cmd: 'done', id } : { cmd: 'bad', error: 'id phải là số, ví dụ /done 12' };
  }
  if (cmd === '/assign' && parts.length === 3) {
    const id = Number(parts[1]);
    if (!Number.isInteger(id) || id <= 0) return { cmd: 'bad', error: 'id phải là số, ví dụ /assign 12 muse-a' };
    if (!TASK_ASSIGNEES.includes(parts[2])) return { cmd: 'bad', error: 'assignee phải là muse-a|muse-b|muse-c|martin' };
    return { cmd: 'assign', id, assignee: parts[2] };
  }
  if (cmd === '/status' && parts.length === 3) {
    const id = Number(parts[1]);
    if (!Number.isInteger(id) || id <= 0) return { cmd: 'bad', error: 'id phải là số, ví dụ /status 12 doing' };
    if (!TASK_STATUSES.includes(parts[2])) return { cmd: 'bad', error: 'status phải là todo|doing|done|blocked' };
    return { cmd: 'status', id, status: parts[2] };
  }
  if (['/tasks', '/done', '/assign', '/status', '/help'].includes(cmd)) {
    return { cmd: 'bad', error: `sai cú pháp. Gõ /help để xem cách dùng.` };
  }
  return null; // lệnh lạ (không phải của bridge) — bỏ qua, không đưa vào mailbox
}

function listOpenTasksText() {
  const open = messages.filter((m) => m.task && (m.task.status === 'todo' || m.task.status === 'doing'));
  if (open.length === 0) return 'Không có task đang mở.';
  const lines = [`${open.length} task đang mở:`];
  for (const m of open) {
    const first = String(m.text).split('\n')[0].slice(0, 100);
    lines.push(`#${m.id} [${m.task.status}] ${m.task.assignee || 'chưa giao'} — ${m.sender}: ${first}`);
  }
  return lines.join('\n');
}

// Nút inline dưới tin task trên Telegram: callback_data 'task:<id>:<status>'
// hoặc 'assign:<id>:<muse>'. Telegram gửi callback_query về cho pollTelegram.
function taskKeyboard(msg) {
  if (!msg.task) return null;
  const id = msg.id;
  const statusRow = [
    { text: 'Todo', callback_data: `task:${id}:todo` },
    { text: 'Doing', callback_data: `task:${id}:doing` },
    { text: 'Done', callback_data: `task:${id}:done` },
    { text: 'Blocked', callback_data: `task:${id}:blocked` },
  ];
  const assignRow = ['muse-a', 'muse-b', 'muse-c'].map((muse) => ({ text: muse, callback_data: `assign:${id}:${muse}` }));
  return { inline_keyboard: [statusRow, assignRow] };
}

function parseCallbackData(data) {
  const parts = String(data || '').split(':');
  if (parts[0] === 'task' && parts.length === 3 && TASK_STATUSES.includes(parts[2])) {
    const id = Number(parts[1]);
    if (Number.isInteger(id) && id > 0) return { kind: 'task', id, status: parts[2] };
  }
  if (parts[0] === 'assign' && parts.length === 3 && TASK_ASSIGNEES.includes(parts[2])) {
    const id = Number(parts[1]);
    if (Number.isInteger(id) && id > 0) return { kind: 'assign', id, assignee: parts[2] };
  }
  return null;
}

// Áp dụng 1 thay đổi task; trả về {ok, message?, error?}. Không tự đăng tin
// — caller đăng tin xác nhận sau khi áp xong.
function applyTaskUpdate({ id, status, assignee }) {
  const msg = messages.find((m) => m.id === id);
  if (!msg) return { ok: false, error: `không tìm thấy tin #${id}` };
  if (!msg.task) return { ok: false, error: `tin #${id} không phải task` };
  const next = { ...msg.task };
  if (status !== undefined) next.status = status;
  if (assignee !== undefined) next.assignee = assignee;
  msg.task = next;
  persistMessages();
  appendAudit({ action: 'task.update', sender: 'martin', messageId: msg.id, source: 'telegram' });
  return { ok: true, message: msg };
}

// Xử lý 1 lệnh Telegram đã parse; đăng tin xác nhận lên mailbox (sender
// martin, source telegram) để cả 3 Muse đều thấy, rồi trả text để gửi
// lại Telegram. Trả null khi lệnh không phải của bridge.
async function handleTelegramCommand(parsed) {
  if (!parsed) return null;
  if (parsed.cmd === 'help') return TASK_COMMANDS_HELP;
  if (parsed.cmd === 'tasks') return listOpenTasksText();
  if (parsed.cmd === 'bad') return parsed.error;
  const r = applyTaskUpdate(parsed);
  if (!r.ok) return r.error;
  const m = r.message;
  const what = parsed.cmd === 'done'
    ? `đã xong #${m.id}`
    : parsed.cmd === 'assign'
      ? `đã giao #${m.id} cho ${parsed.assignee}`
      : `đã đổi #${m.id} sang ${parsed.status}`;
  const confirm = `[telegram] Martin ${what} [${m.task.status}${m.task.assignee ? ' · ' + m.task.assignee : ''}]: ${String(m.text).split('\n')[0].slice(0, 100)}`;
  const msg = addMessage({ sender: 'martin', text: confirm, source: 'telegram' });
  console.log(`[telegram] command #${msg.id} ${parsed.cmd} #${m.id}`);
  return confirm;
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
// Từ v1.5.0, tin nhắc @muse nào thì dòng forward mở đầu bằng
// "[nhắc @muse-b]" để người nhận thấy ngay là tin gọi mình (push thay vì
// poll); tin task thì kèm thêm trạng thái + assignee + deadline.
async function forwardToTelegram(msg) {
  if (!telegramEnabled) return;
  const mentionPrefix = (msg.mentions || []).length > 0
    ? `[nhắc ${msg.mentions.map((m) => `@${m}`).join(' ')}] ` : '';
  const taskSuffix = msg.task
    ? ` [${msg.task.status || 'todo'}${msg.task.assignee ? ' · ' + msg.task.assignee : ''}${msg.task.deadline ? ' · hạn ' + msg.task.deadline : ''}]` : '';
  const text = `${mentionPrefix}[${msg.sender}]${taskSuffix} ${msg.text}`;
  const ok = await sendToTelegram(text, taskKeyboard(msg));
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
  // Auto-deploy (v1.4.0): cùng 1 webhook này vừa đăng tin vừa deploy khi
  // push / PR-merge vào DEPLOY_BRANCH của repo muse2muse. Martin chỉ cần
  // cấu hình 1 webhook duy nhất tới /api/github-webhook.
  if (repo === 'tuanxminhxgi/muse2muse') {
    const branch = String(payload.ref || '').replace(/^refs\/heads\//, '');
    const isPushToDeploy = event === 'push' && branch === DEPLOY_BRANCH;
    const isMergedPr = event === 'pull_request' && payload.action === 'closed' && payload.pull_request?.merged
      && payload.pull_request?.base?.ref === DEPLOY_BRANCH;
    if (isPushToDeploy || isMergedPr) {
      const headSha = isPushToDeploy ? payload.after : payload.pull_request?.merge_commit_sha;
      runDeploy(headSha).catch((e) => console.error('[deploy] error:', e.message));
    }
  }
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
      // Nút inline (v1.4.0): callback_query từ nút dưới tin task. Chỉ nhận
      // từ chat đã cấu hình; dữ liệu sai thì bỏ qua, không đăng gì.
      if (upd.callback_query) {
        const cq = upd.callback_query;
        if (String(cq.message?.chat?.id) !== String(TELEGRAM_CHAT_ID)) continue;
        if (!TELEGRAM_COMMANDS_ENABLED) continue;
        const parsed = parseCallbackData(cq.data);
        if (!parsed) continue;
        const r = applyTaskUpdate(parsed);
        if (r.ok) {
          const m = r.message;
          const confirm = `[telegram] Martin đã đổi #${m.id} sang ${m.task.status}${m.task.assignee ? ' · ' + m.task.assignee : ''} (nút Telegram): ${String(m.text).split('\n')[0].slice(0, 100)}`;
          const msg = addMessage({ sender: 'martin', text: confirm, source: 'telegram' });
          console.log(`[telegram] callback #${msg.id} #${m.id} -> ${m.task.status}`);
          try { await fetch(tgApi('answerCallbackQuery'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callback_query_id: cq.id, text: 'Đã cập nhật' }) }); } catch {}
        }
        continue;
      }
      const m = upd.message || upd.channel_post;
      if (!m || !m.text) continue;
      if (String(m.chat?.id) !== String(TELEGRAM_CHAT_ID)) continue;
      if (m.from?.is_bot) continue;
      const key = `tg:${m.message_id}`;
      if (tgSeen.has(key)) continue;
      tgSeen.add(key);
      if (tgSeen.size > 1000) tgSeen = new Set([...tgSeen].slice(-500));
      // Lệnh task (v1.4.0): xử lý, đăng xác nhận lên thread, trả lời lại
      // Telegram — không đưa lệnh vào mailbox như tin chat thường.
      if (TELEGRAM_COMMANDS_ENABLED) {
        const parsed = parseTelegramCommand(m.text);
        if (parsed) {
          const reply = await handleTelegramCommand(parsed);
          if (reply) await sendToTelegram(reply);
          continue;
        }
      }
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

// ---------- Auto-deploy (v1.4.0) ----------
// Webhook GitHub báo push / PR-merge vào DEPLOY_BRANCH → server tự
// `git pull --ff-only origin <DEPLOY_BRANCH>` trong REPO_DIR rồi tự restart (process.exit(0);
// systemd service muse-bridge.service khởi động lại). Chỉ restart khi pull
// thành công VÀ code thật sự đổi (stdout của pull có 'Already up to date.'
// thì không restart). Pull lỗi → không restart, chỉ báo lên thread +
// Telegram và ghi audit deploy.failed để Martin biết. Webhook dùng chung
// GITHUB_WEBHOOK_SECRET + verifyGitHubSignature của v1.3.0.
// Deploy trùng (GitHub retry / cả 2 endpoint nhận cùng event): bỏ qua nếu
// cùng headSha đã deploy trong 60s gần nhất.
function postDeployNotice(text, source) {
  const msg = addMessage({ sender: 'telegram', text, source });
  console.log(`[deploy] #${msg.id} ${text.split('\n')[0].slice(0, 100)}`);
  forwardToTelegram(msg);
  return msg;
}

async function runDeploy(headSha) {
  if (!AUTO_DEPLOY_ENABLED || !GITHUB_WEBHOOK_SECRET) return { ok: false, ignored: 'auto-deploy not configured' };
  if (deployState.deploying) return { ok: false, ignored: 'deploy already in progress' };
  if (headSha && headSha === deployState.lastDeploySha && deployState.lastDeployAt
    && Date.now() - new Date(deployState.lastDeployAt).getTime() < 60_000) {
    return { ok: false, ignored: 'same commit already deployed recently' };
  }
  deployState.deploying = true;
  try {
    const out = await new Promise((resolve, reject) => {
      execFile('git', ['-C', REPO_DIR, 'pull', '--ff-only', 'origin', DEPLOY_BRANCH], { timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${stderr || err.message}`.trim().slice(0, 500)));
        else resolve(String(stdout || ''));
      });
    });
    const changed = !/Already up to date\./i.test(out);
    deployState.lastDeployAt = new Date().toISOString();
    deployState.lastDeploySha = headSha || null;
    if (!changed) {
      deployState.lastDeployResult = 'already up to date';
      console.log('[deploy] already up to date, no restart');
      return { ok: true, changed: false };
    }
    deployState.lastDeployResult = 'deployed, restarting';
    postDeployNotice(`[deploy] Đã pull code mới từ GitHub (${(headSha || '').slice(0, 7)}) — bridge v${VERSION} sẽ tự restart trong giây lát.`, 'deploy');
    appendAudit({ action: 'deploy.success', sender: 'bridge', source: 'deploy', messageId: null });
    setTimeout(() => { console.log('[deploy] restarting now'); process.exit(0); }, DEPLOY_RESTART_DELAY_MS);
    return { ok: true, changed: true };
  } catch (e) {
    deployState.lastDeployAt = new Date().toISOString();
    deployState.lastDeployResult = `failed: ${e.message}`;
    postDeployNotice(`[deploy] Pull code thất bại, bridge KHÔNG restart (vẫn chạy bản cũ): ${e.message}`, 'deploy');
    appendAudit({ action: 'deploy.failed', sender: 'bridge', source: 'deploy', messageId: null });
    return { ok: false, error: e.message };
  } finally {
    deployState.deploying = false;
  }
}

// Deploy-only endpoint (v1.4.0): POST /webhook/github — dùng chung secret
// và verify của v1.3.0. Chỉ nhận push / PR-merge vào DEPLOY_BRANCH của repo
// tuanxminhxgi/muse2muse; event khác thì 200 + ignored, không deploy.
async function handleDeployWebhook(req, res) {
  if (!GITHUB_WEBHOOK_SECRET) return json(res, 404, { ok: false, error: 'auto-deploy not configured (set GITHUB_WEBHOOK_SECRET)' });
  const rawBody = await readBody(req);
  const signature = req.headers['x-hub-signature-256'] || '';
  if (!verifyGitHubSignature(rawBody, signature)) {
    return json(res, 401, { ok: false, error: 'bad github signature' });
  }
  const event = req.headers['x-github-event'] || '';
  if (event === 'ping') return json(res, 200, { ok: true, event: 'ping' });
  let payload = {};
  try { payload = JSON.parse(rawBody); } catch {
    return json(res, 400, { ok: false, error: 'invalid JSON payload' });
  }
  const repo = payload.repository?.full_name || '';
  const branch = String(payload.ref || '').replace(/^refs\/heads\//, '');
  const isPushToDeploy = event === 'push' && repo === 'tuanxminhxgi/muse2muse' && branch === DEPLOY_BRANCH;
  const isMergedPr = event === 'pull_request' && payload.action === 'closed' && payload.pull_request?.merged
    && payload.pull_request?.base?.ref === DEPLOY_BRANCH && repo === 'tuanxminhxgi/muse2muse';
  if (!isPushToDeploy && !isMergedPr) {
    return json(res, 200, { ok: true, ignored: `not a deploy event: ${event} ${repo}@${branch}` });
  }
  const headSha = isPushToDeploy ? payload.after : payload.pull_request?.merge_commit_sha;
  const r = await runDeploy(headSha);
  return json(res, 200, { ok: true, deploy: r });
}

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
  const deadline = m.task.deadline ? ` · hạn ${esc(m.task.deadline)}` : '';
  return ` <span style="background:#eef;border:1px solid #ccd;border-radius:4px;padding:1px 6px;font-size:12px">[${esc(m.task.status || 'todo')}${assignee}${deadline}]</span>`;
}

// @mention + read receipt (v1.5.0): chip @muse-b... và dòng "Đã đọc: ...".
function mentionBadge(m) {
  if (!m.mentions || m.mentions.length === 0) return '';
  return ` <span style="background:#fef3c7;border:1px solid #fcd34d;border-radius:4px;padding:1px 6px;font-size:12px">${m.mentions.map((x) => '@' + esc(x)).join(' ')}</span>`;
}

function readBadge(m) {
  if (!m.read_by || m.read_by.length === 0) return '';
  return `<div style="color:#888;font-size:12px;margin-top:4px">Đã đọc: ${m.read_by.map(esc).join(', ')}</div>`;
}

// Panel "Có gì mới từ lần trước bạn ghé" (v1.7.0): dùng tóm tắt lăn
// (v1.6.0) để hiện số tin chưa đọc từng Muse, task đang mở theo trạng
// thái, 5 quyết định gần nhất và tin mới nhất — mỗi mục là link anchor
// #msg-<id> để bấm là nhảy thẳng tới tin đó. Các div có id wn-* để JS
// cập nhật live khi có tin mới qua SSE (fetch /api/since).
function renderWhatsNew() {
  const s = buildRollingSummary();
  const open = openTasks();
  const latest = s.latestId ? messages[messages.length - 1] : null;
  const unread = MUSES.map((muse) => `${muse}: ${s.unread[muse] || 0} chưa đọc`).join(' · ');
  const tasks = open.length === 0
    ? 'Không có task đang mở.'
    : Object.entries(s.openByStatus).map(([st, n]) => `${st} ${n}`).join(', ')
      + ' — ' + open.slice(0, 8).map((m) => `<a href="#msg-${m.id}">#${m.id} [${esc(m.task.status)}${m.task.assignee ? ' · ' + esc(m.task.assignee) : ''}]</a>`).join(' ');
  const decisions = s.decisions.length === 0
    ? 'Chưa có quyết định nào.'
    : s.decisions.map((d) => `<a href="#msg-${d.id}">#${d.id} ${esc(d.sender)}: ${esc(d.text)}</a>`).join('<br>');
  const latestLine = latest
    ? `<a href="#msg-${latest.id}">#${latest.id} ${esc(latest.sender)}: ${esc(String(latest.text).split('\n')[0].slice(0, 120))}</a> <span style="color:#888">(${esc(latest.ts)})</span>`
    : 'Chưa có tin nhắn nào.';
  return `
    <div id="whats-new" style="margin:12px 0;padding:12px;border:2px solid #f59e0b;border-radius:8px;background:#fffbeb">
      <b>Có gì mới từ lần trước bạn ghé</b>
      <div id="wn-unread" style="margin-top:6px">Chưa đọc: ${esc(unread)}</div>
      <div id="wn-tasks" style="margin-top:4px">Task đang mở (${open.length}): ${tasks}</div>
      <div id="wn-decisions" style="margin-top:4px">5 quyết định gần nhất:<br>${decisions}</div>
      <div id="wn-latest" style="margin-top:4px">Tin mới nhất: ${latestLine}</div>
    </div>`;
}

// Avatar presence (v1.7.0): vòng tròn chữ cái đầu của từng Muse, chấm
// xanh khi online (< 2 phút), xám khi đã lâu không check-in. JS làm mới
// mỗi 60s qua GET /api/presence.
function renderPresenceAvatars() {
  const colors = { 'muse-a': '#2563eb', 'muse-b': '#059669', 'muse-c': '#d97706' };
  return presenceStatus().map((p) => {
    const initial = p.muse.replace('muse-', '').toUpperCase();
    const dot = p.online ? '#22c55e' : '#9ca3af';
    const ago = p.online ? 'online' : (p.agoMinutes === null ? 'chưa check-in' : p.agoMinutes + ' phút trước');
    return `<span class="avatar" data-muse="${p.muse}" title="${p.muse} — ${ago}" style="display:inline-flex;align-items:center;gap:6px;margin-right:12px">`
      + `<span style="position:relative;display:inline-block;width:28px;height:28px;border-radius:50%;background:${colors[p.muse]};color:#fff;font-weight:bold;text-align:center;line-height:28px">${initial}<span class="avatar-dot" style="position:absolute;right:-1px;bottom:-1px;width:9px;height:9px;border-radius:50%;background:${dot};border:2px solid #fff"></span></span>`
      + `<span class="avatar-label" style="font-size:12px;color:#555">${p.muse} · ${ago}</span></span>`;
  }).join('');
}

// Thao tác nhanh ngay trên từng tin (v1.7.0): trả lời theo chuỗi, đánh dấu
// đã đọc, đổi trạng thái / giao task, copy link tới tin. Các nút dùng
// data-action để JS bắt sự kiện chung; nút task chỉ hiện khi tin có task.
function renderActions(m) {
  const statusBtns = m.task ? TASK_STATUSES.map((st) =>
    `<button type="button" data-action="status" data-id="${m.id}" data-status="${st}" title="Đổi task #${m.id} sang ${st}">${st}</button>`).join(' ') : '';
  const assignSelect = m.task ? ` <select data-action="assign" data-id="${m.id}" title="Giao task #${m.id} cho...">`
    + `<option value="">Giao cho…</option>`
    + TASK_ASSIGNEES.map((a) => `<option value="${a}"${m.task.assignee === a ? ' selected' : ''}>${a}</option>`).join('')
    + `</select>` : '';
  return `<div class="msg-actions" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">`
    + `<button type="button" data-action="reply" data-id="${m.id}" title="Trả lời tin #${m.id} (điền vào form bên dưới)">Trả lời</button>`
    + ` <button type="button" data-action="read" data-id="${m.id}" title="Đánh dấu đã đọc (theo sender đang chọn trong form)">Đã đọc</button>`
    + (statusBtns ? ` ${statusBtns}` : '') + assignSelect
    + ` <button type="button" data-action="copy" data-id="${m.id}" title="Copy link tới tin #${m.id}">Copy link</button>`
    + `</div>`;
}

function renderRow(m) {
  const reply = m.reply_to ? `<div style="color:#888;font-size:12px">Trả lời #${m.reply_to}</div>` : '';
  const type = m.type ? `<span style="color:#888;font-size:12px">[${esc(m.type)}]</span> ` : '';
  return `
    <div id="msg-${m.id}" style="margin:0 0 10px;padding:10px;border:1px solid #ddd;border-radius:8px">
      <b>#${m.id} ${esc(m.sender)}</b>${taskBadge(m)}${mentionBadge(m)}
      <span style="color:#888;font-size:12px">${esc(m.ts)} · ${esc(m.source)}</span>
      ${reply}
      <div style="white-space:pre-wrap;margin-top:4px">${type}${esc(m.text)}</div>
      ${readBadge(m)}
      ${renderActions(m)}
    </div>`;
}

function renderPage() {
  const rows = messages.slice(-100).map(renderRow).join('') || '<p><i>Chưa có tin nhắn nào. Martin hãy gửi tin đầu tiên từ Telegram, hoặc Muse A hãy chào Muse B và Muse C.</i></p>';

  return `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Muse Bridge — 3 Muse chat</title>
<style>
html{scroll-behavior:smooth}
#thread>div:target{outline:2px solid #f59e0b;outline-offset:2px}
.msg-actions button,.msg-actions select{font-size:12px;padding:2px 8px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer}
.msg-actions button:hover{background:#f3f4f6}
#palette{position:fixed;top:12%;left:50%;transform:translateX(-50%);width:min(560px,92vw);background:#fff;border:1px solid #ccc;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.2);z-index:100;padding:10px;display:none}
#palette-list div{padding:6px 8px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#palette-list div.sel{background:#eef}
</style></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px">
<h1>Muse Bridge</h1>
<p>Mailbox chung cho <b>muse-a</b>, <b>muse-b</b> và <b>muse-c</b>. Tin nhắn ở đây cũng được chuyển sang Telegram và ngược lại. Trang tự cập nhật live (SSE), không cần refresh.</p>
<p>Presence: ${presenceStatus().map((p) => `${p.muse} ${p.online ? 'online' : (p.agoMinutes === null ? 'chưa check-in' : 'online ' + p.agoMinutes + ' phút trước')}`).join(' · ')}</p>
<p>Tóm tắt: ${esc(buildRollingSummary().text)}</p>
${renderWhatsNew()}
<p>Đang ở đây: <span id="presence-avatars">${renderPresenceAvatars()}</span></p>
<p id="typing-line" style="color:#888;font-size:13px;min-height:18px;margin:4px 0"></p>
<p>Auto-deploy: ${AUTO_DEPLOY_ENABLED && GITHUB_WEBHOOK_SECRET ? 'BẬT' : 'TẮT'}</p>
<p><b>Hướng dẫn cho Muse:</b> đọc toàn bộ thread dưới đây, rồi trả lời bằng form bên dưới với đúng sender của bạn (muse-a, muse-b hoặc muse-c). Chỉ trả lời khi có tin mới cần bạn xử lý, hoặc khi Martin giao việc. Đừng lặp lại tin đã có.</p>
<h2>Thread (<span id="thread-count">${messages.length}</span> tin)</h2>
<div id="thread">
${rows}
</div>
<h2>Gửi tin</h2>
<form id="compose-form" method="POST" action="/b/${esc(BRIDGE_TOKEN)}/msg">
  <label>Sender:
    <select id="sender-select" name="sender">
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
  </label>
  <label> Loại tin:
    <select name="type">
      <option value="">— tự động —</option>
      <option value="task">task</option>
      <option value="reply">reply</option>
      <option value="status">status</option>
      <option value="question">question</option>
      <option value="decision">decision</option>
    </select>
  </label>
  <label> Trả lời tin #:
    <input name="reply_to" type="number" min="1" style="width:80px" placeholder="#">
  </label>
  <label> Hạn (task):
    <input name="deadline" type="date">
  </label><br><br>
  <textarea id="compose-text" name="text" rows="4" cols="60" placeholder="Nhắn cho Muse còn lại... (gõ @muse-a, @muse-b hoặc @muse-c để nhắc đúng người)" required></textarea><br><br>
  <button type="submit">Gửi</button>
</form>
<p style="color:#888;font-size:12px">Phím tắt: <b>Ctrl+K</b> mở command palette (nhảy tới tin/task hoặc gửi tin nhanh) · <b>/</b> focus ô soạn tin · <b>Esc</b> đóng palette. Mỗi tin có nút Trả lời / Đã đọc / đổi trạng thái task / Giao cho / Copy link ngay dưới tin.</p>
<div id="palette"><input id="palette-input" type="text" placeholder="Gõ để tìm tin, task… hoặc gõ tin rồi Enter để gửi nhanh" style="width:100%;box-sizing:border-box;padding:8px;font-size:14px"><div id="palette-list" style="margin-top:6px;max-height:300px;overflow:auto"></div></div>
<script>var MSG_INDEX = ${JSON.stringify(messages.slice(-100).map((m) => ({ id: m.id, sender: m.sender, text: String(m.text).split('\n')[0].slice(0, 80), task: m.task ? m.task.status : null }))).replace(/</g, '\\u003c')};</script>
<p style="color:#888;font-size:12px">API: GET /api/messages?since=&lt;id&gt;&amp;token=... · POST /api/msg {"sender","text","token"} · GET /api/tasks?token=... · GET /api/events?token=... (SSE live) · GET /status · GET /api/digest?token=... · POST /api/github-webhook · GET /api/presence?token=... · POST /api/heartbeat · POST /api/messages/:id/read {"token","reader"} · GET /api/since?token=...&amp;sender=&amp;since= (tóm tắt lăn + tin mới) · POST /api/typing {"token","sender","typing"} · GET /api/typing?token=...</p>
<script>
// Live update qua SSE; trang vẫn render đầy đủ từ server nên không có JS
// thì vẫn đọc/gửi được. Nếu EventSource lỗi thì không làm gì thêm.
// Từ v1.7.0: thao tác nhanh trên từng tin, command palette (Ctrl+K),
// phím tắt, chỉ báo đang gõ, panel "Có gì mới" + avatar presence live.
(function () {
  var TOKEN = '${esc(BRIDGE_TOKEN)}';
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function currentSender() {
    var sel = document.getElementById('sender-select');
    return sel ? sel.value : '';
  }
  // API: token vừa gắn query (cho route dùng requireToken) vừa gắn body
  // (cho route đọc data.token) để dùng chung cho mọi endpoint.
  function api(path, method, body) {
    var b = body || {};
    b.token = TOKEN;
    var url = path + (path.indexOf('?') === -1 ? '?token=' : '&token=') + encodeURIComponent(TOKEN);
    return fetch(url, {
      method: method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, json: j }; }); });
  }
  function apiGet(path) {
    var url = path + (path.indexOf('?') === -1 ? '?token=' : '&token=') + encodeURIComponent(TOKEN);
    return fetch(url).then(function (r) { return r.json(); });
  }
  // Nút thao tác nhanh (v1.7.0) — dùng chung cho tin render từ server và
  // tin append qua SSE, để 2 phía luôn giống nhau.
  function actionsHtml(m) {
    var h = '<div class="msg-actions" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">'
      + '<button type="button" data-action="reply" data-id="' + m.id + '" title="Trả lời tin #' + m.id + '">Trả lời</button>'
      + ' <button type="button" data-action="read" data-id="' + m.id + '" title="Đánh dấu đã đọc (theo sender đang chọn trong form)">Đã đọc</button>';
    if (m.task) {
      ['todo', 'doing', 'done', 'blocked'].forEach(function (st) {
        h += ' <button type="button" data-action="status" data-id="' + m.id + '" data-status="' + st + '" title="Đổi task #' + m.id + ' sang ' + st + '">' + st + '</button>';
      });
      h += ' <select data-action="assign" data-id="' + m.id + '" title="Giao task #' + m.id + ' cho..."><option value="">Giao cho…</option>'
        + ['muse-a', 'muse-b', 'muse-c', 'martin'].map(function (a) {
            return '<option value="' + a + '"' + (m.task.assignee === a ? ' selected' : '') + '>' + a + '</option>';
          }).join('') + '</select>';
    }
    h += ' <button type="button" data-action="copy" data-id="' + m.id + '" title="Copy link tới tin #' + m.id + '">Copy link</button></div>';
    return h;
  }
  function rowHtml(m) {
    var badge = '';
    if (m.task) {
      badge = ' <span style="background:#eef;border:1px solid #ccd;border-radius:4px;padding:1px 6px;font-size:12px">[' +
        escHtml(m.task.status || 'todo') + (m.task.assignee ? ' · ' + escHtml(m.task.assignee) : '') +
        (m.task.deadline ? ' · hạn ' + escHtml(m.task.deadline) : '') + ']</span>';
    }
    if (m.mentions && m.mentions.length) {
      badge += ' <span style="background:#fef3c7;border:1px solid #fcd34d;border-radius:4px;padding:1px 6px;font-size:12px">' +
        m.mentions.map(function (x) { return '@' + escHtml(x); }).join(' ') + '</span>';
    }
    var reply = m.reply_to ? '<div style="color:#888;font-size:12px">Trả lời #' + m.reply_to + '</div>' : '';
    var type = m.type ? '<span style="color:#888;font-size:12px">[' + escHtml(m.type) + ']</span> ' : '';
    var read = (m.read_by && m.read_by.length)
      ? '<div style="color:#888;font-size:12px;margin-top:4px">Đã đọc: ' + m.read_by.map(escHtml).join(', ') + '</div>' : '';
    return '<b>#' + m.id + ' ' + escHtml(m.sender) + '</b>' + badge +
      ' <span style="color:#888;font-size:12px">' + escHtml(m.ts) + ' · ' + escHtml(m.source) + '</span>' +
      reply +
      '<div style="white-space:pre-wrap;margin-top:4px">' + type + escHtml(m.text) + '</div>' +
      read + actionsHtml(m);
  }
  function refreshRow(id) {
    apiGet('/api/messages?since=' + (id - 1) + '&limit=1').then(function (j) {
      var m = (j.messages || []).filter(function (x) { return x.id === id; })[0];
      var row = document.getElementById('msg-' + id);
      if (m && row) row.innerHTML = rowHtml(m);
    }).catch(function () { /* keep the old row on error */ });
  }
  // Panel "Có gì mới": lấy lại tóm tắt lăn qua /api/since (v1.6.0) mỗi khi
  // có tin mới hoặc task đổi, để số chưa đọc / task mở / quyết định luôn mới.
  function refreshWhatsNew() {
    apiGet('/api/since?since=' + Math.max(0, maxId - 1)).then(function (j) {
      if (!j || !j.summary) return;
      var s = j.summary;
      var unreadEl = document.getElementById('wn-unread');
      if (unreadEl) unreadEl.textContent = 'Chưa đọc: ' + ['muse-a', 'muse-b', 'muse-c'].map(function (m) { return m + ': ' + (s.unread[m] || 0) + ' chưa đọc'; }).join(' · ');
      var latestEl = document.getElementById('wn-latest');
      if (latestEl && s.latestId) {
        var last = (j.delta || []).filter(function (x) { return x.id === s.latestId; })[0];
        if (last) latestEl.innerHTML = 'Tin mới nhất: <a href="#msg-' + last.id + '">#' + last.id + ' ' + escHtml(last.sender) + ': ' + escHtml(String(last.text).split('\n')[0].slice(0, 120)) + '</a>';
      }
      var tasksEl = document.getElementById('wn-tasks');
      if (tasksEl && j.openTasks) {
        tasksEl.innerHTML = 'Task đang mở (' + j.openTasks.length + '): ' + (j.openTasks.length === 0 ? 'Không có task đang mở.' :
          Object.keys(s.openByStatus || {}).map(function (k) { return k + ' ' + s.openByStatus[k]; }).join(', ') + ' — ' +
          j.openTasks.slice(0, 8).map(function (t) { return '<a href="#msg-' + t.id + '">#' + t.id + ' [' + escHtml(t.status) + (t.assignee ? ' · ' + escHtml(t.assignee) : '') + ']</a>'; }).join(' '));
      }
      var decEl = document.getElementById('wn-decisions');
      if (decEl) {
        decEl.innerHTML = '5 quyết định gần nhất:<br>' + ((s.decisions || []).length === 0 ? 'Chưa có quyết định nào.' :
          s.decisions.map(function (d) { return '<a href="#msg-' + d.id + '">#' + d.id + ' ' + escHtml(d.sender) + ': ' + escHtml(d.text) + '</a>'; }).join('<br>'));
      }
    }).catch(function () { /* panel keeps its server-rendered values */ });
  }
  var maxId = ${messages.length ? Math.max(...messages.map((m) => m.id)) : 0};
  if (typeof EventSource !== 'undefined') {
    var es;
    try { es = new EventSource('/api/events?token=${esc(BRIDGE_TOKEN)}'); } catch (e) { es = null; }
    if (es) {
      es.addEventListener('message', function (ev) {
        try {
          var m = JSON.parse(ev.data);
          if (!m || typeof m.id !== 'number' || m.id <= maxId) return;
          if (document.getElementById('msg-' + m.id)) return;
          maxId = m.id;
          var div = document.createElement('div');
          div.id = 'msg-' + m.id;
          div.style.cssText = 'margin:0 0 10px;padding:10px;border:1px solid #ddd;border-radius:8px';
          div.innerHTML = rowHtml(m);
          document.getElementById('thread').appendChild(div);
          var count = document.getElementById('thread-count');
          if (count) count.textContent = String(Number(count.textContent || '0') + 1);
          refreshWhatsNew();
        } catch (e) { /* ignore a malformed event */ }
      });
      // Chỉ báo đang gõ (v1.7.0): SSE event typing {typing: ['muse-b', ...]}.
      // Không hiện chính mình đang gõ.
      es.addEventListener('typing', function (ev) {
        try {
          var d = JSON.parse(ev.data);
          var line = document.getElementById('typing-line');
          if (!line) return;
          var t = (d.typing || []).filter(function (s) { return s !== currentSender(); });
          line.textContent = t.length ? t.map(function (s) { return s + ' đang gõ…'; }).join(' · ') : '';
        } catch (e) { /* ignore */ }
      });
    }
  }
  // ----- Thao tác nhanh trên từng tin (v1.7.0) -----
  var thread = document.getElementById('thread');
  if (thread) {
    thread.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-action]') : null;
      if (!btn || btn.tagName === 'SELECT') return;
      var action = btn.getAttribute('data-action');
      var id = Number(btn.getAttribute('data-id'));
      if (action === 'reply') {
        var replyTo = document.querySelector('input[name="reply_to"]');
        var typeSel = document.querySelector('select[name="type"]');
        var text = document.getElementById('compose-text');
        if (replyTo) replyTo.value = String(id);
        if (typeSel) typeSel.value = 'reply';
        if (text) text.focus();
      } else if (action === 'read') {
        var reader = currentSender();
        if (['muse-a', 'muse-b', 'muse-c'].indexOf(reader) === -1) { alert('Chọn sender là muse-a, muse-b hoặc muse-c trong form rồi bấm lại.'); return; }
        api('/api/messages/' + id + '/read', 'POST', { reader: reader }).then(function (r) {
          if (!r.ok) { alert('Không đánh dấu được: ' + (r.json.error || r.status)); return; }
          refreshRow(id);
        });
      } else if (action === 'status') {
        api('/api/messages/' + id + '/task', 'PATCH', { status: btn.getAttribute('data-status'), sender: currentSender() }).then(function (r) {
          if (!r.ok) { alert('Không đổi được trạng thái: ' + (r.json.error || r.status)); return; }
          refreshRow(id); refreshWhatsNew();
        });
      } else if (action === 'copy') {
        var link = location.origin + location.pathname + '#msg-' + id;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(function () {
            btn.textContent = 'Đã copy!';
            setTimeout(function () { btn.textContent = 'Copy link'; }, 1500);
          });
        } else {
          prompt('Copy link tới tin #' + id + ':', link);
        }
      }
    });
    thread.addEventListener('change', function (ev) {
      var sel = ev.target.closest ? ev.target.closest('select[data-action="assign"]') : null;
      if (!sel || !sel.value) return;
      var id = Number(sel.getAttribute('data-id'));
      api('/api/messages/' + id + '/task', 'PATCH', { assignee: sel.value, sender: currentSender() }).then(function (r) {
        if (!r.ok) { alert('Không giao được: ' + (r.json.error || r.status)); return; }
        refreshRow(id); refreshWhatsNew();
      });
    });
  }
  // ----- Command palette (v1.7.0): Ctrl+K -----
  var palette = document.getElementById('palette');
  var paletteInput = document.getElementById('palette-input');
  var paletteList = document.getElementById('palette-list');
  var paletteSel = 0;
  var paletteItems = [];
  function closePalette() { if (palette) palette.style.display = 'none'; if (paletteInput) paletteInput.value = ''; }
  function openPalette() {
    if (!palette) return;
    palette.style.display = 'block';
    paletteInput.value = '';
    renderPalette('');
    paletteInput.focus();
  }
  function paintPaletteSel() {
    if (!paletteList) return;
    var divs = paletteList.querySelectorAll('div[data-i]');
    for (var i = 0; i < divs.length; i++) {
      if (Number(divs[i].getAttribute('data-i')) === paletteSel) divs[i].classList.add('sel');
      else divs[i].classList.remove('sel');
    }
  }
  function renderPalette(q) {
    q = (q || '').toLowerCase();
    var items = [];
    if (q) items.push({ kind: 'send', label: 'Gửi tin: "' + q + '" (sender: ' + (currentSender() || 'chưa chọn') + ')' });
    var idx = window.MSG_INDEX || [];
    for (var i = idx.length - 1; i >= 0 && items.length < 9; i--) {
      var m = idx[i];
      var hay = ('#' + m.id + ' ' + m.sender + ' ' + m.text).toLowerCase();
      if (!q || hay.indexOf(q) !== -1) items.push({ kind: 'msg', id: m.id, label: '#' + m.id + ' ' + m.sender + (m.task ? ' [' + m.task + ']' : '') + ': ' + m.text });
    }
    paletteItems = items;
    paletteSel = 0;
    paletteList.innerHTML = items.length ? items.map(function (it, i) {
      return '<div data-i="' + i + '" class="' + (i === paletteSel ? 'sel' : '') + '">' + escHtml(it.label) + '</div>';
    }).join('') : '<div>Không tìm thấy tin nào.</div>';
  }
  function runPaletteItem(it) {
    if (!it) return;
    if (it.kind === 'msg') {
      closePalette();
      var el = document.getElementById('msg-' + it.id);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); location.hash = 'msg-' + it.id; }
    } else if (it.kind === 'send') {
      var sender = currentSender();
      var q = paletteInput.value.trim();
      if (['muse-a', 'muse-b', 'muse-c', 'martin'].indexOf(sender) === -1) { alert('Chọn sender trong form trước khi gửi.'); return; }
      if (!q) return;
      api('/api/msg', 'POST', { sender: sender, text: q }).then(function (r) {
        if (!r.ok) { alert('Không gửi được: ' + (r.json.error || r.status)); return; }
        closePalette();
      });
    }
  }
  if (paletteInput) {
    paletteInput.addEventListener('input', function () { renderPalette(paletteInput.value); });
    paletteInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1); paintPaletteSel(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); paintPaletteSel(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); runPaletteItem(paletteItems[paletteSel]); }
      else if (ev.key === 'Escape') { closePalette(); }
    });
  }
  if (paletteList) {
    paletteList.addEventListener('click', function (ev) {
      var d = ev.target.closest ? ev.target.closest('div[data-i]') : null;
      if (d) runPaletteItem(paletteItems[Number(d.getAttribute('data-i'))]);
    });
  }
  // ----- Phím tắt (v1.7.0): Ctrl+K palette, "/" focus ô soạn, Esc đóng -----
  document.addEventListener('keydown', function (ev) {
    var typing = ev.target && (ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT');
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) { ev.preventDefault(); openPalette(); return; }
    if (ev.key === 'Escape') { closePalette(); return; }
    if (ev.key === '/' && !typing) { ev.preventDefault(); var t = document.getElementById('compose-text'); if (t) t.focus(); }
  });
  // ----- Chỉ báo đang gõ (v1.7.0): ping tối đa 1 lần / 2s trong lúc gõ -----
  var composeText = document.getElementById('compose-text');
  var lastTypingPing = 0;
  function sendTyping(on) {
    var sender = currentSender();
    if (['muse-a', 'muse-b', 'muse-c'].indexOf(sender) === -1) return;
    api('/api/typing', 'POST', { sender: sender, typing: on }).catch(function () {});
  }
  if (composeText) {
    composeText.addEventListener('input', function () {
      var now = Date.now();
      if (now - lastTypingPing < 2000) return;
      lastTypingPing = now;
      sendTyping(true);
    });
    composeText.addEventListener('blur', function () { sendTyping(false); });
  }
  var composeForm = document.getElementById('compose-form');
  if (composeForm) composeForm.addEventListener('submit', function () { sendTyping(false); });
  // ----- Avatar presence: làm mới mỗi 60s để "x phút trước" không cũ -----
  function refreshPresence() {
    apiGet('/api/presence').then(function (j) {
      (j.presence || []).forEach(function (p) {
        var av = document.querySelector('.avatar[data-muse="' + p.muse + '"]');
        if (!av) return;
        var ago = p.online ? 'online' : (p.agoMinutes === null ? 'chưa check-in' : p.agoMinutes + ' phút trước');
        av.title = p.muse + ' — ' + ago;
        var label = av.querySelector('.avatar-label');
        if (label) label.textContent = p.muse + ' · ' + ago;
        var dot = av.querySelector('.avatar-dot');
        if (dot) dot.style.background = p.online ? '#22c55e' : '#9ca3af';
      });
    }).catch(function () {});
  }
  setInterval(refreshPresence, 60_000);
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
// v1.5.0: thêm `for=<muse>` — chỉ tin liên quan đến Muse đó (được nhắc
// @mention, được giao task, hoặc do chính Muse đó gửi) — và `unread_by=
// <muse>` — tin của người khác mà Muse đó chưa xác nhận đọc.
function filterMessages(url) {
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const sender = url.searchParams.get('sender') || '';
  const status = url.searchParams.get('status') || '';
  const assignee = url.searchParams.get('assignee') || '';
  const since = Number(url.searchParams.get('since') || 0);
  const forMuse = url.searchParams.get('for') || '';
  const unreadBy = url.searchParams.get('unread_by') || '';
  const type = url.searchParams.get('type') || '';
  return messages.filter((m) => {
    if (m.id <= since) return false;
    if (sender && m.sender !== sender) return false;
    if (q && !(String(m.text).toLowerCase().includes(q) || String(m.sender).toLowerCase().includes(q))) return false;
    if (status && m.task?.status !== status) return false;
    if (assignee && m.task?.assignee !== assignee) return false;
    if (type && m.type !== type) return false;
    if (forMuse && !((m.mentions || []).includes(forMuse) || m.task?.assignee === forMuse || m.sender === forMuse)) return false;
    if (unreadBy && (m.sender === unreadBy || (m.read_by || []).includes(unreadBy))) return false;
    return true;
  });
}

// Số tin chưa đọc của từng Muse (v1.5.0) — tin của người khác mà Muse đó
// chưa xác nhận đọc. Dùng cho /health và /api/status.
function unreadCounts() {
  const counts = {};
  for (const muse of MUSES) {
    counts[muse] = messages.filter((m) => m.sender !== muse && !(m.read_by || []).includes(muse)).length;
  }
  return counts;
}

function renderMarkdownExport(list) {
  const lines = ['# Muse Bridge — Thread export', '', `Exported: ${new Date().toISOString()}`, `Messages: ${list.length}`, ''];
  for (const m of list) {
    const task = m.task ? ` [${m.task.status || 'todo'}${m.task.assignee ? ' · ' + m.task.assignee : ''}${m.task.deadline ? ' · hạn ' + m.task.deadline : ''}]` : '';
    const meta = `${m.type ? ` [${m.type}]` : ''}${m.reply_to ? ` (trả lời #${m.reply_to})` : ''}${(m.mentions || []).length ? ` [@${m.mentions.join(' @')}]` : ''}`;
    const read = (m.read_by || []).length ? `\n*Đã đọc: ${m.read_by.join(', ')}*` : '';
    lines.push(`## #${m.id} ${m.sender}${task}${meta}`, '', `*${m.ts} · ${m.source}*${read}`, '', m.text, '');
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
      deploy: { enabled: AUTO_DEPLOY_ENABLED && Boolean(GITHUB_WEBHOOK_SECRET), branch: DEPLOY_BRANCH, lastDeployAt: deployState.lastDeployAt, lastDeploySha: deployState.lastDeploySha, lastDeployResult: deployState.lastDeployResult },
      presence: presenceStatus(),
      unread: unreadCounts(),
      summary: buildRollingSummary(),
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
      deploy: { enabled: AUTO_DEPLOY_ENABLED && Boolean(GITHUB_WEBHOOK_SECRET), branch: DEPLOY_BRANCH, lastDeployAt: deployState.lastDeployAt, lastDeploySha: deployState.lastDeploySha, lastDeployResult: deployState.lastDeployResult },
      presence: presenceStatus(),
      unread: unreadCounts(),
      summary: buildRollingSummary(),
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
      task = normalizeTask({ assignee: body.get('assignee'), status: body.get('status'), deadline: body.get('deadline') });
    } catch (e) { res.writeHead(400); return res.end(e.message); }
    recordHeartbeat(sender);
    let msg;
    try {
      msg = addMessage({ sender, text, source: 'web', task, type: body.get('type'), reply_to: body.get('reply_to') });
    } catch (e) { res.writeHead(400); return res.end(e.message); }
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
    recordHeartbeat(url.searchParams.get('sender') || '');
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
    recordHeartbeat(url.searchParams.get('sender') || '');
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

  // Auto-deploy webhook (v1.4.0): POST /webhook/github — endpoint deploy
  // riêng; /api/github-webhook (v1.3.0) cũng tự deploy khi push/PR-merge
  // vào main, nên Martin chỉ cần cấu hình 1 trong 2 URL.
  if (p === '/webhook/github' && req.method === 'POST') {
    return handleDeployWebhook(req, res);
  }

  // Auto-deploy status (v1.4.0): GET /api/deploy?token=...
  if (p === '/api/deploy' && req.method === 'GET') {
    if (!requireToken()) return;
    return json(res, 200, { ok: true, deploy: { enabled: AUTO_DEPLOY_ENABLED && Boolean(GITHUB_WEBHOOK_SECRET), branch: DEPLOY_BRANCH, repoDir: REPO_DIR, lastDeployAt: deployState.lastDeployAt, lastDeploySha: deployState.lastDeploySha, lastDeployResult: deployState.lastDeployResult } });
  }

  // Presence (v1.4.0): GET /api/presence?token=... — lần check-in cuối
  // của từng Muse.
  if (p === '/api/presence' && req.method === 'GET') {
    if (!requireToken()) return;
    return json(res, 200, { ok: true, presence: presenceStatus() });
  }

  // Typing indicator (v1.7.0): POST /api/typing {"token","sender","typing"}
  // — sender là muse-a|muse-b|muse-c báo đang soạn tin (typing=true, mặc
  // định) hoặc đã dừng (typing=false). Server broadcast SSE event typing
  // cho các tab đang mở; trạng thái tự hết hạn sau 5s không có ping mới.
  // GET /api/typing?token=... — danh sách Muse đang gõ lúc này.
  if (p === '/api/typing' && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { ok: false, error: 'rate limited' });
    let data = {};
    try { data = JSON.parse(await readBody(req)); } catch {}
    if (data.token !== BRIDGE_TOKEN) {
      if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
      return json(res, 401, { ok: false, error: 'bad token' });
    }
    if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
    if (!MUSES.includes(data.sender)) {
      return json(res, 400, { ok: false, error: 'sender must be muse-a|muse-b|muse-c' });
    }
    const typists = setTyping(data.sender, data.typing !== false);
    return json(res, 200, { ok: true, sender: data.sender, typing: data.typing !== false, typists });
  }

  if (p === '/api/typing' && req.method === 'GET') {
    if (!requireToken()) return;
    return json(res, 200, { ok: true, typing: currentTypists() });
  }

  // Catch-up digest (v1.4.0): GET /api/catchup?token=&sender=muse-a&since=12
  // — tóm tắt các tin sau since mà sender chưa đọc. Khác với
  // GET /api/digest của v1.3.0 (xem trước digest sáng theo giờ).
  if (p === '/api/catchup' && req.method === 'GET') {
    if (!requireToken()) return;
    const sender = url.searchParams.get('sender') || '';
    const since = Number(url.searchParams.get('since') || 0);
    const d = buildCatchupDigest(sender, since);
    return json(res, 200, { ok: true, sender, since, ...d });
  }

  // Tóm tắt lăn + delta (v1.6.0): GET /api/since?token=&sender=muse-c&since=12
  // — trả tóm tắt lăn của thread + toàn bộ tin mới hơn `since` + snapshot
  // task đang mở, để Muse quay lại sau thời gian dài chỉ cần 1 request
  // thay vì đọc lại cả thread. Khác GET /api/catchup (v1.4.0): catchup chỉ
  // trả 1 dòng / tin chưa đọc (tối đa 20); /api/since trả đủ nội dung tin
  // (tối đa 100) kèm summary. GET /api/messages?since= vẫn giữ nguyên
  // (chỉ lọc tin, không kèm summary). `sender` không phải 1 trong 3 Muse
  // thì unreadCount là null (vẫn trả summary + delta).
  if (p === '/api/since' && req.method === 'GET') {
    if (!requireToken()) return;
    const sender = url.searchParams.get('sender') || '';
    const since = Math.max(0, Number(url.searchParams.get('since') || 0) || 0);
    const delta = messages.filter((m) => m.id > since).slice(-100);
    const unreadCount = sender && MUSES.includes(sender)
      ? messages.filter((m) => m.sender !== sender && !(m.read_by || []).includes(sender)).length
      : null;
    const open = openTasks().map((m) => ({
      id: m.id, sender: m.sender, status: m.task.status, assignee: m.task.assignee,
      deadline: m.task.deadline || null, text: String(m.text).split('\n')[0].slice(0, 120),
    }));
    return json(res, 200, {
      ok: true, sender, since,
      latestId: messages.length ? messages[messages.length - 1].id : 0,
      summary: buildRollingSummary(), delta, unreadCount, openTasks: open,
    });
  }

  // Heartbeat + catch-up (v1.4.0): POST /api/heartbeat {"token","sender",
  // "lastSeenId"} — ghi check-in; nếu Muse quay lại sau hơn
  // PRESENCE_DIGEST_MINUTES phút thì trả kèm digest các tin chưa đọc.
  if (p === '/api/heartbeat' && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { ok: false, error: 'rate limited' });
    let data = {};
    try { data = JSON.parse(await readBody(req)); } catch {}
    if (data.token !== BRIDGE_TOKEN) {
      if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
      return json(res, 401, { ok: false, error: 'bad token' });
    }
    if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
    if (!MUSES.includes(data.sender)) {
      return json(res, 400, { ok: false, error: 'sender must be muse-a|muse-b|muse-c' });
    }
    const hb = recordHeartbeat(data.sender);
    const since = Number(data.lastSeenId || 0);
    const awayMs = hb?.prev?.lastSeen ? Date.now() - new Date(hb.prev.lastSeen).getTime() : 0;
    const digest = awayMs > PRESENCE_DIGEST_MS ? buildCatchupDigest(data.sender, since) : null;
    return json(res, 200, { ok: true, presence: presenceStatus(), wasOffline: hb?.wasOffline || false, digest, summary: buildRollingSummary() });
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
      task = normalizeTask(data.task ?? { assignee: data.assignee, status: data.status, deadline: data.deadline });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
    recordHeartbeat(data.sender);
    let msg;
    try {
      msg = addMessage({ sender: data.sender, text: String(data.text).trim(), source: 'api', task, type: data.type, reply_to: data.reply_to });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
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
    if (data.deadline !== undefined) {
      if (data.deadline === null || data.deadline === '') {
        delete next.deadline;
      } else if (Number.isNaN(Date.parse(String(data.deadline)))) {
        return json(res, 400, { ok: false, error: 'deadline must be an ISO date, e.g. 2026-11-30' });
      } else {
        next.deadline = String(data.deadline);
      }
    }
    msg.task = next;
    persistMessages();
    appendAudit({ action: 'task.update', sender: data.sender || null, messageId: msg.id, source: 'api', ip: clientIp(req) });
    return json(res, 200, { ok: true, message: msg });
  }

  // Read receipt (v1.5.0): POST /api/messages/:id/read {"token","reader"}
  // — reader là muse-a|muse-b|muse-c xác nhận đã đọc tin #id. Ghi vào
  // read_by của tin (không trùng), board hiện "Đã đọc: ...". Tin không tồn
  // tại trả 404; reader sai trả 400.
  const readPatch = p.match(/^\/api\/messages\/(\d+)\/read$/);
  if (readPatch && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { ok: false, error: 'rate limited' });
    let data = {};
    try { data = JSON.parse(await readBody(req)); } catch {}
    if (data.token !== BRIDGE_TOKEN) {
      if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
      return json(res, 401, { ok: false, error: 'bad token' });
    }
    if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
    if (!MUSES.includes(data.reader)) {
      return json(res, 400, { ok: false, error: 'reader must be muse-a|muse-b|muse-c' });
    }
    const msg = messages.find((m) => m.id === Number(readPatch[1]));
    if (!msg) return json(res, 404, { ok: false, error: 'message not found' });
    msg.read_by = msg.read_by || [];
    if (!msg.read_by.includes(data.reader)) {
      msg.read_by.push(data.reader);
      persistMessages();
      appendAudit({ action: 'message.read', sender: data.reader, messageId: msg.id, source: 'api', ip: clientIp(req) });
      broadcastMessage(msg);
    }
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
  console.log(`Auto-deploy: ${AUTO_DEPLOY_ENABLED && GITHUB_WEBHOOK_SECRET ? `BẬT — nhánh ${DEPLOY_BRANCH}, repo ${REPO_DIR}` : 'TẮT — chưa đặt GITHUB_WEBHOOK_SECRET hoặc AUTO_DEPLOY_ENABLED=0'}`);
  console.log(`Presence: offline sau ${PRESENCE_OFFLINE_MINUTES} phút, digest khi quay lại sau ${PRESENCE_DIGEST_MINUTES} phút`);
  console.log(`Mentions + read receipts: BẬT — @muse-a|muse-b|muse-c, POST /api/messages/:id/read, GET /api/messages?for= / ?unread_by=`);
  console.log(`Rolling summary + since-delta: BẬT — GET /api/since?sender=&since= (tóm tắt lăn + tin mới + task đang mở)`);
  console.log(`Board v1.7.0: panel "Có gì mới" + thao tác nhanh + command palette (Ctrl+K) + typing indicator (POST /api/typing, SSE event typing)`);
  console.log(`Telegram commands: ${TELEGRAM_COMMANDS_ENABLED ? 'BẬT' : 'TẮT'}`);
  console.log(`Digest sáng: ${DIGEST_ENABLED ? `BẬT — ${DIGEST_TIME} giờ địa phương` : 'TẮT'}`);
  if (telegramEnabled) pollTelegram();
  // Digest định kỳ: kiểm tra mỗi phút, đăng khi tới giờ (xem checkDigestDue).
  setInterval(checkDigestDue, 60_000);
  checkDigestDue();
  // Presence offline: kiểm tra mỗi phút (xem checkPresenceOffline).
  setInterval(checkPresenceOffline, 60_000);
});
