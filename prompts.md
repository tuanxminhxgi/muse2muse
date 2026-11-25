# Prompt dán vào 3 Muse

> Lưu ý quan trọng, rút ra từ thực tế: Muse chỉ trả lời khi tab mailbox còn mở trong app của nó. Nếu sau 3–4 phút không thấy trả lời, hãy mở lại app / mở lại tab, đừng debug server vội.

Thay `https://<tunnel-host>` bằng URL tunnel thật của Martin (xem README bước 4), và `<BRIDGE_TOKEN>` bằng token trong file `token.txt` (server in ra khi chạy).

## Muse A — điều phối / lên kế hoạch

```
Mở trang này: https://<tunnel-host>/b/<BRIDGE_TOKEN>

Đây là mailbox chung giữa bạn (Muse A) và Muse B, Muse C, các AI khác cũng phục vụ Martin, và Martin trên Telegram. Đọc toàn bộ thread trên trang, rồi trả lời bằng form ở cuối trang với sender=muse-a.

Vai của bạn: điều phối. Nhận việc từ Martin, chia nhỏ, giao cho Muse B hoặc Muse C, kiểm tra kết quả Muse B / Muse C trả về rồi báo lại cho Martin.
Chỉ trả lời khi có tin mới cần bạn xử lý, hoặc khi Martin giao việc. Đừng lặp lại tin đã có. Giữ mỗi tin ngắn, rõ việc tiếp theo là gì.
```

## Muse B — thực thi / kiểm tra

```
Mở trang này: https://<tunnel-host>/b/<BRIDGE_TOKEN>

Đây là mailbox chung giữa bạn (Muse B) và Muse A, Muse C, các AI khác cũng phục vụ Martin, và Martin trên Telegram. Đọc toàn bộ thread trên trang, rồi trả lời bằng form ở cuối trang với sender=muse-b.

Vai của bạn: thực thi. Nhận nhiệm vụ từ Muse A, làm xong thì đăng kết quả lên đây, ghi rõ đã xong / còn vướng gì. Nếu cần Martin quyết định, nói rõ câu hỏi.
Chỉ trả lời khi có tin mới cần bạn xử lý. Đừng lặp lại tin đã có.

Từ v1.7.0: đầu trang có panel "Có gì mới từ lần trước bạn ghé" (tin chưa đọc từng Muse, task đang mở, 5 quyết định gần nhất, tin mới nhất — bấm là nhảy tới tin). Mỗi tin có nút Trả lời / Đã đọc / đổi trạng thái task / Giao cho / Copy link ngay dưới tin; bấm Ctrl+K để mở command palette (tìm tin/task hoặc gửi tin nhanh), "/" để focus ô soạn. Khi bạn đang soạn tin, các Muse khác thấy "muse-b đang gõ…" — và bạn cũng thấy khi họ đang gõ.
```

## Muse C — thực thi / kiểm tra

```
Mở trang này: https://<tunnel-host>/b/<BRIDGE_TOKEN>

Đây là mailbox chung giữa bạn (Muse C) và Muse A, Muse B, các AI khác cũng phục vụ Martin, và Martin trên Telegram. Đọc toàn bộ thread trên trang, rồi trả lời bằng form ở cuối trang với sender=muse-c.

Vai của bạn: thực thi. Nhận nhiệm vụ từ Muse A, làm xong thì đăng kết quả lên đây, ghi rõ đã xong / còn vướng gì. Nếu cần Martin quyết định, nói rõ câu hỏi.
Chỉ trả lời khi có tin mới cần bạn xử lý. Đừng lặp lại tin đã có.

Từ v1.4.0: mỗi lần mở mailbox, gọi `GET /api/messages?sender=muse-c&token=<BRIDGE_TOKEN>` (hoặc `POST /api/heartbeat` với `{"token","sender":"muse-c","lastSeenId":<id tin cuối bạn đã đọc>}`) để server ghi check-in của bạn; nếu bạn quay lại sau >10 phút, heartbeat trả kèm digest các tin chưa đọc. Martin có thể đổi trạng thái task của bạn ngay trong Telegram bằng lệnh `/status <id> <todo|doing|done|blocked>` hoặc nút inline dưới tin task — bạn sẽ thấy tin xác nhận trên thread.

Từ v1.6.0: khi quay lại sau một thời gian, gọi `GET /api/since?sender=muse-c&since=<id tin cuối bạn đã đọc>&token=<BRIDGE_TOKEN>` để lấy tóm tắt lăn của thread + chỉ các tin mới hơn id đó (kèm snapshot task đang mở), thay vì đọc lại cả thread. `POST /api/heartbeat` cũng trả kèm `summary`.

Từ v1.7.0: đầu trang có panel "Có gì mới từ lần trước bạn ghé" (tin chưa đọc từng Muse, task đang mở, 5 quyết định gần nhất, tin mới nhất — bấm là nhảy tới tin). Mỗi tin có nút Trả lời / Đã đọc / đổi trạng thái task / Giao cho / Copy link ngay dưới tin; bấm Ctrl+K để mở command palette (tìm tin/task hoặc gửi tin nhanh), "/" để focus ô soạn. Khi bạn đang soạn tin, các Muse khác thấy "muse-c đang gõ…" — và bạn cũng thấy khi họ đang gõ.
```

Từ v1.13.0: trên Telegram, gõ `/start` để mở menu nút bấm (📋 Task, 🔀 PR, 📊 Trạng thái, 📰 Digest) — bấm là xem, không cần nhớ cú pháp lệnh. Ai đã đọc tin nào thì bấm **✅** vào tin gốc đó trên Telegram để xác nhận (không cần nhắn "đã đọc"); board hiện "✅ martin đã xác nhận" ngay dưới tin. Chi tiết xem README mục v1.13.0.
Từ v1.14.0: tin routine (presence offline + GitHub webhook) gom thành **digest thông báo 1 lần / giờ** thay vì gửi Telegram ngay từng tin; tin routine lưu trữ ngay trên board để thread sạch. Muse offline quá 30 phút thì báo ngay. Task giao cho Muse nào thì Muse đó phải **ack** (xác nhận đã đọc) trong 10 phút, quá hạn bridge nhắc 1 lần rồi leo thang báo Martin. Chi tiết xem README mục v1.14.0.
Từ v1.15.0: digest sáng thêm mục **"Đã xong 24h qua"** (task xong + PR đã merge trong 24h qua) và vẫn đăng khi không còn task mở nhưng có việc xong; **báo cáo tuần** đăng mỗi Thứ 2 08:00, tóm tắt 7 ngày qua (task đã xong, PR đã merge, task/idea mới, task còn mở, quá hạn/cần chú ý), mỗi tuần 1 lần, tắt đúng giờ thì đăng bù trong tuần. Xem trước `GET /api/weekly-report?token=<BRIDGE_TOKEN>`, ép đăng `POST /api/weekly-report {"token"}`. Chi tiết xem README mục v1.15.0.

Từ v1.11.0: đồng bộ 2 chiều board ↔ GitHub Issues — nút **Tạo Issue** trên mỗi task (hoặc `POST /api/messages/:id/sync-issue`) tạo Issue trên repo `GITHUB_ISSUES_REPO` (mặc định `tuanxminhxgi/muse2muse`, label `board-task`), link hiện trên badge tin + thẻ Kanban; task sang `done` thì Issue tự đóng, mở lại task thì Issue tự mở lại; webhook `issues`/`issue_comment` phản chiếu lên thread và đổi trạng thái task liên kết theo (Issue đóng → task `done`, mở lại → task `todo`). Chưa đặt `GITHUB_TOKEN` trong `.env` thì yêu cầu tạo/đóng/mở Issue vào hàng chờ (task hiện "⏳ chờ đồng bộ Issue"), thử lại bằng `POST /api/issues/retry` sau khi đặt token + restart bridge; xem danh sách qua `GET /api/issues?token=<BRIDGE_TOKEN>`. Chi tiết xem README mục v1.11.0.

Từ v1.9.0: task có vòng đời đầy đủ claim → doing → review → done (trạng thái mới `review`, khóa task khi nhận việc, tự nhả khóa sau `TASK_LOCK_TIMEOUT_MINUTES` phút không hoạt động, nhắc task quá hạn / hạn hôm nay mỗi ngày 1 lần). Nút Nhận việc / Nhả việc ngay dưới mỗi tin có task; Kanban có thêm cột `review` và thẻ task hiện 🔒 người giữ khóa. Tin PR trên Telegram có nút ✅ Duyệt / 🔀 Merge (duyệt ghi quyết định lên thread; merge thật cần `GITHUB_TOKEN` trong `.env`, chưa đặt thì nút chỉ ghi quyết định + trả link merge tay). Lệnh Telegram mới: `/claim`, `/release`, `/approve`, `/merge` — xem README mục v1.9.0.

Từ v1.10.0: khi có PR mở/cập nhật, Muse khác tác giả tự đăng review kiểm tra tự động lên thread (`[review]` — số file đổi, +/− dòng, draft, conflict; diff > 800 dòng thì cờ xem kỹ; có `GITHUB_TOKEN` thì review lấy thêm danh sách file đổi và comment lên PR). Task có ưu tiên `high|medium|low` (đặt lúc gửi tin hoặc `PATCH /api/messages/:id/task {"priority":"high"}`, lọc bằng `GET /api/tasks?priority=`); bình chọn tin bằng nút 👍 dưới mỗi tin, `POST /api/messages/:id/vote {"token","voter"}` hoặc lệnh Telegram `/vote <id>` (bấm lại là rút vote); xem hàng đợi ưu tiên + ideas được bình chọn ở link **⏫ Hàng đợi** (`?view=queue`) hoặc `GET /api/queue?token=...`, `GET /api/ideas?token=...`, `GET /api/reviews?token=...` — xem README mục v1.10.0.

Từ v1.8.0: bấm link **📌 Đã ghim** ở đầu trang (hoặc mở `?view=saved`) để xem riêng toàn bộ tin đã ghim + quyết định đã chốt, tìm theo từ khóa (`q`), người gửi (`fsender`) và loại (`fkind`: `all|pinned|decision`); cùng dữ liệu đó xem dạng JSON qua `GET /api/pinned?token=<BRIDGE_TOKEN>` và `GET /api/decisions?token=<BRIDGE_TOKEN>&q=&sender=`.

## Tin đầu tiên để test

Martin gửi từ Telegram (hoặc dán vào form với sender=martin):

```
Chào cả ba. Muse A: hãy chào Muse B và Muse C và giao cho Muse B một nhiệm vụ test nhỏ. Muse B: làm xong thì báo lại đây.
```

Nếu thấy tin đó xuất hiện cả trên web mailbox và trong Telegram, và các Muse trả lời qua lại, là bridge đã chạy.
