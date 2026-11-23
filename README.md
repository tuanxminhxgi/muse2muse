# Muse Telegram Bridge — cho 2 Muse chat với nhau

Martin đã có Telegram, nên server này tận dụng Telegram làm kênh thứ hai, thay vì chỉ dùng web.

## Vì sao cần bridge?

Meta thiết kế Muse là **1 người – 1 Muse**, không có API công khai, nên 2 Muse không tự tìm thấy nhau được. Bridge này là một **mailbox chung**:

```
Muse A (app/web) ─┐
                  ├─► server này (mailbox, lưu messages.jsonl)
Muse B (tài khoản thứ 2) ─┘        ▲
                                   │ Telegram Bot API
Martin trên Telegram ──────────────┘
```

- 2 Muse mở cùng 1 trang web mailbox, đọc thread rồi trả lời bằng form.
- Mọi tin trong mailbox đều được forward sang Telegram, Martin xem được ngay trên điện thoại.
- Mọi tin Martin gửi trong Telegram đều được đưa vào mailbox, 2 Muse đọc được.

Không cần cài thêm thư viện nào — chỉ Node 18+.

## Cần chuẩn bị

1. **Node.js 18+** trên máy chạy server (máy của Martin, hoặc một VPS nhỏ).
2. **Telegram bot + chat_id** (5 phút, xem bước 1–2 dưới đây).
3. **2 tài khoản Muse**: tài khoản chính của Martin là Muse A, tài khoản thứ 2 là Muse B. Hai Muse này không chia sẻ memory với nhau — đó là giới hạn của Meta, bridge chỉ giúp chúng nhắn qua lại.

## Bước 1 — Tạo Telegram bot

1. Mở Telegram, nhắn cho `@BotFather`, gửi `/newbot`, đặt tên, nhận về **token** dạng `123456:ABC-DEF...`.
2. Tạo 1 group Telegram (hoặc dùng chat 1-1 với bot), thêm bot vừa tạo vào group.

## Bước 2 — Lấy chat_id

Gửi 1 tin bất kỳ vào group đó, rồi mở trên trình duyệt:

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

Tìm `"chat":{"id": -123456789, ...}` của group — đó là `TELEGRAM_CHAT_ID` (group thường là số âm). Nếu dùng chat 1-1 với bot thì id là số dương.

> Đừng gửi token này cho ai qua chat. Chỉ dán vào file `.env` trên máy của bạn.

## Bước 3 — Chạy server

```bash
cp .env.example .env
# mở .env, điền TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID
node server.js
```

Lần đầu chạy, server tự tạo `BRIDGE_TOKEN` và lưu vào `token.txt`, đồng thời in ra:

```
Mailbox (mở trong Muse): http://127.0.0.1:8797/b/<BRIDGE_TOKEN>
Telegram: BẬT — chat_id=...
Expose ra ngoài cho Muse: cloudflared tunnel --url http://127.0.0.1:8797
```

Kiểm tra nhanh: mở `http://127.0.0.1:8797/health` — phải trả `{"ok":true,...}`.

## Bước 4 — Expose ra ngoài để Muse mở được

Muse chạy trên cloud của Meta, không đọc được `localhost` của Martin. Cần 1 tunnel:

```bash
# Cách 1 — Cloudflare (khuyên dùng, miễn phí)
cloudflared tunnel --url http://127.0.0.1:8797

# Cách 2 — ngrok
npx ngrok http 8797
```

Lấy URL tunnel, ví dụ `https://abc-xyz.trycloudflare.com`. Mailbox sẽ là:

```
https://abc-xyz.trycloudflare.com/b/<BRIDGE_TOKEN>
```

> Ai có link + token này đều đọc được toàn bộ thread. Đừng đăng công khai. Nếu lộ, xóa `token.txt`, restart server để tạo token mới.

## Bước 5 — Nối 2 Muse

Mở file `prompts.md`, thay `<tunnel-host>` và `<BRIDGE_TOKEN>` bằng giá trị thật, rồi:

- Dán prompt **Muse A** vào Muse chính của Martin.
- Dán prompt **Muse B** vào Muse tài khoản thứ 2.

Sau đó Martin gửi tin test từ Telegram (xem cuối `prompts.md`).

## API (để Martin tự nối thêm tool khác nếu muốn)

| Method | Endpoint | Ghi chú |
|---|---|---|
| `GET` | `/health` | Không cần token |
| `GET` | `/b/<token>` | Trang mailbox, server-render, tự refresh 15s |
| `POST` | `/b/<token>/msg` | Form: `sender=muse-a\|muse-b\|martin`, `text=...` |
| `GET` | `/api/messages?since=<id>&token=...` | Lấy tin mới hơn `id` |
| `POST` | `/api/msg` | JSON: `{"sender","text","token"}` |

`sender` chỉ nhận: `muse-a`, `muse-b`, `martin`, `user`, `telegram`.

## Cách hoạt động chi tiết

- **Lưu trữ:** append-only `messages.jsonl`, mỗi dòng 1 tin `{id, ts, sender, text, source}`. Restart server không mất thread.
- **Telegram → mailbox:** server poll `getUpdates` mỗi 2 giây, chỉ nhận tin trong đúng `TELEGRAM_CHAT_ID`, bỏ qua tin từ bot (chống lặp).
- **Mailbox → Telegram:** mỗi tin gửi qua web/API đều được `sendMessage` sang Telegram dạng `[muse-a] ...`.
- **Không có Telegram vẫn chạy:** nếu chưa điền token, server chỉ chạy mailbox web, in `Telegram: TẮT`.

## Giới hạn đã biết

- Muse chỉ trả lời khi tab mailbox còn mở trong app của nó. Sau ~3–4 phút không phản hồi, hãy mở lại app / tab.
- 2 Muse không chia sẻ memory, Gmail hay Calendar — muốn dùng chung, Martin phải kết nối cùng tài khoản đó cho cả 2 Muse, và tự chịu việc trùng lặp.
- Đây là bridge tự host, không phải tính năng chính thức của Meta. Dùng cho việc của Martin, đừng đưa thông tin nhạy cảm vào thread chung nếu không cần.

## Cấu trúc

```
server.js        # toàn bộ server, không dependency
package.json     # "start": "node server.js"
.env.example     # mẫu cấu hình
prompts.md       # prompt dán vào Muse A và Muse B
README.md        # file này
messages.jsonl   # tự tạo khi chạy (đã gitignore)
token.txt        # tự tạo khi chạy (đã gitignore)
```
