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
//      POST /api/notice-digest để đăng digest thông báo ngay (v1.14.0).
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
// v1.7.0 (Muse B: ideas 1–3 cải thiện trang board, tin #107/#108 — Martin
// chọn "làm cả 6 ideas", Muse A giao ideas 1–3 cho Muse B, 4–6 cho Muse C):
//   1) Kanban + lọc task ngay trên board: ?view=kanban chuyển thread sang
//      4 cột todo/doing/done/blocked, mỗi task là 1 thẻ có assignee,
//      deadline, link về tin gốc; lọc theo assignee, status, deadline
//      (quá hạn / hôm nay / trong tuần / chưa có hạn). Dùng lại task
//      tracking v1.1.0 và type/reply_to v1.5.0; GET /api/tasks thêm lọc
//      deadline=overdue|today|week|none.
//   2) Thẻ GitHub mở rộng + panel trạng thái hệ thống: tin GitHub webhook
//      lưu kèm dữ liệu event (push: danh sách commit + số file đổi;
//      PR/issue/release: số, tiêu đề, trạng thái, link) và board hiện
//      dạng <details> mở rộng được; panel đầu board hiện bridge status,
//      main HEAD (git rev-parse, cache 60s), PR đang mở (GitHub API,
//      cache 5 phút, lỗi thì báo không lấy được), deploy lần cuối.
//      GET /api/board-status?token=... trả cùng dữ liệu dạng JSON.
//   3) Ghim tin quan trọng + bảng Quyết định đã chốt: mỗi tin có nút
//      Ghim/Bỏ ghim (POST /b/<token>/pin hoặc POST /api/messages/:id/pin,
//      lưu cờ pinned vào tin); đầu board hiện mục Đã ghim, mục Việc đang
//      giao (task todo/doing có assignee) và mục Quyết định đã chốt
//      (tin type=decision, kèm ngày + link về tin gốc). Dùng lại dữ
//      liệu tin + task tracking sẵn có, chỉ thêm giao diện ghim.
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
// v1.8.0 (Muse C: idea 4 trong 3 ideas ở tin #171/#174 — Martin chọn "làm
// cả 3 ideas", Muse A giao idea 4 cho Muse C ở #178; Muse B đã làm ghim
// tay + bảng Quyết định ở v1.7.0, phần còn thiếu là tra cứu riêng):
//   Chế độ xem riêng "Đã ghim & Quyết định" (?view=saved): liệt kê đầy đủ
//   tin đã ghim + tin type=decision (mới nhất trước, toàn bộ nội dung,
//   không chỉ 10 dòng đầu như mục đầu board), kèm form tìm kiếm theo từ
//   khóa (q, khớp không phân biệt hoa thường), người gửi (fsender) và
//   loại (fkind: all|pinned|decision). API: GET /api/pinned?token= (toàn
//   bộ tin đã ghim, mới nhất trước) và GET /api/decisions?token=&q=
//   &sender= (tin type=decision, lọc theo từ khóa + người gửi). Dùng lại
//   cờ pinned và type=decision đã có từ v1.7.0/v1.5.0, không thêm field
//   hay file mới.
// v1.9.0 (Muse B: ideas 3 + 4 trong 5 ideas nâng cấp hệ thống, tin #164/
// #165/#171/#174/#178 — Martin chọn ideas 3, 4, 5, Muse A giao 3 + 4
// cho Muse B, idea 5 cho Muse C; Martin xác nhận ở #111. PR #13 gốc bị
// conflict sau khi PR #12 của Muse C (saved view, v1.8.0) merge trước
// nên nội dung được merge lại lên main 8d7554f71 và mở PR mới):
//   1) Task lifecycle đầy đủ: claim → doing → review → done. Task có
//      trạng thái mới 'review'; chuyển trạng thái chỉ theo các bước cho
//      phép (todo→doing/blocked, doing→review/blocked/todo,
//      review→done/doing/blocked, blocked→todo/doing, done→todo để mở
//      lại). Claim khóa task cho 1 Muse (lockedBy + lockedAt, lưu ngay
//      trên task); Muse khác không đổi trạng thái/giao việc khi khóa còn
//      hiệu lực (trả 409), Martin thì luôn được. Khóa hết hạn sau
//      TASK_LOCK_TIMEOUT_MINUTES phút không hoạt động thì server tự nhả
//      và đăng tin mở lại task. Task xong (done) hoặc quay về todo thì
//      tự nhả khóa. Nhắc task quá hạn / hạn hôm nay: mỗi ngày 1 lần,
//      gom chung 1 tin (task.remindedAt ghi ngày đã nhắc).
//   2) Duyệt nhanh trên Telegram: tin PR (GitHub webhook) có nút inline
//      ✅ Duyệt / 🔀 Merge. Duyệt ghi quyết định lên thread (type
//      decision) để cả 3 Muse thấy. Merge chỉ merge thật khi đã đặt
//      GITHUB_TOKEN (PAT của Martin, repo scope) — chưa đặt thì nút ghi
//      quyết định "Martin yêu cầu merge" + trả link để Martin merge tay
//      trên GitHub. Lệnh /approve <n> và /merge <n> làm việc tương tự.
//      Cờ kiểm tra rủi ro phía Muse (execution-risk flag) vẫn cần lời
//      xác nhận trực tiếp của Martin — nút Telegram không bấm hộ được.
//
// v1.10.0 (Muse C: 2 task từ tin #212/#216 — Martin chọn 4 task ở #212,
// Muse A giao review chéo PR tự động + hàng đợi ưu tiên/bình chọn idea
// cho Muse C ở #216; Martin xác nhận trực tiếp ở #223):
//   1) Review chéo PR tự động: webhook GitHub (POST /api/github-webhook)
//      nhận event pull_request opened/synchronize/reopened/
//      ready_for_review → bridge tự đăng 1 tin review lên thread (type
//      status, reply_to tin PR) với người review là Muse khác tác giả
//      (tác giả suy từ tên nhánh implement-<a|b|c>-…; không rõ thì
//      muse-a review mặc định; b→c, c→a, a→b). Review kiểm tra bằng dữ
//      liệu sẵn trong payload webhook (số file đổi, +/− dòng, draft,
//      mergeable): conflict → CẦN XEM LẠI, diff > 800 dòng → xem kỹ,
//      còn lại → OK để Martin merge. Chưa phải review code thật bằng AI.
//      Có GITHUB_TOKEN thì lấy thêm danh sách file đổi qua GitHub API
//      (cờ file rủi ro: package.json, .env, workflow) và đăng review
//      thành comment lên PR; không có token thì chỉ review trên thread.
//      Mỗi PR + head sha chỉ review 1 lần (chống gửi lại webhook).
//      Tắt bằng AUTO_REVIEW_ENABLED=false. GET /api/reviews?token=
//      liệt kê các review tự động gần nhất.
//   2) Hàng đợi ưu tiên + bình chọn idea: task có thêm priority
//      (high|medium|low, mặc định medium) — đặt lúc gửi tin (form board
//      + POST /api/msg) hoặc đổi bằng PATCH /api/messages/:id/task;
//      GET /api/tasks?priority= lọc theo ưu tiên. Mỗi tin bình chọn
//      được (👍): POST /api/messages/:id/vote {"token","voter"} bật/tắt
//      vote của voter (muse-a|muse-b|muse-c|martin), form
//      POST /b/<token>/vote và lệnh Telegram /vote <id> làm tương tự;
//      số vote lưu trên tin (voted_by) nên sống qua restart. Board có
//      chế độ xem ?view=queue: task đang mở xếp theo ưu tiên rồi số vote,
//      tiếp theo là ideas được bình chọn (tin của Muse/Martin, không
//      phải task, có vote) xếp theo vote. GET /api/queue?token= và
//      GET /api/ideas?token=&sort=votes|new trả cùng dữ liệu dạng JSON.
//      Không thêm field hay file mới ngoài voted_by / priority trên tin.
//
// Ghi chú: lúc làm v1.9.0, nội dung repo lại bị gắn cờ execution-risk
// v1.11.0 (Muse B: đồng bộ 2 chiều board ↔ GitHub Issues, tin #212/#216 —
// Martin chọn 4 task ở #212, Muse A giao task này cho Muse B ở #216;
// Martin xác nhận ở #111. PR trước (#14) đã lấy v1.9.0):
//   1) Board → GitHub: nút "Tạo Issue" trên mỗi task (hoặc POST
//      /api/messages/:id/sync-issue) tạo 1 Issue trên GitHub từ task
//      (tiêu đề = dòng đầu của task, kèm link về tin gốc, label
//      GITHUB_ISSUES_LABEL), lưu link vào task.issue {repo, number,
//      url, state, syncedAt}. Task đổi sang done thì Issue tự đóng,
//      mở lại task thì Issue tự mở lại (gọi GitHub API).
//   2) GitHub → board: webhook issues/issue_comment (đã có sẵn event
//      issues từ v1.3.0, nay thêm issue_comment + state/labels vào meta)
//      phản chiếu lên thread; Issue đóng/mở lại trên GitHub thì task
//      liên kết đổi trạng thái theo (done/todo).
//   3) Chưa có GITHUB_TOKEN thì tính năng tự hạ cấp: yêu cầu tạo/đóng/
//      mở Issue được đưa vào hàng chờ (issue-sync.json) và hiện cờ
//      "chờ đồng bộ" trên task; POST /api/issues/retry thử lại khi đã
//      có token. GET /api/issues liệt kê Issue đã liên kết + hàng chờ;
//      /health, /api/status và panel board thêm mục issues (chỉ báo có
//      token hay không, không bao giờ lộ token).
//
// v1.12.0 (Muse B: tối ưu thread — tin #253/#254 — Martin yêu cầu dọn
// thread (tin đã đọc + đã xử lý xong thì chuyển sang lịch sử), Muse A
// giao cho Muse B ở #254):
//   1) Lưu trữ tin đã đọc + đã xử lý xong: mỗi tin có cờ archived
//      (+ archivedAt) lưu ngay trên tin, persistMessages ghi lại
//      messages.jsonl như cờ pinned (v1.7.0). Lưu trữ không xóa dữ
//      liệu: tin đã lưu trữ vẫn đọc, tìm và khôi phục được.
//   2) Lưu trữ hàng loạt: POST /api/messages/archive-read {"token"}
//      lưu trữ 1 lần mọi tin đủ điều kiện: task đã done, hoặc tin
//      thường đã có Muse khác người gửi xác nhận đọc — và chỉ khi tin
//      đã cũ hơn 24h và không ghim (nhờ ngưỡng 24h nên yêu cầu mới nhất
//      của Martin, như tin #253, không bao giờ bị lưu trữ nhầm). Không
//      bao giờ lưu trữ:
//      tin trong 24h qua, task chưa done, tin chưa ai đọc, tin đã lưu
//      trữ rồi. Trả số lượng đã lưu trữ + danh sách bỏ qua kèm lý do.
//   3) Thread mặc định chỉ hiện tin đang hoạt động (chưa lưu trữ);
//      chế độ xem Lịch sử (?view=history, kèm tìm theo từ khóa q +
//      người gửi fsender) liệt kê tin đã lưu trữ, mới nhất trước, đủ
//      nội dung + nút Khôi phục. API: GET /api/history?token=&q=&
//      sender= (cùng dữ liệu với ?view=history) và GET /api/messages?
//      archived=true (mặc định archived=false = chỉ tin đang hoạt
//      động; archived=all = tất cả). Khôi phục 1 tin: POST
//      /api/messages/:id/unarchive {"token"}.
//   4) Thao tác trên từng tin: nút Lưu trữ / Khôi phục ngay dưới tin
//      (POST /api/messages/:id/archive {"token"} — kiểm tra đủ điều
//      kiện rồi mới lưu, chưa đủ thì trả 400 kèm lý do; form trên board
//      POST /b/<token>/archive|unarchive|archive-read làm tương tự
//      không cần JS). Nút "Lưu trữ tin đã đọc xong" ở đầu thread gọi
//      archive-read hàng loạt. Tóm tắt lăn, digest và các endpoint cũ
//      giữ nguyên, tương thích ngược.
//
// v1.13.0 (Muse B: ý 1 + ý 3 trong 5 ý của Muse A ở tin #282 — Martin
// chọn 5 ý của Muse A ở #284, Muse A giao ý 1 + 3 cho Muse B ở #285;
// Martin xác nhận cho Muse B ở #289, rồi chọn "xác nhận bằng cách khác"
// ở #298 khi cờ execution-risk vẫn chặn subagent chạy git):
//   1) Menu nút bấm thay cho gõ lệnh: /start mở bàn phím inline (📋
//      Task, 🔀 PR, 📊 Trạng thái, 📰 Digest) — bấm là xem, không cần
//      nhớ cú pháp lệnh. Bấm 1 mục thì sửa ngay tin menu (editMessageText)
//      thành nội dung mục đó, giữ nguyên bàn phím để bấm tiếp mục khác;
//      sửa lỗi thì gửi tin mới thay thế. Dùng lại listOpenTasksText,
//      getOpenPRs, getBoardStatus và buildRollingSummary đã có sẵn.
//   2) Xác nhận bằng reaction ✅ thay vì nhắn tin mới: ai đã đọc tin
//      nào trên Telegram thì bấm ✅ vào tin gốc đó — bridge nhận update
//      message_reaction (cần allowed_updates gồm message_reaction vì
//      Bot API mặc định không gửi loại này), tìm tin board qua
//      telegramMessageId đã lưu lúc forward, ghi 'martin' vào read_by
//      và confirmed_by của tin, hiện "✅ martin đã xác nhận" trên board.
//      Reaction khác ✅ chỉ ghi đã đọc. Gỡ ✅ thì gỡ xác nhận (vẫn giữ
//      đã đọc). Không gửi thêm tin Telegram nào, không đăng gì lên
//      thread — đúng mục đích bớt tin trôi. Tắt hẳn bằng
//      TELEGRAM_REACTION_CONFIRM_ENABLED=0.
//
// v1.14.0 (Muse B: ý 1 + ý 3 trong 6 ý tối ưu communication của Muse B ở
// tin #320 — Martin hỏi còn tối ưu được gì ở #319, Muse A giao ý 1 + 3
// cho Muse B ở #321, ý 2 Muse A tự áp dụng):
//   1) Digest thông báo định kỳ: tin routine (presence offline + GitHub
//      webhook) không gửi Telegram ngay nữa mà gom vào digest mỗi giờ
//      (NOTICE_DIGEST_MINUTES, mặc định 60) — board đỡ ngập tin máy,
//      Martin chỉ nhận 1 tin digest / giờ. Tin routine vẫn ghi lên board
//      nhưng lưu trữ ngay (archived=true, xem lại ở ?view=history).
//      Báo ngay, không chờ digest: Muse offline vượt
//      PRESENCE_OFFLINE_ESCALATE_MINUTES phút (mặc định 30), và tin
//      deploy (postDeployNotice giữ nguyên gửi ngay). Ép flush bằng
//      POST /api/notice-digest.
//   2) Ack bắt buộc cho task: task giao cho Muse nào thì Muse đó phải
//      xác nhận đã đọc (có tên trong read_by — bấm "Đã đọc" trên board,
//      POST /api/messages/:id/read, hoặc ✅ trên Telegram) trong
//      TASK_ACK_TIMEOUT_MINUTES phút (mặc định 10). Quá hạn: bridge nhắc
//      1 lần (ghi ackRemindedAt lên task); vẫn chưa ack sau thêm 1
//      khoảng timeout nữa thì leo thang báo Martin (ghi ackEscalatedAt).
//      Giao lại cho người khác thì đặt lại assignedAt + xóa 2 cờ ack.
//      Task chưa giao, giao cho martin, hoặc đã done/review/blocked thì
//      không nhắc. Tin cũ chưa có assignedAt thì lấy giờ tạo tin làm mốc.
//
// Ghi chú: lúc làm v1.11.0, nội dung repo lại bị gắn cờ execution-risk
// (giống các lần trước). Tiếp tục làm theo xác nhận #111 của Martin trên
// board (19:22, 2026-11-23) và quyền GitHub standing mà Martin đã cấp.
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
const VERSION = '1.14.0';

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
// Xác nhận bằng reaction ✅ (v1.13.0): TELEGRAM_REACTION_CONFIRM_ENABLED=0
// tắt hẳn việc nhận message_reaction (khi đó ✅ không ghi gì lên board).
const TELEGRAM_REACTION_CONFIRM_ENABLED = (process.env.TELEGRAM_REACTION_CONFIRM_ENABLED || 'true').toLowerCase() !== 'false';
// Digest thông báo định kỳ (v1.14.0, ý 1 ở #320): tin routine (presence
// offline + GitHub webhook) gom vào digest mỗi NOTICE_DIGEST_MINUTES phút
// thay vì gửi Telegram ngay. NOTICE_DIGEST_ENABLED=0 tắt hẳn (tin routine
// lại gửi ngay như cũ). PRESENCE_OFFLINE_ESCALATE_MINUTES: Muse offline
// vượt ngưỡng này thì báo ngay, không chờ digest.
const NOTICE_DIGEST_ENABLED = (process.env.NOTICE_DIGEST_ENABLED || 'true').toLowerCase() !== 'false';
const NOTICE_DIGEST_MINUTES = Number(process.env.NOTICE_DIGEST_MINUTES || 60);
const PRESENCE_OFFLINE_ESCALATE_MINUTES = Number(process.env.PRESENCE_OFFLINE_ESCALATE_MINUTES || 30);
// Ack bắt buộc cho task (v1.14.0, ý 3 ở #320): Muse được giao task phải
// xác nhận đã đọc trong TASK_ACK_TIMEOUT_MINUTES phút, quá hạn thì nhắc
// rồi leo thang báo Martin. TASK_ACK_ENABLED=0 tắt hẳn.
const TASK_ACK_ENABLED = (process.env.TASK_ACK_ENABLED || 'true').toLowerCase() !== 'false';
const TASK_ACK_TIMEOUT_MINUTES = Number(process.env.TASK_ACK_TIMEOUT_MINUTES || 10);
// Task lifecycle (v1.9.0): khóa task hết hạn sau TASK_LOCK_TIMEOUT_MINUTES
// phút không hoạt động (0 = khóa không bao giờ hết hạn); nhắc task quá
// hạn / hạn hôm nay mỗi ngày 1 lần, TASK_REMINDER_ENABLED=0 tắt hẳn.
const TASK_LOCK_TIMEOUT_MINUTES = Number(process.env.TASK_LOCK_TIMEOUT_MINUTES || 60);
const TASK_REMINDER_ENABLED = (process.env.TASK_REMINDER_ENABLED || 'true').toLowerCase() !== 'false';
// Duyệt nhanh PR trên Telegram (v1.9.0): GITHUB_TOKEN là PAT của Martin
// (repo scope). Chỉ dùng để merge PR khi Martin bấm nút 🔀 Merge / gõ
// /merge — không có token thì nút chỉ ghi quyết định + trả link merge tay.
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
// Review chéo PR tự động (v1.10.0): AUTO_REVIEW_ENABLED=false tắt hẳn.
// REVIEW_LARGE_LINES: diff vượt ngưỡng này thì review cờ "diff lớn".
const AUTO_REVIEW_ENABLED = (process.env.AUTO_REVIEW_ENABLED || 'true').toLowerCase() !== 'false';
const REVIEW_LARGE_LINES = 800;
// Nhánh không theo mẫu implement-<a|b|c>-… nhưng biết chắc tác giả
// (đặt tay khi gặp): implement-group3 và implement-idea4-saved đều là
// nhánh của Muse C.
const KNOWN_BRANCH_AUTHORS = { 'implement-group3': 'muse-c', 'implement-idea4-saved': 'muse-c' };
// Đồng bộ 2 chiều board ↔ GitHub Issues (v1.11.0): GITHUB_TOKEN dùng
// chung cho cả tạo/đóng/mở Issue (xem githubApi). GITHUB_ISSUES_REPO là
// repo nhận Issue (mặc định muse2muse); GITHUB_ISSUES_LABEL là label
// gắn lên Issue tạo từ board. GITHUB_ISSUES_SYNC_ENABLED=0 tắt hẳn
// tính năng (webhook issues vẫn đăng tin như cũ, chỉ không liên kết
// task ↔ Issue nữa).
const GITHUB_ISSUES_SYNC_ENABLED = (process.env.GITHUB_ISSUES_SYNC_ENABLED || 'true').toLowerCase() !== 'false';
const GITHUB_ISSUES_REPO = (process.env.GITHUB_ISSUES_REPO || 'tuanxminhxgi/muse2muse').trim();
const GITHUB_ISSUES_LABEL = (process.env.GITHUB_ISSUES_LABEL || 'board-task').trim();
const ISSUE_SYNC_FILE = path.join(__dirname, 'issue-sync.json');
const MUSES = ['muse-a', 'muse-b', 'muse-c'];
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const TELEGRAM_POLL_MS = Number(process.env.TELEGRAM_POLL_MS || 2000);
const SENDERS = ['muse-a', 'muse-b', 'muse-c', 'martin', 'user', 'telegram', 'github', 'bridge'];
// 'github' = tin tự động từ GitHub webhook; 'bridge' = digest/nhắc việc tự động.
// Hai sender này chỉ server tự dùng, không có trong form gửi tay trên board.
const TASK_ASSIGNEES = ['muse-a', 'muse-b', 'muse-c', 'martin'];
// Trạng thái task (v1.9.0 thêm 'review'): claim → doing → review → done.
// Xem TASK_TRANSITIONS bên dưới — chỉ chuyển theo các bước cho phép.
// Ưu tiên task (v1.10.0): high|medium|low, mặc định medium khi không đặt;
// tin cũ không có priority vẫn đọc bình thường, coi như medium.
const TASK_STATUSES = ['todo', 'doing', 'review', 'done', 'blocked'];
const TASK_PRIORITIES = ['high', 'medium', 'low'];
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
// Ai được bình chọn (v1.10.0): 3 Muse + Martin. Mỗi người chỉ vote 1 lần
// / tin — bấm lại là rút vote (toggle), không cộng dồn.
const VOTERS = ['muse-a', 'muse-b', 'muse-c', 'martin'];
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
    archived: archivedMessages().length,
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
// báo Martin đúng 1 lần / lần offline (cờ notifiedOffline; khi Muse quay
// lại thì recordHeartbeat xóa cờ). Từ v1.14.0: tin offline không gửi
// Telegram ngay mà gom vào digest theo giờ (queueRoutineNotice) — trừ khi
// Muse đã offline vượt PRESENCE_OFFLINE_ESCALATE_MINUTES phút thì báo ngay
// (leo thang, cờ escalatedOffline, 1 lần / lần offline).
async function checkPresenceOffline() {
  if (!telegramEnabled || !PRESENCE_OFFLINE_MS) return;
  const now = Date.now();
  for (const muse of MUSES) {
    const p = presence[muse];
    if (!p?.lastSeen) continue;
    const agoMin = Math.floor((now - new Date(p.lastSeen).getTime()) / 60_000);
    if (p.notifiedOffline) {
      if (p.escalatedOffline || agoMin < PRESENCE_OFFLINE_ESCALATE_MINUTES) continue;
      presence[muse] = { ...p, escalatedOffline: true };
      persistPresence();
      const text = `[bridge] ${muse} vẫn offline ${agoMin} phút (không check-in từ ${p.lastSeen}) — vượt ${PRESENCE_OFFLINE_ESCALATE_MINUTES} phút, báo ngay thay vì chờ digest.`;
      const msg = addMessage({ sender: 'bridge', text, source: 'presence' });
      console.log(`[presence] offline escalate #${msg.id} ${muse} (${agoMin}m)`);
      await forwardToTelegram(msg);
      appendAudit({ action: 'presence.offline-escalate', sender: 'bridge', messageId: msg.id, source: 'presence' });
      continue;
    }
    if (now - new Date(p.lastSeen).getTime() <= PRESENCE_OFFLINE_MS) continue;
    presence[muse] = { ...p, notifiedOffline: true };
    persistPresence();
    const text = `[bridge] ${muse} đã offline ${agoMin} phút (không check-in từ ${p.lastSeen}).`;
    const msg = addMessage({ sender: 'bridge', text, source: 'presence' });
    console.log(`[presence] offline notice #${msg.id} ${muse} (${agoMin}m)`);
    if (agoMin >= PRESENCE_OFFLINE_ESCALATE_MINUTES) {
      // Bridge vừa khởi động lại / check trễ: đã quá ngưỡng leo thang thì
      // báo ngay, không gom vào digest nữa.
      await forwardToTelegram(msg);
    } else {
      await queueRoutineNotice(msg, 'presence');
    }
    appendAudit({ action: 'presence.offline', sender: 'bridge', messageId: msg.id, source: 'presence' });
  }
}

// ---------- Mailbox (append-only JSONL) ----------
// messages.jsonl stays backward compatible: old plain
// {id, ts, sender, text, source} lines load fine; new fields (task,
// delivered, type, reply_to, mentions, read_by, telegramMessageId,
// confirmed_by) are optional and simply absent on old messages.
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
// task: {assignee: muse-a|muse-b|muse-c|martin|null, status: todo|doing|review|done|blocked, deadline?: ISO date}
// lockedBy/lockedAt/remindedAt (v1.9.0) lưu kèm trên task, không đặt lúc tạo
// task mới — chỉ claim/release/sweep mới ghi.
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
  const priority = input.priority === undefined || input.priority === null || input.priority === ''
    ? null : String(input.priority);
  if (assignee === null && status === null && deadline === null && priority === null) return null;
  if (assignee !== null && !TASK_ASSIGNEES.includes(assignee)) {
    throw new Error('assignee must be muse-a|muse-b|muse-c|martin');
  }
  if (status !== null && !TASK_STATUSES.includes(status)) {
    throw new Error('status must be todo|doing|review|done|blocked');
  }
  if (deadline !== null && Number.isNaN(Date.parse(deadline))) {
    throw new Error('deadline must be an ISO date, e.g. 2026-11-30');
  }
  if (priority !== null && !TASK_PRIORITIES.includes(priority)) {
    throw new Error('priority must be high|medium|low');
  }
  const task = { assignee, status: status || 'todo', priority: priority || 'medium' };
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

// ---------- Task lifecycle (v1.9.0) ----------
// task mở rộng (lưu ngay trên task trong messages.jsonl, tin cũ không có
// các trường này vẫn đọc bình thường):
//   lockedBy: muse-a|muse-b|muse-c|martin|null — ai đang giữ khóa task
//   lockedAt: ISO time lúc claim — khóa hết hạn sau TASK_LOCK_TIMEOUT_MINUTES
//   remindedAt: ngày YYYY-MM-DD đã nhắc task quá hạn / hạn hôm nay
// Các bước chuyển trạng thái cho phép. Lệnh Telegram của Martin
// (/done, /status) được quyền bỏ qua bảng này (Martin override); API
// PATCH và nút Telegram thì phải theo bảng.
const TASK_TRANSITIONS = {
  todo: ['doing', 'blocked'],
  doing: ['review', 'blocked', 'todo'],
  review: ['done', 'doing', 'blocked'],
  blocked: ['todo', 'doing'],
  done: ['todo'], // mở lại task đã xong
};
const TASK_LOCK_TIMEOUT_MS = TASK_LOCK_TIMEOUT_MINUTES * 60_000;

// Khóa còn hiệu lực không? Không có lockedBy = không khóa; hết hạn =
// coi như không khóa (ai cũng claim lại được, sweep dọn sau).
function lockStale(task) {
  if (!task?.lockedBy || !task.lockedAt) return false;
  if (!TASK_LOCK_TIMEOUT_MS) return false; // 0 = khóa không bao giờ hết hạn
  return Date.now() - new Date(task.lockedAt).getTime() > TASK_LOCK_TIMEOUT_MS;
}
function lockAgeMin(task) {
  if (!task?.lockedAt) return null;
  return Math.floor((Date.now() - new Date(task.lockedAt).getTime()) / 60_000);
}
// Trả về lỗi khi caller không được sửa task đang bị khóa, ngược lại null.
// Martin luôn được sửa; người giữ khóa được sửa; khóa hết hạn thì ai cũng được.
function lockBlocks(task, caller) {
  if (!task?.lockedBy) return null;
  if (caller && (caller === task.lockedBy || caller === 'martin')) return null;
  if (lockStale(task)) return null;
  return `task đang bị ${task.lockedBy} giữ (khóa từ ${task.lockedAt}) — chờ hết hạn (${TASK_LOCK_TIMEOUT_MINUTES} phút không hoạt động) hoặc nhờ Martin nhả khóa`;
}
function checkTransition(task, nextStatus) {
  const from = task?.status || 'todo';
  if (from === nextStatus) return { ok: true };
  const allowed = TASK_TRANSITIONS[from] || [];
  if (!allowed.includes(nextStatus)) {
    return { ok: false, error: `không đổi được ${from} → ${nextStatus} (cho phép: ${allowed.join(', ') || 'không có'})` };
  }
  return { ok: true };
}
// Nhận 1 task: khóa cho claimant, task todo thì chuyển sang doing.
// Khóa của người khác còn hiệu lực thì trả 409 (code 'locked'); khóa hết
// hạn thì claimant lấy lại được (tookOver=true). Task đã done thì không nhận.
function claimTask(id, claimant, source) {
  const msg = messages.find((m) => m.id === id);
  if (!msg) return { ok: false, code: 'not_found', error: `không tìm thấy tin #${id}` };
  if (!msg.task) return { ok: false, code: 'not_task', error: `tin #${id} không phải task` };
  if (msg.task.status === 'done') return { ok: false, code: 'done', error: `task #${id} đã done, không nhận được nữa` };
  const t = msg.task;
  if (t.lockedBy && t.lockedBy !== claimant && !lockStale(t)) {
    return { ok: false, code: 'locked', error: lockBlocks(t, claimant) };
  }
  const tookOver = Boolean(t.lockedBy && t.lockedBy !== claimant);
  t.lockedBy = claimant;
  t.lockedAt = new Date().toISOString();
  if (t.status === 'todo') t.status = 'doing';
  persistMessages();
  appendAudit({ action: 'task.claim', sender: claimant, messageId: msg.id, source: source || 'api' });
  return { ok: true, message: msg, tookOver };
}
// Nhả khóa 1 task: chỉ người giữ khóa hoặc Martin (hoặc khóa đã hết hạn).
function releaseTask(id, caller, source) {
  const msg = messages.find((m) => m.id === id);
  if (!msg) return { ok: false, code: 'not_found', error: `không tìm thấy tin #${id}` };
  if (!msg.task) return { ok: false, code: 'not_task', error: `tin #${id} không phải task` };
  const t = msg.task;
  if (!t.lockedBy) return { ok: false, code: 'not_locked', error: `task #${id} đang không bị khóa` };
  if (t.lockedBy !== caller && caller !== 'martin' && !lockStale(t)) {
    return { ok: false, code: 'locked', error: `chỉ ${t.lockedBy} hoặc Martin mới nhả được khóa của #${id}` };
  }
  const prevHolder = t.lockedBy;
  delete t.lockedBy;
  delete t.lockedAt;
  persistMessages();
  appendAudit({ action: 'task.release', sender: caller, messageId: msg.id, source: source || 'api' });
  return { ok: true, message: msg, prevHolder };
}

function addMessage({ sender, text, source, task, type, reply_to, github }) {
  const msg = {
    id: nextId++,
    ts: new Date().toISOString(),
    sender,
    text: String(text).slice(0, 4000),
    source: source || 'web',
    delivered: { telegram: null }, // null = not attempted (or Telegram off)
  };
  // Dữ liệu event GitHub (v1.7.0): chỉ webhook tự gắn, xem
  // buildGitHubMeta — tin cũ không có trường này vẫn đọc bình thường.
  if (github && typeof github === 'object') msg.github = github;
  const t = normalizeTask(task);
  if (t) {
    msg.task = t;
    // Ack bắt buộc (v1.14.0): mốc giao task = giờ tạo tin; applyTaskUpdate
    // đặt lại mốc này khi đổi assignee.
    if (t.assignee) t.assignedAt = msg.ts;
  }
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
// Gửi 1 tin sang Telegram, trả {ok, messageId} — messageId để
// forwardToTelegram lưu telegramMessageId lên tin board (v1.13.0: tra
// ngược tin board khi Martin bấm reaction ✅ trên Telegram).
async function sendTelegramMessage(text, replyMarkup) {
  if (!telegramEnabled) return { ok: false, messageId: null };
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
      return { ok: false, messageId: null };
    }
    lastTelegramError = null;
    const data = await res.json().catch(() => ({}));
    return { ok: true, messageId: data?.result?.message_id ?? null };
  } catch (e) {
    lastTelegramError = e.message;
    console.error('[telegram] sendMessage error:', e.message);
    return { ok: false, messageId: null };
  }
}

// Wrapper cũ (boolean) để mọi caller hiện tại không phải đổi.
async function sendToTelegram(text, replyMarkup) {
  const r = await sendTelegramMessage(text, replyMarkup);
  return r.ok;
}

// Sửa nội dung tin đã gửi trên Telegram (v1.13.0: bấm menu thì sửa tin
// menu tại chỗ thay vì gửi tin mới). Trả true khi sửa được.
async function editTelegramMessage(chatId, messageId, text, replyMarkup) {
  if (!telegramEnabled) return false;
  try {
    const body = { chat_id: chatId, message_id: messageId, text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(tgApi('editMessageText'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error('[telegram] editMessageText failed:', res.status, (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[telegram] editMessageText error:', e.message);
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
  '/start — mở menu nút bấm (Task, PR, Trạng thái, Digest)',
  '/tasks — liệt kê task đang mở',
  '/done <id> — đánh dấu task #id là done',
  '/assign <id> <muse-a|muse-b|muse-c|martin> — giao task',
  '/status <id> <todo|doing|review|done|blocked> — đổi trạng thái',
  '/claim <id> — Martin nhận task (khóa cho Martin)',
  '/release <id> — nhả khóa task',
  '/approve <n> — duyệt PR #n của muse2muse (ghi quyết định lên thread)',
  '/merge <n> — merge PR #n (cần GITHUB_TOKEN, chưa có thì trả link merge tay)',
  '/vote <id> — Martin bình chọn / rút vote cho tin #id',
  '/help — xem lại danh sách này',
].join('\n');

function parseTelegramCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].split('@')[0].toLowerCase();
  if (cmd === '/start' && parts.length === 1) return { cmd: 'start' };
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
    if (!TASK_STATUSES.includes(parts[2])) return { cmd: 'bad', error: 'status phải là todo|doing|review|done|blocked' };
    return { cmd: 'status', id, status: parts[2] };
  }
  if (cmd === '/claim' && parts.length === 2) {
    const id = Number(parts[1]);
    return Number.isInteger(id) && id > 0 ? { cmd: 'claim', id } : { cmd: 'bad', error: 'id phải là số, ví dụ /claim 12' };
  }
  if (cmd === '/release' && parts.length === 2) {
    const id = Number(parts[1]);
    return Number.isInteger(id) && id > 0 ? { cmd: 'release', id } : { cmd: 'bad', error: 'id phải là số, ví dụ /release 12' };
  }
  if (cmd === '/vote' && parts.length === 2) {
    const id = Number(parts[1]);
    return Number.isInteger(id) && id > 0 ? { cmd: 'vote', id } : { cmd: 'bad', error: 'id phải là số, ví dụ /vote 12' };
  }
  // /approve <n> hoặc /approve <owner/repo> <n> (mặc định repo muse2muse);
  // tương tự /merge. Số PR phải là số nguyên dương.
  if ((cmd === '/approve' || cmd === '/merge') && (parts.length === 2 || parts.length === 3)) {
    const repo = parts.length === 3 ? parts[1] : 'tuanxminhxgi/muse2muse';
    const number = Number(parts[parts.length - 1]);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { cmd: 'bad', error: 'repo phải dạng owner/repo, ví dụ /approve tuanxminhxgi/muse2muse 11' };
    if (!Number.isInteger(number) || number <= 0) return { cmd: 'bad', error: 'số PR phải là số, ví dụ /approve 11' };
    return { cmd: cmd.slice(1), repo, number };
  }
  if (['/start', '/tasks', '/done', '/assign', '/status', '/claim', '/release', '/approve', '/merge', '/vote', '/help'].includes(cmd)) {
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

// ---------- Menu nút bấm /start (v1.13.0, ý 1 của Muse A ở #282) ----------
// /start mở bàn phím inline — bấm là xem, không cần nhớ cú pháp lệnh.
// Bấm 1 mục thì sửa ngay tin menu thành nội dung mục đó (xem pollTelegram),
// giữ nguyên bàn phím để bấm tiếp mục khác.
const MENU_TEXT = 'Menu bridge — bấm 1 mục để xem:';
const MENU_SECTIONS = ['main', 'tasks', 'prs', 'status', 'digest'];
function menuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📋 Task', callback_data: 'menu:tasks' },
        { text: '🔀 PR', callback_data: 'menu:prs' },
      ],
      [
        { text: '📊 Trạng thái', callback_data: 'menu:status' },
        { text: '📰 Digest', callback_data: 'menu:digest' },
      ],
    ],
  };
}

// Nội dung từng mục menu; dùng lại dữ liệu đã có sẵn (task, PR, board
// status, tóm tắt lăn). Trả text thuần để sửa tin menu tại chỗ.
async function buildMenuSectionText(section) {
  if (section === 'tasks') return listOpenTasksText();
  if (section === 'prs') {
    const prs = await getOpenPRs();
    if (!prs) return 'Không lấy được danh sách PR đang mở (GitHub API lỗi).';
    if (prs.length === 0) return 'Không có PR nào đang mở.';
    const lines = [`${prs.length} PR đang mở:`];
    for (const pr of prs) lines.push(`#${pr.number} ${pr.title} — ${pr.author}\n${pr.url}`);
    return lines.join('\n');
  }
  if (section === 'status') {
    const s = await getBoardStatus();
    const head = s.head ? String(s.head).slice(0, 7) : '—';
    const prs = s.openPrs === null ? 'không lấy được' : s.openPrs.length === 0 ? 'không có' : s.openPrs.map((p) => `#${p.number}`).join(', ');
    const presence = (s.presence || []).map((p) => `${p.muse} ${p.online ? 'online' : p.agoMinutes === null ? 'chưa check-in' : `${p.agoMinutes} phút trước`}`).join(' · ');
    return [
      `📊 Trạng thái bridge — v${s.version} · main ${head}`,
      `PR đang mở: ${prs}`,
      `Task đang mở: ${s.openTasks} · Tin: ${s.messages}`,
      `Presence: ${presence}`,
      s.lastTelegramError ? `⚠️ Lỗi Telegram: ${s.lastTelegramError}` : 'Telegram: OK',
    ].join('\n');
  }
  if (section === 'digest') {
    const sum = buildRollingSummary();
    const open = openTasks().slice(0, 5);
    const lines = [`📰 Digest — ${sum.text}`];
    for (const m of open) lines.push(`#${m.id} [${m.task.status}] ${m.task.assignee || 'chưa giao'} — ${String(m.text).split('\n')[0].slice(0, 100)}`);
    return lines.join('\n');
  }
  return MENU_TEXT;
}

// Nút inline dưới tin task trên Telegram: callback_data 'task:<id>:<status>'
// hoặc 'assign:<id>:<muse>'. Telegram gửi callback_query về cho pollTelegram.
// Từ v1.9.0 thêm hàng Nhận việc / Nhả việc (claim:<id> / release:<id>) để
// Martin khóa / nhả task ngay trong Telegram.
function taskKeyboard(msg) {
  if (!msg.task) return null;
  const id = msg.id;
  const statusRow = TASK_STATUSES.map((st) => ({ text: st[0].toUpperCase() + st.slice(1), callback_data: `task:${id}:${st}` }));
  const assignRow = ['muse-a', 'muse-b', 'muse-c'].map((muse) => ({ text: muse, callback_data: `assign:${id}:${muse}` }));
  const claimRow = [
    { text: '🙋 Nhận việc', callback_data: `claim:${id}` },
    { text: '🔓 Nhả việc', callback_data: `release:${id}` },
  ];
  return { inline_keyboard: [statusRow, assignRow, claimRow] };
}

// Nút inline dưới tin PR trên Telegram (v1.9.0): ✅ Duyệt ghi quyết định
// lên thread; 🔀 Merge merge thật chỉ khi đã đặt GITHUB_TOKEN (xem
// handlePrApproval), chưa đặt thì ghi quyết định + trả link merge tay.
// Chỉ gắn khi PR còn mở (action opened/reopened/ready_for_review/
// synchronize, chưa merged); PR đã đóng/merge thì không có nút.
function prKeyboard(msg) {
  const g = msg.github;
  if (!g || typeof g !== 'object' || g.event !== 'pull_request' || g.number == null) return null;
  if (g.merged) return null;
  if (!['opened', 'reopened', 'ready_for_review', 'synchronize'].includes(g.action)) return null;
  const repo = g.repo || 'tuanxminhxgi/muse2muse';
  return {
    inline_keyboard: [[
      { text: '✅ Duyệt PR', callback_data: `pr:${repo}:${g.number}:approve` },
      { text: '🔀 Merge PR', callback_data: `pr:${repo}:${g.number}:merge` },
    ]],
  };
}

// Gộp 2 bàn phím inline (task + PR) thành 1, để 1 tin vừa có nút task vừa
// có nút PR khi cần. Tin nào không có nút thì trả null như cũ.
function mergeKeyboards(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { inline_keyboard: [...a.inline_keyboard, ...b.inline_keyboard] };
}

function parseCallbackData(data) {
  const parts = String(data || '').split(':');
  if (parts[0] === 'menu' && parts.length === 2 && MENU_SECTIONS.includes(parts[1])) {
    return { kind: 'menu', section: parts[1] };
  }
  if (parts[0] === 'task' && parts.length === 3 && TASK_STATUSES.includes(parts[2])) {
    const id = Number(parts[1]);
    if (Number.isInteger(id) && id > 0) return { kind: 'task', id, status: parts[2] };
  }
  if (parts[0] === 'assign' && parts.length === 3 && TASK_ASSIGNEES.includes(parts[2])) {
    const id = Number(parts[1]);
    if (Number.isInteger(id) && id > 0) return { kind: 'assign', id, assignee: parts[2] };
  }
  if ((parts[0] === 'claim' || parts[0] === 'release') && parts.length === 2) {
    const id = Number(parts[1]);
    if (Number.isInteger(id) && id > 0) return { kind: parts[0], id };
  }
  if (parts[0] === 'pr' && parts.length === 4 && /^[\w.-]+\/[\w.-]+$/.test(parts[1])
    && ['approve', 'merge'].includes(parts[3])) {
    const number = Number(parts[2]);
    if (Number.isInteger(number) && number > 0) return { kind: 'pr', repo: parts[1], number, action: parts[3] };
  }
  return null;
}

// Áp dụng 1 thay đổi task; trả về {ok, message?, error?}. Không tự đăng tin
// — caller đăng tin xác nhận sau khi áp xong. opts.enforceTransitions
// (mặc định true): false khi lệnh đến từ Martin trên Telegram (/done,
// /status) — Martin được quyền bỏ qua bảng chuyển trạng thái. Task xong
// (done) hoặc quay về todo thì tự nhả khóa.
function applyTaskUpdate({ id, status, assignee }, opts = {}) {
  const msg = messages.find((m) => m.id === id);
  if (!msg) return { ok: false, error: `không tìm thấy tin #${id}` };
  if (!msg.task) return { ok: false, error: `tin #${id} không phải task` };
  if (status !== undefined && opts.enforceTransitions !== false) {
    const t = checkTransition(msg.task, status);
    if (!t.ok) return { ok: false, error: t.error };
  }
  const prevStatus = msg.task.status;
  const next = { ...msg.task };
  if (status !== undefined) next.status = status;
  if (assignee !== undefined) next.assignee = assignee;
  // Ack bắt buộc (v1.14.0): đổi người nhận thì đặt lại mốc giao + xóa 2
  // cờ ack để người mới có đủ thời gian xác nhận đã đọc.
  if (assignee !== undefined && assignee !== msg.task.assignee) {
    next.assignedAt = new Date().toISOString();
    delete next.ackRemindedAt;
    delete next.ackEscalatedAt;
  }
  if (next.status === 'done' || next.status === 'todo') {
    delete next.lockedBy;
    delete next.lockedAt;
  }
  msg.task = next;
  persistMessages();
  appendAudit({ action: 'task.update', sender: 'martin', messageId: msg.id, source: 'telegram' });
  // Đồng bộ 2 chiều (v1.11.0): task sang done thì Issue liên kết tự
  // đóng, task từ done mở lại thì Issue tự mở lại (fire-and-forget).
  if (status !== undefined && prevStatus !== next.status) {
    syncIssueState(msg, prevStatus, next.status).catch((e) => console.error('[issues] sync error:', e.message));
  }
  return { ok: true, message: msg };
}

// Xử lý 1 lệnh Telegram đã parse; đăng tin xác nhận lên mailbox (sender
// martin, source telegram) để cả 3 Muse đều thấy, rồi trả text để gửi
// lại Telegram. Trả null khi lệnh không phải của bridge. /start (v1.13.0)
// trả {text, replyMarkup} để gửi kèm bàn phím menu thay vì text thuần.
async function handleTelegramCommand(parsed) {
  if (!parsed) return null;
  if (parsed.cmd === 'start') return { text: MENU_TEXT, replyMarkup: menuKeyboard() };
  if (parsed.cmd === 'help') return TASK_COMMANDS_HELP;
  if (parsed.cmd === 'tasks') return listOpenTasksText();
  if (parsed.cmd === 'bad') return parsed.error;
  if (parsed.cmd === 'approve' || parsed.cmd === 'merge') {
    const r = await handlePrApproval({ repo: parsed.repo, number: parsed.number, action: parsed.cmd, via: `lệnh /${parsed.cmd}` });
    return r.reply;
  }
  if (parsed.cmd === 'claim' || parsed.cmd === 'release') {
    const r = parsed.cmd === 'claim'
      ? claimTask(parsed.id, 'martin', 'telegram')
      : releaseTask(parsed.id, 'martin', 'telegram');
    if (!r.ok) return r.error;
    const m = r.message;
    const confirm = parsed.cmd === 'claim'
      ? `[telegram] Martin đã nhận task #${m.id} [${m.task.status} · 🔒 martin]: ${String(m.text).split('\n')[0].slice(0, 100)}`
      : `[telegram] Martin đã nhả khóa task #${m.id} [${m.task.status}]: ${String(m.text).split('\n')[0].slice(0, 100)}`;
    const msg = addMessage({ sender: 'martin', text: confirm, source: 'telegram' });
    console.log(`[telegram] command #${msg.id} ${parsed.cmd} #${m.id}`);
    return confirm;
  }
  if (parsed.cmd === 'vote') {
    const r = toggleVote(parsed.id, 'martin');
    if (!r.ok) return r.error;
    const m = r.message;
    const confirm = `[telegram] Martin ${r.voted ? 'đã bình chọn' : 'đã rút vote'} cho tin #${m.id} (👍 ${voteCount(m)}): ${String(m.text).split('\n')[0].slice(0, 100)}`;
    const msg = addMessage({ sender: 'martin', text: confirm, source: 'telegram' });
    console.log(`[telegram] command #${msg.id} vote #${m.id} voted=${r.voted}`);
    return confirm;
  }
  // Sửa lỗi có từ v1.4.0: /done parse ra {cmd:'done', id} mà không có
  // status, nên applyTaskUpdate không đổi gì nhưng vẫn đăng tin "đã xong".
  // Ép status:'done' ở đây để /done thật sự đánh dấu xong.
  const r = applyTaskUpdate(parsed.cmd === 'done' ? { ...parsed, status: 'done' } : parsed, { enforceTransitions: false }); // Martin override
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

// ---------- Duyệt nhanh PR trên Telegram (v1.9.0) ----------
// Nút ✅ Duyệt / 🔀 Merge dưới tin PR (xem prKeyboard) và lệnh /approve,
// /merge đều đi qua đây. Duyệt chỉ ghi quyết định lên thread (type
// decision) để cả 3 Muse thấy — không cần GitHub. Merge thật chỉ khi đã
// đặt GITHUB_TOKEN (PAT của Martin, repo scope): gọi GitHub API merge;
// chưa đặt token thì ghi quyết định "Martin yêu cầu merge" + trả link để
// Martin merge tay trên GitHub. Cờ kiểm tra rủi ro phía Muse thì nút
// không bấm hộ được — vẫn cần lời xác nhận trực tiếp của Martin.
async function githubApi(path, method, body) {
  if (!GITHUB_TOKEN) return { ok: false, error: 'chưa đặt GITHUB_TOKEN trong .env' };
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      method: method || 'GET',
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${GITHUB_TOKEN}`, 'user-agent': 'muse-bridge' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, status: res.status, data };
    return { ok: false, status: res.status, error: data.message || `GitHub trả ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function mergePullRequest(repo, number) {
  const r = await githubApi(`/repos/${repo}/pulls/${number}/merge`, 'PUT', {});
  if (r.ok) return { ok: true, sha: r.data.sha || null, message: r.data.message || 'Merged' };
  return { ok: false, error: r.error };
}

async function handlePrApproval({ repo, number, action, via }) {
  const url = `https://github.com/${repo}/pull/${number}`;
  if (action === 'approve') {
    const text = `[telegram] Martin đã duyệt PR #${number} (${repo})${via ? ` (${via})` : ''} — quyết định đã ghi lên thread, merge vẫn do Martin bấm trên GitHub hoặc nút Merge.\n${url}`;
    const msg = addMessage({ sender: 'martin', text, source: 'telegram', type: 'decision' });
    appendAudit({ action: 'pr.approve', sender: 'martin', messageId: msg.id, source: 'telegram' });
    console.log(`[telegram] approve #${msg.id} PR ${repo}#${number}`);
    return { ok: true, reply: `Đã ghi nhận: duyệt PR #${number} (${repo}). Merge vẫn cần bấm trên GitHub hoặc nút Merge.`, boardMessage: msg };
  }
  // action === 'merge'
  if (!GITHUB_TOKEN) {
    const text = `[telegram] Martin bấm Merge cho PR #${number} (${repo})${via ? ` (${via})` : ''} — bridge chưa có GITHUB_TOKEN nên chưa merge tự động được. Merge tại: ${url}`;
    const msg = addMessage({ sender: 'martin', text, source: 'telegram', type: 'decision' });
    appendAudit({ action: 'pr.merge.requested', sender: 'martin', messageId: msg.id, source: 'telegram' });
    console.log(`[telegram] merge requested (no token) #${msg.id} PR ${repo}#${number}`);
    return { ok: false, reply: `Bridge chưa có GITHUB_TOKEN nên chưa merge PR #${number} tự động được. Merge tại: ${url}`, boardMessage: msg };
  }
  const r = await mergePullRequest(repo, number);
  if (r.ok) {
    const text = `[telegram] Martin đã merge PR #${number} (${repo}) qua Telegram${via ? ` (${via})` : ''} — GitHub xác nhận đã merge${r.sha ? ` (${String(r.sha).slice(0, 7)})` : ''}.\n${url}`;
    const msg = addMessage({ sender: 'martin', text, source: 'telegram', type: 'decision' });
    appendAudit({ action: 'pr.merge', sender: 'martin', messageId: msg.id, source: 'telegram' });
    console.log(`[telegram] merged #${msg.id} PR ${repo}#${number}`);
    return { ok: true, reply: `Đã merge PR #${number} (${repo}).`, boardMessage: msg };
  }
  const text = `[telegram] Martin bấm Merge cho PR #${number} (${repo})${via ? ` (${via})` : ''} nhưng GitHub báo lỗi: ${r.error}. Merge tay tại: ${url}`;
  const msg = addMessage({ sender: 'martin', text, source: 'telegram', type: 'decision' });
  appendAudit({ action: 'pr.merge.failed', sender: 'martin', messageId: msg.id, source: 'telegram' });
  console.log(`[telegram] merge failed #${msg.id} PR ${repo}#${number}: ${r.error}`);
  return { ok: false, reply: `Merge PR #${number} thất bại: ${r.error}. Merge tay tại: ${url}`, boardMessage: msg };
}

// ---------- Đồng bộ 2 chiều board ↔ GitHub Issues (v1.11.0) ----------
// task.issue (lưu ngay trên task trong messages.jsonl):
//   { repo, number, url, state: 'open'|'closed', syncedAt }
// Hàng chờ (issue-sync.json): yêu cầu tạo/đóng/mở Issue chưa làm được
// vì chưa có GITHUB_TOKEN hoặc GitHub API lỗi — thử lại bằng
// POST /api/issues/retry khi đã có token. Mỗi messageId chỉ giữ 1
// mục chờ / loại hành động (mục mới ghi đè mục cũ cùng loại).
let issueSyncQueue = [];
try {
  const raw = JSON.parse(fs.readFileSync(ISSUE_SYNC_FILE, 'utf8'));
  if (Array.isArray(raw.pending)) issueSyncQueue = raw.pending;
} catch { /* first run: no file yet */ }

function persistIssueSyncQueue() {
  fs.writeFileSync(ISSUE_SYNC_FILE, JSON.stringify({ pending: issueSyncQueue }, null, 2) + '\n');
}
function queueIssueSync(item) {
  const queuedAt = new Date().toISOString();
  const idx = issueSyncQueue.findIndex((q) => q.messageId === item.messageId && q.action === item.action);
  const entry = { ...item, queuedAt, lastError: item.lastError || null };
  if (idx >= 0) issueSyncQueue[idx] = entry; else issueSyncQueue.push(entry);
  persistIssueSyncQueue();
  return entry;
}
function issueSyncStatus() {
  const linked = messages.filter((m) => m.task?.issue).map((m) => ({
    messageId: m.id, repo: m.task.issue.repo, number: m.task.issue.number,
    url: m.task.issue.url, state: m.task.issue.state || 'open',
    taskStatus: m.task.status, assignee: m.task.assignee || null,
  }));
  return {
    enabled: GITHUB_ISSUES_SYNC_ENABLED,
    repo: GITHUB_ISSUES_REPO,
    label: GITHUB_ISSUES_LABEL,
    tokenConfigured: Boolean(GITHUB_TOKEN),
    linked,
    pending: issueSyncQueue,
  };
}
function findLinkedMessage(repo, number) {
  return messages.find((m) => m.task?.issue
    && m.task.issue.repo === repo && Number(m.task.issue.number) === Number(number));
}
function issueTitleFor(msg) {
  return String(msg.text || '').split('\n')[0].trim().slice(0, 120) || `Task #${msg.id}`;
}
function issueBodyFor(msg) {
  const t = msg.task || {};
  return [
    `Đồng bộ từ board muse2muse — tin #${msg.id} (sender: ${msg.sender}).`,
    '',
    String(msg.text || ''),
    '',
    `Trạng thái: ${t.status || 'todo'}${t.assignee ? ` · Giao cho: ${t.assignee}` : ''}${t.deadline ? ` · Hạn: ${t.deadline}` : ''}`,
    'Mở lại / đóng task trên board thì Issue này tự đóng / mở theo.',
  ].join('\n');
}
// Tạo Issue GitHub cho 1 task (dùng khi bấm "Tạo Issue" hoặc retry hàng
// chờ). Trả {ok, issue} khi tạo xong; {ok:false, queued:true} khi chưa
// có token hoặc GitHub lỗi (đã đưa vào hàng chờ).
async function createIssueForTask(msg) {
  if (!GITHUB_ISSUES_SYNC_ENABLED) return { ok: false, error: 'đồng bộ Issues đang tắt (GITHUB_ISSUES_SYNC_ENABLED=0)' };
  if (!msg.task) return { ok: false, error: `tin #${msg.id} không phải task` };
  if (msg.task.issue) return { ok: true, already: true, issue: msg.task.issue };
  if (!GITHUB_TOKEN) {
    msg.task.issuePending = true;
    persistMessages();
    queueIssueSync({ messageId: msg.id, action: 'create', repo: GITHUB_ISSUES_REPO });
    appendAudit({ action: 'issue.sync.queued', sender: 'bridge', messageId: msg.id, source: 'issue-sync' });
    return { ok: false, queued: true, error: 'chưa đặt GITHUB_TOKEN trong .env — đã đưa vào hàng chờ đồng bộ' };
  }
  const title = issueTitleFor(msg);
  const body = issueBodyFor(msg);
  let r = await githubApi(`/repos/${GITHUB_ISSUES_REPO}/issues`, 'POST', { title, body, labels: [GITHUB_ISSUES_LABEL] });
  if (!r.ok && r.status === 422 && /label/i.test(r.error || '')) {
    // Repo chưa có label board-task: tạo lại không kèm label thay vì lỗi.
    r = await githubApi(`/repos/${GITHUB_ISSUES_REPO}/issues`, 'POST', { title, body });
  }
  if (!r.ok) {
    msg.task.issuePending = true;
    persistMessages();
    queueIssueSync({ messageId: msg.id, action: 'create', repo: GITHUB_ISSUES_REPO, lastError: r.error });
    appendAudit({ action: 'issue.sync.queued', sender: 'bridge', messageId: msg.id, source: 'issue-sync' });
    return { ok: false, queued: true, error: `GitHub báo lỗi: ${r.error} — đã đưa vào hàng chờ đồng bộ` };
  }
  const issue = r.data || {};
  msg.task.issue = {
    repo: GITHUB_ISSUES_REPO, number: issue.number,
    url: issue.html_url || `https://github.com/${GITHUB_ISSUES_REPO}/issues/${issue.number}`,
    state: issue.state || 'open', syncedAt: new Date().toISOString(),
  };
  delete msg.task.issuePending;
  persistMessages();
  appendAudit({ action: 'issue.sync.created', sender: 'bridge', messageId: msg.id, source: 'issue-sync' });
  console.log(`[issues] created ${GITHUB_ISSUES_REPO}#${issue.number} for message #${msg.id}`);
  return { ok: true, issue: msg.task.issue };
}
// Đồng bộ trạng thái Issue theo task: task sang done → đóng Issue;
// task từ done mở lại (todo/doing/review/blocked) → mở lại Issue.
// Chạy fire-and-forget sau khi task đã đổi trạng thái (không chặn API
// trả về); lỗi / chưa có token thì đưa vào hàng chờ để retry sau.
async function syncIssueState(msg, prevStatus, nextStatus) {
  if (!GITHUB_ISSUES_SYNC_ENABLED) return;
  const link = msg.task?.issue;
  if (!link) return;
  const wantClosed = nextStatus === 'done' && prevStatus !== 'done';
  const wantReopen = prevStatus === 'done' && nextStatus !== 'done';
  if (!wantClosed && !wantReopen) return;
  const action = wantClosed ? 'close' : 'reopen';
  if (!GITHUB_TOKEN) {
    queueIssueSync({ messageId: msg.id, action, repo: link.repo, number: link.number });
    console.log(`[issues] no token — queued ${action} for ${link.repo}#${link.number} (msg #${msg.id})`);
    return;
  }
  const r = await githubApi(`/repos/${link.repo}/issues/${link.number}`, 'PATCH', { state: wantClosed ? 'closed' : 'open' });
  if (!r.ok) {
    queueIssueSync({ messageId: msg.id, action, repo: link.repo, number: link.number, lastError: r.error });
    console.log(`[issues] ${action} failed for ${link.repo}#${link.number}: ${r.error} — queued`);
    return;
  }
  link.state = wantClosed ? 'closed' : 'open';
  link.syncedAt = new Date().toISOString();
  persistMessages();
  appendAudit({ action: `issue.sync.${action}`, sender: 'bridge', messageId: msg.id, source: 'issue-sync' });
  console.log(`[issues] ${action} ${link.repo}#${link.number} (msg #${msg.id})`);
}
// Thử lại toàn bộ hàng chờ (tạo/đóng/mở Issue). Mục nào xong thì xóa
// khỏi hàng chờ, mục nào vẫn lỗi thì giữ lại kèm lastError.
async function retryIssueSync() {
  if (!GITHUB_TOKEN) return { ok: false, error: 'chưa đặt GITHUB_TOKEN trong .env' };
  const results = [];
  for (const item of [...issueSyncQueue]) {
    const msg = messages.find((m) => m.id === item.messageId);
    if (!msg || !msg.task) {
      issueSyncQueue = issueSyncQueue.filter((q) => q !== item);
      results.push({ ...item, ok: false, error: 'không còn tin/task đó trên board — đã bỏ khỏi hàng chờ' });
      continue;
    }
    if (item.action === 'create') {
      const r = await createIssueForTask(msg);
      // createIssueForTask tự đưa lại vào hàng chờ khi lỗi — tránh trùng.
      if (r.ok) {
        issueSyncQueue = issueSyncQueue.filter((q) => q !== item);
        results.push({ ...item, ok: true });
      } else {
        results.push({ ...item, ok: false, error: r.error });
      }
      continue;
    }
    const link = msg.task.issue;
    if (!link) {
      issueSyncQueue = issueSyncQueue.filter((q) => q !== item);
      results.push({ ...item, ok: false, error: 'task chưa liên kết Issue — đã bỏ khỏi hàng chờ' });
      continue;
    }
    const wantClosed = item.action === 'close';
    const api = await githubApi(`/repos/${link.repo}/issues/${link.number}`, 'PATCH', { state: wantClosed ? 'closed' : 'open' });
    if (api.ok) {
      link.state = wantClosed ? 'closed' : 'open';
      link.syncedAt = new Date().toISOString();
      persistMessages();
      appendAudit({ action: `issue.sync.${item.action}`, sender: 'bridge', messageId: msg.id, source: 'issue-sync' });
      issueSyncQueue = issueSyncQueue.filter((q) => q !== item);
      results.push({ ...item, ok: true });
    } else {
      item.lastError = api.error;
      results.push({ ...item, ok: false, error: api.error });
    }
  }
  persistIssueSyncQueue();
  return { ok: true, results, pending: issueSyncQueue.length };
}
// Webhook issues: Issue đóng/mở lại trên GitHub thì task liên kết đổi
// trạng thái theo (closed → done, reopened → todo). Đồng bộ thắng quy
// tắc chuyển trạng thái của lifecycle (người đóng Issue trên GitHub đã
// quyết xong việc); done thì nhả khóa như mọi lần task xong.
function applyIssueEventToTask(event, payload) {
  if (!GITHUB_ISSUES_SYNC_ENABLED) return null;
  if (event !== 'issues') return null;
  const issue = payload.issue || {};
  const repo = payload.repository?.full_name || '';
  const msg = findLinkedMessage(repo, issue.number);
  if (!msg || !msg.task) return null;
  const action = payload.action || '';
  if (action === 'closed' && msg.task.status !== 'done') {
    const prev = msg.task.status;
    msg.task.status = 'done';
    delete msg.task.lockedBy;
    delete msg.task.lockedAt;
    msg.task.issue.state = issue.state || 'closed';
    msg.task.issue.syncedAt = new Date().toISOString();
    persistMessages();
    appendAudit({ action: 'issue.sync.inbound', sender: 'github', messageId: msg.id, source: 'issue-sync' });
    console.log(`[issues] inbound closed ${repo}#${issue.number} → task #${msg.id} ${prev} → done`);
    return { message: msg, from: prev, to: 'done' };
  }
  if (action === 'reopened' && msg.task.status === 'done') {
    msg.task.status = 'todo';
    delete msg.task.lockedBy;
    delete msg.task.lockedAt;
    msg.task.issue.state = issue.state || 'open';
    msg.task.issue.syncedAt = new Date().toISOString();
    persistMessages();
    appendAudit({ action: 'issue.sync.inbound', sender: 'github', messageId: msg.id, source: 'issue-sync' });
    console.log(`[issues] inbound reopened ${repo}#${issue.number} → task #${msg.id} done → todo`);
    return { message: msg, from: 'done', to: 'todo' };
  }
  if (msg.task.issue) {
    // Event khác (edited/labeled/...) chỉ cập nhật state hiển thị.
    msg.task.issue.state = issue.state || msg.task.issue.state;
    persistMessages();
  }
  return null;
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
  const r = await sendTelegramMessage(text, mergeKeyboards(taskKeyboard(msg), prKeyboard(msg)));
  const ok = r.ok;
  if (ok) {
    // Lưu id tin Telegram để tra ngược khi Martin bấm reaction ✅ (v1.13.0).
    // Chỉ persist khi id mới xuất hiện (1 lần / tin) để không ghi lại file
    // mỗi lần forward.
    if (r.messageId !== null && r.messageId !== undefined && msg.telegramMessageId !== r.messageId) {
      msg.telegramMessageId = r.messageId;
      persistMessages();
    }
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

// ---------- Board status panel (v1.7.0) ----------
// Panel đầu board: bridge status + main HEAD + PR đang mở + deploy cuối.
// HEAD lấy bằng git rev-parse trong REPO_DIR (máy Martin có checkout git;
// máy khác không có thì trả null). PR đang mở lấy từ GitHub API public
// (không cần token, giới hạn 60 request/giờ khi không auth) — cả 2 đều
// cache ngắn hạn và lỗi thì trả null, không làm hỏng board.
let headCache = { at: 0, sha: null };
let prCache = { at: 0, prs: null };
function getMainHead() {
  const now = Date.now();
  if (now - headCache.at < 60_000 && headCache.sha !== undefined) return Promise.resolve(headCache.sha);
  return new Promise((resolve) => {
    execFile('git', ['-C', REPO_DIR, 'rev-parse', 'HEAD'], { timeout: 5_000 }, (err, stdout) => {
      const sha = err ? null : String(stdout || '').trim() || null;
      headCache = { at: now, sha };
      resolve(sha);
    });
  });
}
async function getOpenPRs() {
  const now = Date.now();
  if (now - prCache.at < 300_000 && prCache.prs !== undefined) return prCache.prs;
  let prs = null;
  try {
    const res = await fetch('https://api.github.com/repos/tuanxminhxgi/muse2muse/pulls?state=open&per_page=20', {
      signal: AbortSignal.timeout(3000),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'muse-bridge' },
    });
    if (res.ok) {
      const list = await res.json();
      prs = (Array.isArray(list) ? list : []).map((pr) => ({ number: pr.number, title: pr.title, url: pr.html_url, author: pr.user?.login || '' }));
    }
  } catch { /* GitHub API lỗi / không mạng — panel báo không lấy được */ }
  prCache = { at: now, prs };
  return prs;
}
async function getBoardStatus() {
  const head = await getMainHead();
  const openPrs = await getOpenPRs();
  return {
    version: VERSION,
    startedAt,
    uptime_s: Math.round(process.uptime()),
    messages: messages.length,
    openTasks: openTasks().length,
    telegram: telegramEnabled,
    lastTelegramPollAt,
    lastTelegramError,
    watchdog: readWatchdogHeartbeat(),
    head,
    openPrs,
    deploy: {
      enabled: AUTO_DEPLOY_ENABLED && Boolean(GITHUB_WEBHOOK_SECRET),
      branch: DEPLOY_BRANCH,
      lastDeployAt: deployState.lastDeployAt,
      lastDeploySha: deployState.lastDeploySha,
      lastDeployResult: deployState.lastDeployResult,
    },
    lifecycle: {
      lockTimeoutMinutes: TASK_LOCK_TIMEOUT_MINUTES,
      reminderEnabled: TASK_REMINDER_ENABLED,
      lockedTasks: messages.filter((m) => m.task?.lockedBy && !lockStale(m.task)).length,
      staleLocks: messages.filter((m) => m.task?.lockedBy && lockStale(m.task)).length,
    },
    // Hàng đợi ưu tiên + review tự động (v1.10.0): tóm tắt để panel và
    // /api/board-status hiện mà không cần gọi thêm endpoint.
    queue: (() => {
      const q = buildQueue();
      return {
        openTasks: q.tasks.length,
        highPriority: q.tasks.filter((m) => taskPriority(m.task) === 'high').length,
        topIdeas: q.ideas.slice(0, 5).map((m) => ({ id: m.id, votes: voteCount(m) })),
      };
    })(),
    autoReview: { enabled: AUTO_REVIEW_ENABLED },
    presence: presenceStatus(),
    issues: issueSyncStatus(),
    // Digest thông báo + ack bắt buộc (v1.14.0): để panel và /api/board-status
    // hiện mà không cần gọi thêm endpoint.
    noticeDigest: {
      enabled: NOTICE_DIGEST_ENABLED,
      minutes: NOTICE_DIGEST_MINUTES,
      queued: noticeDigest.items.length,
      lastFlushAt: noticeDigest.lastFlushAt,
    },
    taskAck: { enabled: TASK_ACK_ENABLED, timeoutMinutes: TASK_ACK_TIMEOUT_MINUTES },
  };
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
  if (event === 'issue_comment') {
    const issue = payload.issue || {};
    const comment = payload.comment || {};
    const body = String(comment.body || '').split('\n')[0].slice(0, 200);
    return `[github] Bình luận trên Issue #${issue.number} ${repo} — "${issue.title}" bởi ${sender}: "${body}"\n${comment.html_url || issue.html_url || ''}`;
  }
  if (event === 'release') {
    const rel = payload.release || {};
    return `[github] Release ${repo} — ${payload.action}: ${rel.tag_name || ''} "${rel.name || ''}" bởi ${sender}\n${rel.html_url || ''}`;
  }
  return null; // event khác (fork, star...) thì bỏ qua, không đăng tin
}

// Dữ liệu event GitHub để board mở rộng (v1.7.0): chỉ lấy những gì
// payload webhook đã có sẵn, không gọi thêm API GitHub. Push: danh sách
// commit (sha ngắn, message 1 dòng, tác giả, số file thêm/xóa/sửa);
// PR/issue/release: số, tiêu đề/tag, trạng thái, link. Tin cũ (trước
// v1.7.0) không có trường github thì board vẫn hiện như cũ.
function buildGitHubMeta(event, payload) {
  const repo = payload.repository?.full_name || 'unknown repo';
  if (event === 'push') {
    const branch = String(payload.ref || '').replace(/^refs\/heads\//, '');
    return {
      event, repo, branch,
      compare: payload.compare || null,
      commits: (payload.commits || []).slice(0, 20).map((c) => ({
        sha: String(c.id || '').slice(0, 7),
        message: String(c.message || '').split('\n')[0].slice(0, 120),
        author: c.author?.name || c.author?.username || payload.sender?.login || '',
        added: (c.added || []).length,
        removed: (c.removed || []).length,
        modified: (c.modified || []).length,
      })),
    };
  }
  if (event === 'pull_request') {
    const pr = payload.pull_request || {};
    return {
      event, repo, number: pr.number, title: pr.title || '',
      action: payload.action || '', merged: Boolean(pr.merged),
      url: pr.html_url || null,
      head: pr.head?.ref || null, base: pr.base?.ref || null,
      author: payload.sender?.login || '',
    };
  }
  if (event === 'issues') {
    const issue = payload.issue || {};
    return {
      event, repo, number: issue.number, title: issue.title || '',
      action: payload.action || '', url: issue.html_url || null,
      author: payload.sender?.login || '',
      state: issue.state || null,
      labels: (issue.labels || []).map((l) => l.name || l).filter(Boolean),
    };
  }
  if (event === 'issue_comment') {
    const issue = payload.issue || {};
    const comment = payload.comment || {};
    return {
      event, repo, number: issue.number, title: issue.title || '',
      action: payload.action || '', url: issue.html_url || null,
      author: payload.sender?.login || '',
      state: issue.state || null,
      labels: (issue.labels || []).map((l) => l.name || l).filter(Boolean),
      commentBy: comment.user?.login || payload.sender?.login || '',
      commentUrl: comment.html_url || null,
      commentBody: String(comment.body || '').slice(0, 500),
    };
  }
  if (event === 'release') {
    const rel = payload.release || {};
    return {
      event, repo, tag: rel.tag_name || '', title: rel.name || '',
      action: payload.action || '', url: rel.html_url || null,
      author: payload.sender?.login || '',
    };
  }
  return null;
}

// ---------- Review chéo PR tự động (v1.10.0) ----------
// Tác giả suy từ tên nhánh head: implement-<a|b|c>-… (hoặc nhánh đã biết
// trong KNOWN_BRANCH_AUTHORS). Người review là Muse kế tiếp trong vòng
// a→b→c→a — không bao giờ tự review PR của mình. Không xác định được tác
// giả thì muse-a (điều phối) review mặc định.
function authorFromBranch(head) {
  const h = String(head || '');
  const m = h.match(/^implement-([abc])(?:[-_]|$)/);
  if (m) return `muse-${m[1]}`;
  return KNOWN_BRANCH_AUTHORS[h] || null;
}
function reviewerFor(author) {
  if (!author || !MUSES.includes(author)) return 'muse-a';
  return MUSES[(MUSES.indexOf(author) + 1) % MUSES.length];
}
// Cờ file rủi ro khi có danh sách file đổi (chỉ khi GITHUB_TOKEN đã đặt
// để gọi API): đổi dependency, secret/env, workflow CI, hoặc sửa file
// nhạy cảm khác.
const RISKY_FILE_RES = [
  { re: /(^|\/)package\.json$/, label: 'đổi package.json (dependency)' },
  { re: /(^|\/)\.env(\.|$)/, label: 'đụng file .env' },
  { re: /(^|\/)\.github\/workflows\//, label: 'đổi workflow CI' },
  { re: /(^|\/)token\.txt$/, label: 'đụng token.txt' },
];
// Lấy danh sách file đổi của PR qua GitHub API. Cần GITHUB_TOKEN; không
// có token thì trả null để review chỉ dùng số liệu trong payload webhook.
async function fetchPrFiles(repo, number) {
  if (!GITHUB_TOKEN) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}/files?per_page=100`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${GITHUB_TOKEN}`, 'user-agent': 'muse-bridge' },
    });
    if (!res.ok) return null;
    const list = await res.json();
    return (Array.isArray(list) ? list : []).map((f) => ({
      filename: f.filename || '', additions: f.additions || 0, deletions: f.deletions || 0, status: f.status || '',
    }));
  } catch { return null; }
}
// Đăng review thành comment lên PR (chỉ khi có GITHUB_TOKEN). Lỗi thì
// trả {ok:false} — review trên thread vẫn là bản chính.
async function postPrReviewComment(repo, number, body) {
  if (!GITHUB_TOKEN) return { ok: false, error: 'chưa đặt GITHUB_TOKEN' };
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${GITHUB_TOKEN}`, 'user-agent': 'muse-bridge' },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.message || `GitHub trả ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
// Soạn nội dung review từ payload PR + (nếu có) danh sách file đổi.
// Chỉ kiểm tra tự động bằng số liệu — không thay review code thật.
function buildReviewText({ repo, pr, files }) {
  const number = pr.number;
  const changedFiles = typeof pr.changed_files === 'number' ? pr.changed_files : (files ? files.length : null);
  const additions = typeof pr.additions === 'number' ? pr.additions : (files ? files.reduce((s, f) => s + f.additions, 0) : null);
  const deletions = typeof pr.deletions === 'number' ? pr.deletions : (files ? files.reduce((s, f) => s + f.deletions, 0) : null);
  const total = (additions ?? 0) + (deletions ?? 0);
  const flags = [];
  if (pr.draft) flags.push('PR đang draft — chưa sẵn sàng merge');
  if (pr.mergeable === false) flags.push('đang conflict với base — chưa merge được, cần rebase/sửa conflict');
  if (changedFiles === 0) flags.push('không có file nào đổi');
  if (total > REVIEW_LARGE_LINES) flags.push(`diff lớn (${total} dòng đổi) — nên xem kỹ từng file, cân nhắc chia nhỏ PR`);
  if (files) {
    for (const f of files) {
      for (const r of RISKY_FILE_RES) {
        if (r.re.test(f.filename)) flags.push(r.label + `: ${f.filename}`);
      }
    }
  }
  const verdict = flags.length > 0 ? 'CẦN XEM LẠI' : 'OK';
  const lines = [
    `[review] PR #${number} (${repo}) — "${pr.title || ''}"`,
    `File đổi: ${changedFiles ?? '?'} · +${additions ?? '?'} / -${deletions ?? '?'} dòng · ${pr.commits ?? '?'} commit · ${pr.head?.ref || '?'} → ${pr.base?.ref || '?'}`,
  ];
  if (files && files.length > 0) {
    const top = files.slice(0, 10).map((f) => `${f.filename} (+${f.additions}/-${f.deletions})`).join(', ');
    lines.push(`File chính: ${top}${files.length > 10 ? ` (+${files.length - 10} file nữa)` : ''}`);
  }
  if (flags.length > 0) lines.push(`Cờ kiểm tra: ${flags.map((f, i) => `${i + 1}. ${f}`).join(' | ')}`);
  lines.push(`Kết luận tự động: ${verdict}${verdict === 'OK' ? ' — để Martin merge.' : ' — xem các cờ trên trước khi merge.'}`);
  lines.push(pr.html_url || '');
  return { verdict, text: lines.filter(Boolean).join('\n') };
}
// Mỗi PR + head sha chỉ review 1 lần — GitHub gửi lại webhook khi lỗi,
// và mỗi lần push thêm commit (synchronize) có sha mới thì review lại.
const seenReviews = new Set();
// Chạy sau khi tin PR đã đăng lên thread. Không throw — lỗi thì chỉ log,
// webhook vẫn trả 200 vì tin PR đã đăng xong.
async function maybeAutoReview({ event, payload, prMessage }) {
  if (!AUTO_REVIEW_ENABLED) return;
  if (event !== 'pull_request') return;
  const action = payload.action || '';
  if (!['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(action)) return;
  const pr = payload.pull_request || {};
  const repo = payload.repository?.full_name || '';
  if (!pr.number || !repo) return;
  const headSha = String(pr.head?.sha || '');
  const key = `${repo}#${pr.number}@${headSha}`;
  if (seenReviews.has(key)) return;
  seenReviews.add(key);
  if (seenReviews.size > 200) seenReviews.clear();
  const author = authorFromBranch(pr.head?.ref);
  const reviewer = reviewerFor(author);
  const files = await fetchPrFiles(repo, pr.number);
  const { verdict, text } = buildReviewText({ repo, pr, files });
  const header = author
    ? `[review tự động] ${reviewer} review chéo PR của ${author} (action: ${action})`
    : `[review tự động] ${reviewer} review PR (không xác định được tác giả theo tên nhánh, muse-a review mặc định — action: ${action})`;
  const reviewMsg = addMessage({
    sender: reviewer, text: `${header}\n${text}`,
    source: 'github-webhook', type: 'status', reply_to: prMessage.id,
  });
  console.log(`[review] #${reviewMsg.id} ${reviewer} -> PR ${repo}#${pr.number}: ${verdict}`);
  forwardToTelegram(reviewMsg);
  const r = await postPrReviewComment(repo, pr.number, `${header}\n\n${text}\n\n— Review tự động từ Muse Bridge (chỉ kiểm tra số liệu, không thay review code thật).`);
  if (!r.ok && GITHUB_TOKEN) console.log(`[review] không comment được lên PR ${repo}#${pr.number}: ${r.error}`);
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
  const meta = buildGitHubMeta(event, payload);
  // Đồng bộ 2 chiều (v1.11.0): Issue đóng/mở lại trên GitHub thì task
  // liên kết đổi trạng thái theo; gắn id tin liên kết vào meta để board
  // hiện rõ (chỉ khi tìm thấy task liên kết).
  let linkedMessageId = null;
  if (event === 'issues' || event === 'issue_comment') {
    const linked = findLinkedMessage(repo, payload.issue?.number);
    if (linked) {
      linkedMessageId = linked.id;
      if (event === 'issues') {
        const synced = applyIssueEventToTask(event, payload);
        if (synced) meta.taskSynced = { messageId: synced.message.id, from: synced.from, to: synced.to };
      }
    }
  }
  if (linkedMessageId !== null && meta) meta.linkedMessageId = linkedMessageId;
  const msg = addMessage({ sender: 'github', text, source: 'github-webhook', github: meta });
  console.log(`[github] #${msg.id} ${event} ${repo}`);
  // v1.14.0: tin GitHub là tin routine — gom vào digest theo giờ thay vì
  // gửi Telegram ngay (xem queueRoutineNotice).
  queueRoutineNotice(msg, 'github');
  // Review chéo PR tự động (v1.10.0): PR mở/cập nhật thì Muse khác tác
  // giả đăng review kiểm tra tự động lên thread. Chạy nền, không chặn
  // trả webhook; lỗi thì chỉ log vì tin PR đã đăng xong.
  if (event === 'pull_request') {
    maybeAutoReview({ event, payload, prMessage: msg }).catch((e) => console.error('[review] error:', e.message));
  }
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

// Phân loại deadline (v1.7.0): so theo ngày địa phương (YYYY-MM-DD) của
// máy chạy bridge. overdue = đã quá hạn mà task còn mở; today = hạn hôm
// nay; week = hạn trong 7 ngày tới (kể cả hôm nay); none = không có hạn.
function deadlineBucket(m) {
  if (!m.task?.deadline) return 'none';
  const day = String(m.task.deadline).slice(0, 10);
  const today = localDayKey();
  if (day < today) return 'overdue';
  if (day === today) return 'today';
  const diffDays = Math.round((new Date(`${day}T00:00:00`) - new Date(`${today}T00:00:00`)) / 86_400_000);
  return diffDays <= 7 ? 'week' : 'later';
}
function matchDeadlineFilter(m, filter) {
  if (!filter || filter === 'all') return true;
  if (filter === 'overdue') return deadlineBucket(m) === 'overdue' && (m.task.status === 'todo' || m.task.status === 'doing');
  return deadlineBucket(m) === filter;
}

// Ghim tin (v1.7.0): cờ pinned lưu ngay trên tin, persistMessages ghi
// lại messages.jsonl. Ghim/bỏ ghim không đăng tin mới lên thread.
function setPinned(id, pinned) {
  const msg = messages.find((m) => m.id === id);
  if (!msg) return null;
  if (pinned) msg.pinned = true;
  else delete msg.pinned;
  persistMessages();
  appendAudit({ action: 'message.pin', sender: null, messageId: msg.id, source: 'api' });
  broadcastMessage(msg);
  return msg;
}

// ---------- Lịch sử / lưu trữ thread (v1.12.0) ----------
// Tin đã đọc + đã xử lý xong thì chuyển sang Lịch sử để thread gọn:
// cờ archived (+ archivedAt) lưu ngay trên tin, persistMessages ghi lại
// messages.jsonl như cờ pinned (v1.7.0). Tin cũ không có cờ này vẫn đọc
// bình thường, coi như đang hoạt động. Lưu trữ không xóa dữ liệu: tin
// đã lưu trữ vẫn đọc, tìm (GET /api/history, ?view=history) và khôi
// phục được (POST /api/messages/:id/unarchive).
// Tin đủ điều kiện lưu trữ khi: chưa lưu trữ, không ghim, đã cũ hơn
// ARCHIVE_MIN_AGE_MS (24h — nên yêu cầu mới nhất của Martin, như tin
// #253, không bao giờ bị lưu trữ nhầm), và đã xử lý xong: task thì
// status phải done, tin thường thì đã có ít nhất 1 Muse khác người gửi
// xác nhận đọc (read_by — người gửi tự động có read_by nên không tính).
// Tin hệ thống (github/bridge) cũng theo quy tắc tin thường.
const ARCHIVE_MIN_AGE_MS = 24 * 60 * 60 * 1000;
function archiveEligibility(m, now = Date.now()) {
  if (m.archived) return { ok: false, reason: 'already-archived' };
  if (m.pinned) return { ok: false, reason: 'pinned' };
  const ageMs = now - new Date(m.ts || 0).getTime();
  if (Number.isNaN(ageMs) || ageMs < ARCHIVE_MIN_AGE_MS) return { ok: false, reason: 'too-recent' };
  if (m.task) {
    if (m.task.status !== 'done') return { ok: false, reason: 'task-not-done' };
  } else if (!Array.isArray(m.read_by) || !m.read_by.some((r) => r !== m.sender)) {
    // Người gửi tự động có read_by (xem addMessage) nên chỉ tính là đã
    // đọc khi có Muse khác người gửi xác nhận đọc.
    return { ok: false, reason: 'not-read' };
  }
  return { ok: true };
}
function activeMessages() {
  return messages.filter((m) => !m.archived);
}
function archivedMessages() {
  return messages.filter((m) => m.archived);
}
// Lưu trữ / khôi phục 1 tin. setArchived(id, true) kiểm tra đủ điều
// kiện rồi mới lưu (chưa đủ thì trả {ok:false, reason}); khôi phục thì
// luôn được khi tin đang lưu trữ. Trả {ok, message} hoặc
// {ok:false, code, error/reason}.
function setArchived(id, archived, source) {
  const msg = messages.find((m) => m.id === id);
  if (!msg) return { ok: false, code: 'not_found', error: 'message not found' };
  if (archived) {
    const check = archiveEligibility(msg);
    if (!check.ok) return { ok: false, code: 'not_eligible', reason: check.reason, error: `tin #${id} chưa đủ điều kiện lưu trữ (${check.reason})` };
    msg.archived = true;
    msg.archivedAt = new Date().toISOString();
  } else {
    if (!msg.archived) return { ok: false, code: 'not_archived', error: `tin #${id} không nằm trong Lịch sử` };
    delete msg.archived;
    delete msg.archivedAt;
  }
  persistMessages();
  appendAudit({ action: archived ? 'message.archive' : 'message.unarchive', sender: null, messageId: msg.id, source: source || 'api' });
  broadcastMessage(msg);
  return { ok: true, message: msg };
}
// Lưu trữ hàng loạt (v1.12.0): quét toàn bộ thread, lưu mọi tin đủ điều
// kiện, trả danh sách đã lưu + danh sách bỏ qua kèm lý do từng tin.
function archiveReadMessages(source) {
  const now = Date.now();
  const archived = [];
  const skipped = [];
  for (const m of messages) {
    const check = archiveEligibility(m, now);
    if (!check.ok) { skipped.push({ id: m.id, reason: check.reason }); continue; }
    m.archived = true;
    m.archivedAt = new Date().toISOString();
    archived.push(m.id);
  }
  if (archived.length > 0) {
    persistMessages();
    appendAudit({ action: 'message.archive-read', sender: null, messageId: null, source: source || 'api' });
    for (const id of archived) {
      const msg = messages.find((m) => m.id === id);
      if (msg) broadcastMessage(msg);
    }
  }
  return { archived, skipped };
}
// Tra cứu Lịch sử (v1.12.0): chỉ tin đã lưu trữ, mới nhất trước; lọc
// theo từ khóa q (không phân biệt hoa thường) và người gửi sender —
// dùng chung cho board ?view=history và GET /api/history nên kết quả
// API và board luôn khớp nhau (cùng mẫu với filterSaved v1.8.0).
function filterHistory({ q = '', sender = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return archivedMessages().filter((m) => {
    if (sender && m.sender !== sender) return false;
    if (needle && !String(m.text || '').toLowerCase().includes(needle)) return false;
    return true;
  }).slice().reverse();
}

// ---------- Bình chọn + hàng đợi ưu tiên (v1.10.0) ----------
// Vote lưu ngay trên tin: voted_by = [voter...] (mỗi người tối đa 1 lần,
// bấm lại là rút vote). Tin cũ không có voted_by thì coi như 0 vote.
// taskPriority: tin cũ không có priority thì coi như medium.
// Idea = tin do Muse/Martin viết, không phải task, không phải tin hệ
// thống GitHub/Telegram/bridge, không phải quyết định đã chốt.
function voteCount(m) {
  return Array.isArray(m.voted_by) ? m.voted_by.length : 0;
}
function taskPriority(task) {
  return TASK_PRIORITIES.includes(task?.priority) ? task.priority : 'medium';
}
function isIdeaMessage(m) {
  return (MUSES.includes(m.sender) || m.sender === 'martin')
    && !m.task && !m.github && m.type !== 'decision';
}
// Bật/tắt vote của voter trên tin #id. Trả {ok, message, voted} hoặc
// {ok:false, code, error} để handler map sang HTTP status.
function toggleVote(id, voter) {
  if (!VOTERS.includes(voter)) {
    return { ok: false, code: 'bad_voter', error: 'voter must be muse-a|muse-b|muse-c|martin' };
  }
  const msg = messages.find((m) => m.id === id);
  if (!msg) return { ok: false, code: 'not_found', error: 'message not found' };
  msg.voted_by = Array.isArray(msg.voted_by) ? msg.voted_by : [];
  const at = msg.voted_by.indexOf(voter);
  let voted;
  if (at === -1) { msg.voted_by.push(voter); voted = true; }
  else { msg.voted_by.splice(at, 1); voted = false; }
  if (msg.voted_by.length === 0) delete msg.voted_by;
  persistMessages();
  appendAudit({ action: voted ? 'message.vote' : 'message.unvote', sender: voter, messageId: msg.id, source: 'api' });
  broadcastMessage(msg);
  return { ok: true, message: msg, voted };
}
// Hàng đợi ưu tiên: task đang mở (chưa done) xếp theo ưu tiên (high
// trước) rồi số vote, rồi id; tiếp theo là ideas có vote xếp theo vote.
// Trả thẳng object tin (đã có đủ field để board/API dùng).
function buildQueue() {
  const tasks = messages
    .filter((m) => m.task && m.task.status !== 'done')
    .slice()
    .sort((a, b) => (PRIORITY_RANK[taskPriority(a.task)] - PRIORITY_RANK[taskPriority(b.task)])
      || (voteCount(b) - voteCount(a)) || (a.id - b.id));
  const ideas = messages
    .filter((m) => isIdeaMessage(m) && voteCount(m) > 0)
    .slice()
    .sort((a, b) => (voteCount(b) - voteCount(a)) || (b.id - a.id))
    .slice(0, 20);
  return { tasks, ideas };
}
function listIdeas(sort) {
  const list = messages.filter(isIdeaMessage).slice();
  if (sort === 'new') list.sort((a, b) => b.id - a.id);
  else list.sort((a, b) => (voteCount(b) - voteCount(a)) || (b.id - a.id));
  return list;
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
  const overdue = open.filter((m) => deadlineBucket(m) === 'overdue');
  const dueToday = open.filter((m) => deadlineBucket(m) === 'today');
  if (overdue.length > 0) {
    lines.push('', `Quá hạn: ${overdue.map((m) => `#${m.id} [${m.task.assignee || 'chưa giao'}]`).join(', ')}`);
  }
  if (dueToday.length > 0) {
    lines.push(`Hạn hôm nay: ${dueToday.map((m) => `#${m.id} [${m.task.assignee || 'chưa giao'}]`).join(', ')}`);
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

// ---------- Digest thông báo định kỳ (v1.14.0, ý 1 của Muse B ở #320) ----------
// Tin routine (presence offline + GitHub webhook) không gửi Telegram ngay
// mà gom vào digest mỗi NOTICE_DIGEST_MINUTES phút — board đỡ ngập tin
// máy, Martin chỉ nhận 1 tin digest / giờ. Tin routine vẫn ghi lên board
// nhưng lưu trữ ngay (archived=true, xem lại ở ?view=history, khôi phục
// được như tin v1.12.0). Ngoại lệ báo ngay: Muse offline vượt
// PRESENCE_OFFLINE_ESCALATE_MINUTES (xem checkPresenceOffline) và tin
// deploy (postDeployNotice giữ nguyên gửi ngay). Hàng chờ lưu ở
// notice-digest.json để restart server không mất tin đã gom.
const NOTICE_DIGEST_FILE = path.join(__dirname, 'notice-digest.json');
let noticeDigest = { lastFlushAt: null, items: [] };
try {
  const saved = JSON.parse(fs.readFileSync(NOTICE_DIGEST_FILE, 'utf8'));
  if (Array.isArray(saved.items)) noticeDigest = { lastFlushAt: saved.lastFlushAt || null, items: saved.items };
} catch { /* first run: no file yet */ }
function persistNoticeDigest() {
  try { fs.writeFileSync(NOTICE_DIGEST_FILE, JSON.stringify(noticeDigest) + '\n'); } catch (e) {
    console.error('[notice-digest] could not save state:', e.message);
  }
}
// Gom 1 tin routine vào hàng chờ digest (đồng thời lưu trữ tin trên board
// để thread đang hoạt động sạch). Tắt digest thì gửi ngay như cũ.
async function queueRoutineNotice(msg, kind) {
  if (!NOTICE_DIGEST_ENABLED) { await forwardToTelegram(msg); return; }
  msg.archived = true;
  msg.archivedAt = new Date().toISOString();
  persistMessages();
  broadcastMessage(msg);
  noticeDigest.items.push({ messageId: msg.id, ts: msg.ts, kind });
  persistNoticeDigest();
  console.log(`[notice-digest] queued #${msg.id} (${kind}, ${noticeDigest.items.length} chờ)`);
}
function buildNoticeDigestText() {
  if (noticeDigest.items.length === 0) return null;
  const byKind = { github: [], presence: [] };
  for (const item of noticeDigest.items) {
    const m = messages.find((x) => x.id === item.messageId);
    if (!m) continue;
    (byKind[item.kind] || (byKind[item.kind] = [])).push(m);
  }
  const total = byKind.github.length + byKind.presence.length;
  if (total === 0) return null;
  const since = new Date(noticeDigest.items[0].ts).toTimeString().slice(0, 5);
  const lines = [`📰 Digest thông báo — ${total} tin routine gom từ ${since}:`];
  if (byKind.github.length > 0) {
    lines.push('', `GitHub (${byKind.github.length}):`);
    for (const m of byKind.github) lines.push(`  #${m.id} ${String(m.text).split('\n')[0].slice(0, 100)}`);
  }
  if (byKind.presence.length > 0) {
    lines.push('', `Offline (${byKind.presence.length}):`);
    for (const m of byKind.presence) lines.push(`  #${m.id} ${String(m.text).split('\n')[0].slice(0, 100)}`);
  }
  lines.push('', 'Chi tiết từng tin xem ở Lịch sử (?view=history).');
  return lines.join('\n');
}
// force=true: đăng ngay bất kể giờ (dùng cho POST /api/notice-digest).
// Mốc giờ tính từ lần flush trước, hoặc từ tin gom đầu tiên nếu chưa
// flush lần nào (tránh flush ngay khi vừa gom tin đầu tiên).
function triggerNoticeDigest(force = false) {
  if (!NOTICE_DIGEST_ENABLED) return { posted: false, reason: 'disabled' };
  if (noticeDigest.items.length === 0) return { posted: false, reason: 'no queued notices' };
  if (!force) {
    const baseline = noticeDigest.lastFlushAt
      ? new Date(noticeDigest.lastFlushAt).getTime()
      : new Date(noticeDigest.items[0].ts).getTime();
    if (Date.now() - baseline < NOTICE_DIGEST_MINUTES * 60_000) return { posted: false, reason: 'not due yet' };
  }
  const text = buildNoticeDigestText();
  if (!text) { noticeDigest.items = []; persistNoticeDigest(); return { posted: false, reason: 'no queued notices' }; }
  const count = noticeDigest.items.length;
  const msg = addMessage({ sender: 'bridge', text, source: 'notice-digest' });
  noticeDigest.items = [];
  noticeDigest.lastFlushAt = new Date().toISOString();
  persistNoticeDigest();
  console.log(`[notice-digest] #${msg.id} posted (${count} notices)`);
  forwardToTelegram(msg);
  appendAudit({ action: 'notice-digest.post', sender: 'bridge', messageId: msg.id, source: 'notice-digest' });
  return { posted: true, message: msg };
}
function checkNoticeDigestDue() {
  try {
    const r = triggerNoticeDigest(false);
    if (r.posted) console.log('[notice-digest] hourly digest posted');
  } catch (e) {
    console.error('[notice-digest] error:', e.message);
  }
}

// ---------- Ack bắt buộc cho task (v1.14.0, ý 3 của Muse B ở #320) ----------
// Task giao cho Muse nào thì Muse đó phải xác nhận đã đọc (có tên trong
// read_by — bấm "Đã đọc" trên board, gọi POST /api/messages/:id/read,
// hoặc ✅ trên Telegram từ v1.13.0) trong TASK_ACK_TIMEOUT_MINUTES phút
// (mặc định 10). Quá hạn: bridge nhắc 1 lần, ghi ackRemindedAt lên task;
// vẫn chưa ack sau thêm 1 khoảng timeout nữa thì leo thang báo Martin,
// ghi ackEscalatedAt. Giao lại cho người khác (applyTaskUpdate đổi
// assignee) thì đặt lại assignedAt + xóa 2 cờ ack. Task chưa giao, giao
// cho martin, hoặc đã done/review/blocked thì không nhắc. Tin cũ chưa có
// assignedAt thì lấy giờ tạo tin làm mốc. Mỗi lần sweep gom tối đa 1 tin
// nhắc + 1 tin leo thang (như sweepTaskReminders).
function taskAckState(m, now = Date.now()) {
  const t = m.task;
  if (!t || !t.assignee || !MUSES.includes(t.assignee)) return null;
  if (t.status !== 'todo' && t.status !== 'doing') return null;
  if ((m.read_by || []).includes(t.assignee)) return null;
  const assignedAt = t.assignedAt ? new Date(t.assignedAt).getTime() : new Date(m.ts).getTime();
  const ageMin = (now - assignedAt) / 60_000;
  if (ageMin < TASK_ACK_TIMEOUT_MINUTES) return null;
  if (!t.ackRemindedAt) return 'remind';
  const remindedAt = new Date(t.ackRemindedAt).getTime();
  if (!t.ackEscalatedAt && (now - remindedAt) / 60_000 >= TASK_ACK_TIMEOUT_MINUTES) return 'escalate';
  return null;
}
function sweepTaskAck() {
  if (!TASK_ACK_ENABLED) return;
  const now = Date.now();
  const remind = [];
  const escalate = [];
  for (const m of messages) {
    const state = taskAckState(m, now);
    if (state === 'remind') remind.push(m);
    else if (state === 'escalate') escalate.push(m);
  }
  if (remind.length === 0 && escalate.length === 0) return;
  if (remind.length > 0) {
    const lines = remind.map((m) => `#${m.id} @${m.task.assignee} — ${String(m.text).split('\n')[0].slice(0, 80)}`);
    const msg = addMessage({ sender: 'bridge', text: `[bridge] Nhắc ack: các task sau đã giao quá ${TASK_ACK_TIMEOUT_MINUTES} phút mà Muse được giao chưa xác nhận đã đọc — bấm "Đã đọc" trên board hoặc ✅ trên Telegram:\n${lines.join('\n')}`, source: 'task-ack' });
    for (const m of remind) m.task.ackRemindedAt = new Date().toISOString();
    persistMessages();
    console.log(`[ack] reminder #${msg.id} (${remind.length} task)`);
    forwardToTelegram(msg);
    for (const m of remind) appendAudit({ action: 'task.ack.reminder', sender: 'bridge', messageId: m.id, source: 'task-ack' });
  }
  if (escalate.length > 0) {
    const lines = escalate.map((m) => `#${m.id} @${m.task.assignee} — ${String(m.text).split('\n')[0].slice(0, 80)}`);
    const msg = addMessage({ sender: 'bridge', text: `[bridge] Task chưa ack — @martin xem giúp: các task sau đã giao quá ${TASK_ACK_TIMEOUT_MINUTES * 2} phút chưa xác nhận đã đọc (đã nhắc 1 lần):\n${lines.join('\n')}`, source: 'task-ack' });
    for (const m of escalate) m.task.ackEscalatedAt = new Date().toISOString();
    persistMessages();
    console.log(`[ack] escalate #${msg.id} (${escalate.length} task)`);
    forwardToTelegram(msg);
    for (const m of escalate) appendAudit({ action: 'task.ack.escalate', sender: 'bridge', messageId: m.id, source: 'task-ack' });
  }
}

// ---------- Task lifecycle sweeps (v1.9.0) ----------
// Chạy mỗi phút (xem server.listen): (1) nhả các khóa task đã hết hạn —
// mỗi khóa chỉ đăng 1 tin mở lại duy nhất vì sau khi nhả thì lockedBy
// đã mất; (2) nhắc task quá hạn / hạn hôm nay — mỗi task chỉ nhắc 1 lần
// / ngày (ghi task.remindedAt), gom chung 1 tin.
function sweepTaskLocks() {
  const released = [];
  for (const m of messages) {
    const t = m.task;
    if (!t || !t.lockedBy || !lockStale(t)) continue;
    const holder = t.lockedBy;
    const ageMin = lockAgeMin(t);
    delete t.lockedBy;
    delete t.lockedAt;
    released.push({ id: m.id, holder, ageMin, text: m.text });
  }
  if (released.length === 0) return;
  persistMessages();
  for (const r of released) {
    appendAudit({ action: 'task.lock.timeout', sender: 'bridge', messageId: r.id, source: 'lifecycle' });
  }
  const lines = released.map((r) => `#${r.id} (đang do ${r.holder} giữ, ${r.ageMin} phút không hoạt động): ${String(r.text).split('\n')[0].slice(0, 80)}`);
  const msg = addMessage({ sender: 'bridge', text: `[bridge] Khóa task đã hết hạn (${TASK_LOCK_TIMEOUT_MINUTES} phút không hoạt động) — đã mở lại để Muse khác nhận:\n${lines.join('\n')}`, source: 'task-lifecycle' });
  console.log(`[lifecycle] released ${released.length} stale lock(s) as #${msg.id}`);
  forwardToTelegram(msg);
}

function sweepTaskReminders() {
  if (!TASK_REMINDER_ENABLED) return;
  const today = localDayKey();
  const overdue = [];
  const dueToday = [];
  for (const m of messages) {
    const t = m.task;
    if (!t || (t.status !== 'todo' && t.status !== 'doing')) continue;
    if (t.remindedAt === today) continue; // đã nhắc hôm nay
    const bucket = deadlineBucket(m);
    if (bucket === 'overdue') overdue.push(m);
    else if (bucket === 'today') dueToday.push(m);
  }
  if (overdue.length === 0 && dueToday.length === 0) return;
  const lines = [];
  if (overdue.length > 0) lines.push(`Quá hạn (${overdue.length}): ${overdue.map((m) => `#${m.id} [${m.task.assignee || 'chưa giao'}]`).join(', ')}`);
  if (dueToday.length > 0) lines.push(`Hạn hôm nay (${dueToday.length}): ${dueToday.map((m) => `#${m.id} [${m.task.assignee || 'chưa giao'}]`).join(', ')}`);
  for (const m of [...overdue, ...dueToday]) m.task.remindedAt = today;
  const msg = addMessage({ sender: 'bridge', text: `[bridge] Nhắc task sắp hết hạn / quá hạn:\n${lines.join('\n')}`, source: 'task-lifecycle' });
  persistMessages();
  console.log(`[lifecycle] reminder #${msg.id} (overdue ${overdue.length}, due today ${dueToday.length})`);
  forwardToTelegram(msg);
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
// ---------- Xác nhận bằng reaction ✅ (v1.13.0, ý 3 của Muse A ở #282) ----------
// Martin bấm ✅ vào tin gốc trên Telegram → bridge ghi 'martin' vào
// read_by VÀ confirmed_by của tin board tương ứng (tra qua
// telegramMessageId đã lưu lúc forwardToTelegram). Reaction khác ✅
// chỉ ghi đã đọc. Gỡ ✅ thì gỡ xác nhận (vẫn giữ đã đọc). Không gửi
// thêm tin Telegram nào, không đăng gì lên thread — chỉ ghi audit để
// Martin kiểm tra lại được. Tin không phải do bridge forward (không
// có telegramMessageId) thì bỏ qua.
async function handleTelegramReaction(reaction) {
  if (!TELEGRAM_REACTION_CONFIRM_ENABLED) return;
  if (!reaction || typeof reaction !== 'object') return;
  if (String(reaction.chat?.id) !== String(TELEGRAM_CHAT_ID)) return;
  const tgMsgId = reaction.message_id;
  if (tgMsgId === undefined || tgMsgId === null) return;
  const msg = messages.find((m) => m.telegramMessageId === tgMsgId);
  if (!msg) return;
  const newEmojis = (reaction.new_reaction || [])
    .map((r) => (r && typeof r === 'object' ? r.emoji : null))
    .filter(Boolean);
  const hasCheck = newEmojis.includes('✅');
  let changed = false;
  // Reaction nào cũng nghĩa là đã đọc tin đó.
  if (newEmojis.length > 0) {
    msg.read_by = msg.read_by || [];
    if (!msg.read_by.includes('martin')) {
      msg.read_by.push('martin');
      changed = true;
    }
  }
  // Chỉ ✅ mới là xác nhận.
  msg.confirmed_by = msg.confirmed_by || [];
  if (hasCheck && !msg.confirmed_by.includes('martin')) {
    msg.confirmed_by.push('martin');
    changed = true;
    appendAudit({ action: 'message.reaction-confirm', sender: 'martin', messageId: msg.id, source: 'telegram' });
    console.log(`[telegram] reaction ✅ #${msg.id} martin đã xác nhận`);
  } else if (!hasCheck && msg.confirmed_by.includes('martin')) {
    msg.confirmed_by = msg.confirmed_by.filter((r) => r !== 'martin');
    changed = true;
    appendAudit({ action: 'message.reaction-confirm-removed', sender: 'martin', messageId: msg.id, source: 'telegram' });
    console.log(`[telegram] reaction ✅ gỡ #${msg.id} martin đã gỡ xác nhận`);
  }
  if (changed) persistMessages();
}

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
    // allowed_updates (v1.13.0): mặc định Bot API KHÔNG gửi message_reaction
    // — phải liệt kê rõ thì Martin bấm ✅ mới về tới bridge. Chỉ liệt kê
    // các loại bridge đang xử lý (message, channel_post, callback_query,
    // message_reaction); loại không liệt kê sẽ không được gửi nữa.
    const allowedUpdates = encodeURIComponent(JSON.stringify(['message', 'channel_post', 'callback_query', 'message_reaction']));
    const url = tgApi('getUpdates') + `?timeout=0&offset=${tgOffset}&allowed_updates=${allowedUpdates}`;
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
      // Reaction ✅ (v1.13.0, ý 3 của Muse A ở #282): Martin bấm ✅ vào
      // tin gốc trên Telegram để xác nhận đã đọc — ghi lên tin board,
      // không gửi thêm tin nào, không đăng gì lên thread.
      if (upd.message_reaction) {
        await handleTelegramReaction(upd.message_reaction);
        continue;
      }
      // Nút inline (v1.4.0): callback_query từ nút dưới tin task. Chỉ nhận
      // từ chat đã cấu hình; dữ liệu sai thì bỏ qua, không đăng gì.
      if (upd.callback_query) {
        const cq = upd.callback_query;
        if (String(cq.message?.chat?.id) !== String(TELEGRAM_CHAT_ID)) continue;
        if (!TELEGRAM_COMMANDS_ENABLED) continue;
        const parsed = parseCallbackData(cq.data);
        if (!parsed) continue;
        const answerCallback = async (text) => {
          try { await fetch(tgApi('answerCallbackQuery'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callback_query_id: cq.id, text: String(text || '').slice(0, 200) }) }); } catch {}
        };
        // Menu /start (v1.13.0): bấm 1 mục thì sửa ngay tin menu thành
        // nội dung mục đó, giữ nguyên bàn phím để bấm tiếp; sửa lỗi
        // (tin đã bị sửa giống hệt / quá cũ) thì gửi tin mới thay thế.
        if (parsed.kind === 'menu') {
          const text = parsed.section === 'main' ? MENU_TEXT : await buildMenuSectionText(parsed.section);
          const edited = await editTelegramMessage(cq.message.chat.id, cq.message.message_id, text, menuKeyboard());
          if (!edited) await sendToTelegram(text, menuKeyboard());
          await answerCallback('Đã cập nhật');
          continue;
        }
        // Nút PR (v1.9.0): ✅ Duyệt / 🔀 Merge — xem handlePrApproval.
        if (parsed.kind === 'pr') {
          const r = await handlePrApproval({ repo: parsed.repo, number: parsed.number, action: parsed.action, via: 'nút Telegram' });
          await answerCallback(r.ok ? 'Đã ghi nhận' : 'Chưa merge được — xem thread');
          if (r.reply) await sendToTelegram(r.reply);
          continue;
        }
        // Nút Nhận việc / Nhả việc (v1.9.0): Martin khóa / nhả task.
        if (parsed.kind === 'claim' || parsed.kind === 'release') {
          const r = parsed.kind === 'claim'
            ? claimTask(parsed.id, 'martin', 'telegram')
            : releaseTask(parsed.id, 'martin', 'telegram');
          if (r.ok) {
            const m = r.message;
            const confirm = parsed.kind === 'claim'
              ? `[telegram] Martin đã nhận task #${m.id} [${m.task.status} · 🔒 martin] (nút Telegram): ${String(m.text).split('\n')[0].slice(0, 100)}`
              : `[telegram] Martin đã nhả khóa task #${m.id} [${m.task.status}] (nút Telegram): ${String(m.text).split('\n')[0].slice(0, 100)}`;
            const msg = addMessage({ sender: 'martin', text: confirm, source: 'telegram' });
            console.log(`[telegram] callback #${msg.id} ${parsed.kind} #${m.id}`);
            await answerCallback('Đã cập nhật');
          } else {
            await answerCallback(r.error);
            await sendToTelegram(`Không ${parsed.kind === 'claim' ? 'nhận' : 'nhả'} được task #${parsed.id}: ${r.error}`);
          }
          continue;
        }
        const r = applyTaskUpdate(parsed);
        if (r.ok) {
          const m = r.message;
          const confirm = `[telegram] Martin đã đổi #${m.id} sang ${m.task.status}${m.task.assignee ? ' · ' + m.task.assignee : ''} (nút Telegram): ${String(m.text).split('\n')[0].slice(0, 100)}`;
          const msg = addMessage({ sender: 'martin', text: confirm, source: 'telegram' });
          console.log(`[telegram] callback #${msg.id} #${m.id} -> ${m.task.status}`);
          await answerCallback('Đã cập nhật');
        } else {
          await answerCallback(r.error);
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
      // /start (v1.13.0) trả {text, replyMarkup} để gửi kèm bàn phím menu.
      if (TELEGRAM_COMMANDS_ENABLED) {
        const parsed = parseTelegramCommand(m.text);
        if (parsed) {
          const reply = await handleTelegramCommand(parsed);
          if (reply) {
            if (typeof reply === 'object') await sendToTelegram(reply.text, reply.replyMarkup);
            else await sendToTelegram(reply);
          }
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
  const lock = m.task.lockedBy
    ? ` · 🔒 ${esc(m.task.lockedBy)}${lockStale(m.task) ? ' (khóa hết hạn)' : ''}`
    : '';
  // Ưu tiên (v1.10.0): chỉ hiện khi high/low — medium là mặc định, không
  // cần chiếm chỗ trên badge.
  const priority = taskPriority(m.task) !== 'medium' ? ` · ưu tiên ${esc(taskPriority(m.task))}` : '';
  // Liên kết Issue (v1.11.0): chip link tới Issue + cờ chờ đồng bộ.
  const issue = m.task.issue
    ? ` <span style="background:#e6f4ea;border:1px solid #a7d7b5;border-radius:4px;padding:1px 6px;font-size:12px"><a href="${esc(m.task.issue.url)}">Issue #${esc(m.task.issue.number)} (${esc(m.task.issue.state || 'open')})</a></span>`
    : (m.task.issuePending ? ' <span style="background:#fef3c7;border:1px solid #fcd34d;border-radius:4px;padding:1px 6px;font-size:12px">⏳ chờ đồng bộ Issue</span>' : '');
  return ` <span style="background:#eef;border:1px solid #ccd;border-radius:4px;padding:1px 6px;font-size:12px">[${esc(m.task.status || 'todo')}${assignee}${deadline}${lock}${priority}]</span>${issue}`;
}

// Số vote (v1.10.0): chỉ hiện khi có ít nhất 1 vote.
function voteBadge(m) {
  const n = voteCount(m);
  if (n === 0) return '';
  return ` <span style="background:#dcfce7;border:1px solid #86efac;border-radius:4px;padding:1px 6px;font-size:12px">👍 ${n}</span>`;
}

// @mention + read receipt (v1.5.0): chip @muse-b... và dòng "Đã đọc: ...".
function mentionBadge(m) {
  if (!m.mentions || m.mentions.length === 0) return '';
  return ` <span style="background:#fef3c7;border:1px solid #fcd34d;border-radius:4px;padding:1px 6px;font-size:12px">${m.mentions.map((x) => '@' + esc(x)).join(' ')}</span>`;
}

function readBadge(m) {
  if ((!m.read_by || m.read_by.length === 0) && (!m.confirmed_by || m.confirmed_by.length === 0)) return '';
  const read = (m.read_by && m.read_by.length) ? `Đã đọc: ${m.read_by.map(esc).join(', ')}` : '';
  const confirmed = (m.confirmed_by && m.confirmed_by.length) ? ` · ✅ ${m.confirmed_by.map(esc).join(', ')} đã xác nhận` : '';
  return `<div style="color:#888;font-size:12px;margin-top:4px">${read}${confirmed}</div>`;
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
  // Nhận việc / Nhả việc (v1.9.0): claim khóa task cho sender đang chọn
  // trong form (todo → doing), release nhả khóa. Task bị người khác khóa
  // thì server trả 409 kèm tên người giữ.
  const claimBtns = m.task
    ? ` <button type="button" data-action="claim" data-id="${m.id}" title="Nhận việc #${m.id} (khóa task cho bạn, todo → doing)">Nhận việc</button>`
      + ` <button type="button" data-action="release" data-id="${m.id}" title="Nhả khóa task #${m.id}">Nhả việc</button>`
    : '';
  // Tạo Issue (v1.11.0): chỉ hiện khi task chưa liên kết Issue; bấm
  // thì JS gọi POST /api/messages/:id/sync-issue (chưa có token thì
  // đưa vào hàng chờ, không tạo trùng khi bấm lại).
  const issueBtn = (m.task && !m.task.issue)
    ? ` <button type="button" data-action="sync-issue" data-id="${m.id}" title="Tạo Issue trên GitHub cho task #${m.id} (chưa có GITHUB_TOKEN thì đưa vào hàng chờ)">Tạo Issue</button>`
    : '';
  // Lưu trữ / khôi phục (v1.12.0): nút JS gọi POST
  // /api/messages/:id/archive|unarchive; form không-JS nằm trong
  // renderRow (như nút Ghim). Tin đã lưu trữ thì chỉ còn nút Khôi phục.
  const archiveBtn = m.archived
    ? ` <button type="button" data-action="unarchive" data-id="${m.id}" title="Khôi phục tin #${m.id} về thread">Khôi phục</button>`
    : ` <button type="button" data-action="archive" data-id="${m.id}" title="Lưu trữ tin #${m.id} vào Lịch sử (chỉ khi đã đọc + đã xử lý xong và cũ hơn 24h)">Lưu trữ</button>`;
  return `<div class="msg-actions" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">`
    + `<button type="button" data-action="reply" data-id="${m.id}" title="Trả lời tin #${m.id} (điền vào form bên dưới)">Trả lời</button>`
    + ` <button type="button" data-action="read" data-id="${m.id}" title="Đánh dấu đã đọc (theo sender đang chọn trong form)">Đã đọc</button>`
    + ` <button type="button" data-action="vote" data-id="${m.id}" title="Bình chọn / rút vote cho tin #${m.id} (theo sender đang chọn trong form)">👍 Bình chọn${voteCount(m) ? ` (${voteCount(m)})` : ''}</button>`
    + (statusBtns ? ` ${statusBtns}` : '') + assignSelect + claimBtns + issueBtn + archiveBtn
    + ` <button type="button" data-action="copy" data-id="${m.id}" title="Copy link tới tin #${m.id}">Copy link</button>`
    + `</div>`;
}

function renderRow(m) {
  const reply = m.reply_to ? `<div style="color:#888;font-size:12px">Trả lời #${m.reply_to}</div>` : '';
  const type = m.type ? `<span style="color:#888;font-size:12px">[${esc(m.type)}]</span> ` : '';
  const pinBtn = `<form method="POST" action="/b/${esc(BRIDGE_TOKEN)}/pin" style="display:inline;margin:0">
    <input type="hidden" name="id" value="${m.id}">
    <input type="hidden" name="pinned" value="${m.pinned ? '0' : '1'}">
    <button type="submit" style="font-size:12px">${m.pinned ? 'Bỏ ghim' : 'Ghim'}</button>
  </form>`;
  // Bình chọn không cần JS (v1.10.0): form chọn người vote rồi bấm 👍;
  // có JS thì nút "👍 Bình chọn" trong thao tác nhanh dùng sender đang
  // chọn trong form soạn tin, không cần chọn lại ở đây.
  const voteForm = `<form method="POST" action="/b/${esc(BRIDGE_TOKEN)}/vote" style="display:inline;margin:0">
    <input type="hidden" name="id" value="${m.id}">
    <select name="voter" style="font-size:12px" title="Bạn là ai? (để bình chọn)">
      <option value="">— bạn là ai —</option>
      <option value="muse-a">muse-a</option>
      <option value="muse-b">muse-b</option>
      <option value="muse-c">muse-c</option>
      <option value="martin">martin</option>
    </select>
    <button type="submit" style="font-size:12px">👍 Bình chọn${voteCount(m) ? ` (${voteCount(m)})` : ''}</button>
  </form>`;
  const pinMark = m.pinned ? ` <span style="background:#fef3c7;border:1px solid #fcd34d;border-radius:4px;padding:1px 6px;font-size:12px">📌 đã ghim</span>` : '';
  // Lưu trữ không cần JS (v1.12.0): form Lưu trữ / Khôi phục, như form
  // Ghim/Bỏ ghim ở trên; có JS thì nút trong thao tác nhanh làm việc
  // này mà không reload trang.
  const archiveMark = m.archived ? ` <span style="background:#e5e7eb;border:1px solid #9ca3af;border-radius:4px;padding:1px 6px;font-size:12px">📦 đã lưu trữ${m.archivedAt ? ` · ${esc(m.archivedAt.slice(0, 10))}` : ''}</span>` : '';
  const archiveForm = `<form method="POST" action="/b/${esc(BRIDGE_TOKEN)}/${m.archived ? 'unarchive' : 'archive'}" style="display:inline;margin:0">
    <input type="hidden" name="id" value="${m.id}">
    <button type="submit" style="font-size:12px">${m.archived ? 'Khôi phục' : 'Lưu trữ'}</button>
  </form>`;
  const body = `<div style="white-space:pre-wrap;margin-top:4px">${type}${esc(m.text)}</div>${githubDetails(m)}`;
  return `
    <div id="msg-${m.id}" style="margin:0 0 10px;padding:10px;border:1px solid #ddd;border-radius:8px">
      <b>#${m.id} ${esc(m.sender)}</b>${taskBadge(m)}${voteBadge(m)}${mentionBadge(m)}${pinMark}${archiveMark}
      <span style="color:#888;font-size:12px">${esc(m.ts)} · ${esc(m.source)}</span> ${pinBtn} ${voteForm} ${archiveForm}
      ${reply}
      ${body}
      ${readBadge(m)}
      ${renderActions(m)}
    </div>`;
}

// Thẻ GitHub mở rộng (v1.7.0): tin webhook có dữ liệu event (msg.github)
// thì hiện <details> với tóm tắt diff — push: từng commit + số file đổi;
// PR/issue/release: số, tiêu đề, trạng thái, link. Tin GitHub cũ (không
// có msg.github) chỉ hiện text như trước.
function githubDetails(m) {
  const g = m.github;
  if (!g || typeof g !== 'object') return '';
  if (g.event === 'push') {
    const commits = (g.commits || []).map((c) => {
      const files = [c.added ? `+${c.added} thêm` : '', c.modified ? `${c.modified} sửa` : '', c.removed ? `-${c.removed} xóa` : ''].filter(Boolean).join(', ');
      return `<li><code>${esc(c.sha || '')}</code> ${esc(c.message || '')}${c.author ? ` — ${esc(c.author)}` : ''}${files ? ` (${files})` : ''}</li>`;
    }).join('');
    return `<details style="margin-top:6px"><summary style="cursor:pointer">Chi tiết push — ${g.commits?.length || 0} commit${g.branch ? ` @ ${esc(g.branch)}` : ''}${g.compare ? ` · <a href="${esc(g.compare)}">compare</a>` : ''}</summary><ul>${commits || '<li><i>Không có commit nào trong payload.</i></li>'}</ul></details>`;
  }
  if (g.event === 'pull_request' || g.event === 'issues' || g.event === 'issue_comment') {
    const kind = g.event === 'pull_request' ? 'PR' : 'Issue';
    const extra = (g.event === 'issue_comment'
      ? `${g.commentBy ? ` · bình luận bởi ${esc(g.commentBy)}` : ''}${g.commentBody ? `<div style="margin-top:4px;white-space:pre-wrap">“${esc(String(g.commentBody).split('\n')[0].slice(0, 200))}”</div>` : ''}`
      : '')
      + (g.state ? ` · Issue đang ${esc(g.state)}` : '')
      + (g.labels?.length ? ` · nhãn: ${g.labels.map(esc).join(', ')}` : '')
      + (g.linkedMessageId ? ` · liên kết task #${esc(g.linkedMessageId)}` : '')
      + (g.taskSynced ? ` · task #${esc(g.taskSynced.messageId)} đã đổi ${esc(g.taskSynced.from)} → ${esc(g.taskSynced.to)}` : '');
    return `<details style="margin-top:6px"><summary style="cursor:pointer">${kind} #${esc(g.number ?? '')} — ${esc(g.title || '')}</summary><div>Trạng thái: ${esc(g.action || '')}${g.merged ? ' (đã merge)' : ''}${g.head && g.base ? ` · ${esc(g.head)} → ${esc(g.base)}` : ''}${g.author ? ` · bởi ${esc(g.author)}` : ''}${g.url ? ` · <a href="${esc(g.url)}">${esc(g.url)}</a>` : ''}${extra}</div></details>`;
  }
  if (g.event === 'release') {
    return `<details style="margin-top:6px"><summary style="cursor:pointer">Release ${esc(g.tag || '')} — ${esc(g.title || '')}</summary><div>Trạng thái: ${esc(g.action || '')}${g.author ? ` · bởi ${esc(g.author)}` : ''}${g.url ? ` · <a href="${esc(g.url)}">${esc(g.url)}</a>` : ''}</div></details>`;
  }
  return '';
}

// Panel trạng thái hệ thống trên board (v1.7.0): bridge status + main
// HEAD + PR đang mở + deploy lần cuối. openPrs === null nghĩa là GitHub
// API không lấy được (không mạng / hết quota) — báo rõ, không giấu.
function renderStatusPanel(s) {
  const wd = s.watchdog;
  const wdText = wd
    ? `kiểm tra cuối ${esc(wd.checkedAt || '—')} · bridge ${wd.bridgeOk ? 'đang chạy' : 'CHẾT'} · cloudflared ${wd.cloudflaredOk ? 'đang chạy' : 'CHẾT'} · đã restart ${esc(String(wd.restarts ?? 0))} lần`
    : 'chưa chạy lần nào';
  const head = s.head
    ? `<a href="https://github.com/tuanxminhxgi/muse2muse/commit/${esc(s.head)}"><code>${esc(s.head.slice(0, 7))}</code></a>`
    : 'không lấy được';
  const prs = s.openPrs === null
    ? 'không lấy được (GitHub API lỗi / không mạng)'
    : s.openPrs.length === 0
      ? 'không có PR nào đang mở'
      : `<ul style="margin:4px 0">${s.openPrs.map((pr) => `<li><a href="${esc(pr.url)}">PR #${pr.number}</a> ${esc(pr.title)}${pr.author ? ` — ${esc(pr.author)}` : ''}</li>`).join('')}</ul>`;
  const deploy = s.deploy.enabled
    ? `${s.deploy.lastDeployAt ? `lần cuối ${esc(s.deploy.lastDeployAt)} (${esc(String(s.deploy.lastDeploySha || '').slice(0, 7))}) — ${esc(s.deploy.lastDeployResult || '')}` : 'chưa deploy lần nào'} (nhánh ${esc(s.deploy.branch)})`
    : 'TẮT (chưa đặt GITHUB_WEBHOOK_SECRET)';
  const lifecycle = s.lifecycle
    ? `${esc(String(s.lifecycle.lockedTasks))} task đang khóa · ${esc(String(s.lifecycle.staleLocks))} khóa hết hạn (timeout ${esc(String(s.lifecycle.lockTimeoutMinutes))} phút) · nhắc hạn ${s.lifecycle.reminderEnabled ? 'BẬT' : 'TẮT'}`
    : '—';
  return `<div style="border:1px solid #ddd;border-radius:8px;padding:10px;margin:0 0 16px">
<h2 style="margin:0 0 8px">Trạng thái hệ thống</h2>
<table cellpadding="4" cellspacing="0">
<tr><td>Bridge</td><td>v${esc(s.version)} · chạy từ ${esc(s.startedAt)} (uptime ${esc(String(s.uptime_s))}s) · ${s.messages} tin · ${s.openTasks} task đang mở</td></tr>
<tr><td>Telegram</td><td>${s.telegram ? 'BẬT' : 'TẮT'}${s.lastTelegramError ? ` · lỗi cuối: ${esc(s.lastTelegramError)}` : ''}</td></tr>
<tr><td>Watchdog</td><td>${wdText}</td></tr>
<tr><td>Main HEAD</td><td>${head}</td></tr>
<tr><td>PR đang mở</td><td>${prs}</td></tr>
<tr><td>Deploy cuối</td><td>${deploy}</td></tr>
<tr><td>Task lifecycle</td><td>${lifecycle}</td></tr>
</table>
</div>`;
}

// Mục ghim + quyết định ở đầu board (v1.7.0): tin được ghim tay (cờ
// pinned), việc đang giao (task todo/doing có assignee), và quyết định
// đã chốt (tin type=decision, mới nhất trước, kèm ngày + link về tin gốc).
function renderTopSections() {
  const pinned = messages.filter((m) => m.pinned);
  const assigned = openTasks().filter((m) => m.task.assignee).slice(-10);
  // Lịch sử (v1.12.0): quyết định đã lưu trữ thì không liệt kê ở đây
  // (link #msg-<id> sẽ trỏ tới tin không còn trong thread).
  const decisions = messages.filter((m) => m.type === 'decision' && !m.archived).slice(-10).reverse();
  const link = (m, label) => `<li><a href="#msg-${m.id}">#${m.id}</a> ${label} <span style="color:#888;font-size:12px">${esc(m.ts.slice(0, 10))} · ${esc(m.sender)}</span></li>`;
  let html = '';
  if (pinned.length > 0) {
    html += `<h2>📌 Đã ghim</h2><ul>${pinned.map((m) => link(m, esc(String(m.text).split('\n')[0].slice(0, 120)))).join('')}</ul>`;
  }
  if (assigned.length > 0) {
    html += `<h2>Việc đang giao (${assigned.length})</h2><ul>${assigned.map((m) => link(m, `[${esc(m.task.status)} · ${esc(m.task.assignee)}${m.task.deadline ? ` · hạn ${esc(m.task.deadline)}` : ''}] ${esc(String(m.text).split('\n')[0].slice(0, 100))}`)).join('')}</ul>`;
  }
  if (decisions.length > 0) {
    html += `<h2>Quyết định đã chốt (${decisions.length})</h2><ul>${decisions.map((m) => link(m, esc(String(m.text).split('\n')[0].slice(0, 140)))).join('')}</ul>`;
  }
  return html;
}

// Kanban (v1.7.0): 4 cột theo trạng thái task, mỗi task là 1 thẻ có
// assignee, deadline (quá hạn tô đỏ), link về tin gốc. Lọc theo assignee
// / status / deadline qua query (?view=kanban&fassignee=&fstatus=
// &fdeadline=). Chỉ task mới vào Kanban; tin thường vẫn ở Thread.
function renderKanban(filters) {
  const tasks = messages.filter((m) => m.task
    && (!filters.assignee || m.task.assignee === filters.assignee)
    && (!filters.status || m.task.status === filters.status)
    && matchDeadlineFilter(m, filters.deadline));
  const cols = TASK_STATUSES.map((status) => {
    const list = tasks.filter((m) => m.task.status === status);
    const cards = list.map((m) => {
      const overdue = deadlineBucket(m) === 'overdue' && (status === 'todo' || status === 'doing');
      const first = esc(String(m.text).split('\n')[0].slice(0, 120));
      const lockLine = m.task.lockedBy
        ? `<div style="color:#888;font-size:12px;margin-top:4px">🔒 ${esc(m.task.lockedBy)}${lockStale(m.task) ? ' (khóa hết hạn)' : ''}</div>`
        : '';
      const issueLine = m.task.issue
        ? `<div style="font-size:12px;margin-top:4px"><a href="${esc(m.task.issue.url)}">Issue #${esc(m.task.issue.number)} (${esc(m.task.issue.state || 'open')})</a></div>`
        : (m.task.issuePending ? '<div style="font-size:12px;margin-top:4px">⏳ chờ đồng bộ Issue</div>' : '');
      return `<div style="border:1px solid #ddd;border-radius:8px;padding:8px;margin:0 0 8px;background:#fff">
        <b><a href="/b/${esc(BRIDGE_TOKEN)}#msg-${m.id}">#${m.id}</a></b> ${esc(m.sender)}
        <div style="margin-top:4px">${first}</div>${lockLine}${issueLine}
        <div style="color:#888;font-size:12px;margin-top:4px">${m.task.assignee ? `Giao: ${esc(m.task.assignee)} · ` : ''}${m.task.deadline ? `<span${overdue ? ' style="color:#c00;font-weight:bold"' : ''}>Hạn: ${esc(m.task.deadline)}${overdue ? ' (quá hạn)' : ''}</span>` : 'Chưa có hạn'}</div>
      </div>`;
    }).join('') || '<p style="color:#888;font-size:12px"><i>Không có task nào.</i></p>';
    return `<div style="flex:1;min-width:160px;border:1px solid #ddd;border-radius:8px;padding:8px;background:#f9f9f9">
      <h3 style="margin:0 0 8px">${esc(status)} (${list.length})</h3>${cards}</div>`;
  }).join('');
  return `<div style="display:flex;gap:8px;align-items:flex-start">${cols}</div>`;
}

function filterForm(f) {
  const opt = (value, current, label) => `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`;
  const assignees = ['muse-a', 'muse-b', 'muse-c', 'martin'];
  return `<form method="GET" action="/b/${esc(BRIDGE_TOKEN)}" style="margin:0 0 16px">
  <input type="hidden" name="view" value="kanban">
  <label>Giao cho: <select name="fassignee">${opt('', f.assignee, '— tất cả —')}${assignees.map((a) => opt(a, f.assignee, a)).join('')}</select></label>
  <label> Trạng thái: <select name="fstatus">${opt('', f.status, '— tất cả —')}${TASK_STATUSES.map((s) => opt(s, f.status, s)).join('')}</select></label>
  <label> Hạn: <select name="fdeadline">${opt('all', f.deadline, '— tất cả —')}${opt('overdue', f.deadline, 'Quá hạn')}${opt('today', f.deadline, 'Hôm nay')}${opt('week', f.deadline, 'Trong 7 ngày')}${opt('none', f.deadline, 'Chưa có hạn')}</select></label>
  <button type="submit">Lọc</button>
  <a href="/b/${esc(BRIDGE_TOKEN)}?view=kanban">Xóa lọc</a>
</form>`;
}

// Đã ghim & Quyết định — tra cứu riêng (v1.8.0): gộp tin đã ghim (cờ
// pinned, v1.7.0) và tin type=decision (v1.5.0) thành 1 danh sách lưu
// riêng, mới nhất trước. kind: 'all' (cả hai), 'pinned', 'decision'.
// q: từ khóa khớp không phân biệt hoa thường trong nội dung tin.
// sender: lọc đúng người gửi (rỗng = tất cả).
function filterSaved({ q = '', sender = '', kind = 'all' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return messages.filter((m) => {
    if (kind === 'pinned' && !m.pinned) return false;
    if (kind === 'decision' && m.type !== 'decision') return false;
    if (kind !== 'pinned' && kind !== 'decision' && !(m.pinned || m.type === 'decision')) return false;
    if (sender && m.sender !== sender) return false;
    if (needle && !String(m.text || '').toLowerCase().includes(needle)) return false;
    return true;
  }).slice().reverse();
}

function savedFilterForm(f) {
  const opt = (value, current, label) => `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`;
  return `<form method="GET" action="/b/${esc(BRIDGE_TOKEN)}" style="margin:0 0 16px">
  <input type="hidden" name="view" value="saved">
  <label>Tìm: <input name="q" type="text" value="${esc(f.q)}" placeholder="từ khóa trong tin…" style="width:200px"></label>
  <label> Người gửi: <select name="fsender">${opt('', f.sender, '— tất cả —')}${SENDERS.map((s) => opt(s, f.sender, s)).join('')}</select></label>
  <label> Loại: <select name="fkind">${opt('all', f.kind, 'Đã ghim + Quyết định')}${opt('pinned', f.kind, 'Chỉ tin đã ghim')}${opt('decision', f.kind, 'Chỉ quyết định')}</select></label>
  <button type="submit">Tìm</button>
  <a href="/b/${esc(BRIDGE_TOKEN)}?view=saved">Xóa lọc</a>
</form>`;
}

// Chế độ xem "Đã ghim & Quyết định" (v1.8.0): toàn bộ tin đã lưu, hiện
// đủ nội dung bằng renderRow (kèm nút Ghim/Bỏ ghim + thao tác nhanh),
// mỗi tin có link #msg-<id> về thread. Trống thì báo rõ, không giấu.
function renderSaved(filters) {
  const list = filterSaved(filters);
  const pinnedCount = messages.filter((m) => m.pinned).length;
  const decisionCount = messages.filter((m) => m.type === 'decision').length;
  const rows = list.map(renderRow).join('')
    || '<p><i>Không tìm thấy tin nào khớp. Thử xóa từ khóa hoặc đổi bộ lọc.</i></p>';
  return `<h2>📌 Đã ghim &amp; Quyết định (${list.length} tin)</h2>
<p style="color:#888;font-size:12px">Đã ghim: ${pinnedCount} tin · Quyết định đã chốt: ${decisionCount} tin. Bấm số tin để về thread.</p>
${savedFilterForm(filters)}
${rows}`;
}

function historyFilterForm(f) {
  const opt = (value, current, label) => `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`;
  return `<form method="GET" action="/b/${esc(BRIDGE_TOKEN)}" style="margin:0 0 16px">
  <input type="hidden" name="view" value="history">
  <label>Tìm: <input name="q" type="text" value="${esc(f.q)}" placeholder="từ khóa trong tin…" style="width:200px"></label>
  <label> Người gửi: <select name="fsender">${opt('', f.sender, '— tất cả —')}${SENDERS.map((s) => opt(s, f.sender, s)).join('')}</select></label>
  <button type="submit">Tìm</button>
  <a href="/b/${esc(BRIDGE_TOKEN)}?view=history">Xóa lọc</a>
</form>`;
}

// Chế độ xem "Lịch sử" (v1.12.0): toàn bộ tin đã lưu trữ, mới nhất
// trước, hiện đủ nội dung bằng renderRow (kèm nút Khôi phục), mỗi tin
// có link #msg-<id> về thread. Lưu trữ không xóa dữ liệu nên tin ở đây
// vẫn đọc, tìm và khôi phục được. Trống thì báo rõ, không giấu.
function renderHistory(filters) {
  const list = filterHistory(filters);
  const rows = list.map(renderRow).join('')
    || '<p><i>Chưa có tin nào trong Lịch sử. Tin đã đọc + đã xử lý xong và cũ hơn 24h sẽ vào đây khi bấm "Lưu trữ tin đã đọc xong" hoặc nút Lưu trữ dưới từng tin.</i></p>';
  return `<h2>🗄️ Lịch sử (${list.length} tin đã lưu trữ)</h2>
<p style="color:#888;font-size:12px">Tin đã đọc + đã xử lý xong, cũ hơn 24h. Bấm Khôi phục để đưa tin về lại thread.</p>
${historyFilterForm(filters)}
${rows}`;
}

// Hàng đợi ưu tiên (v1.10.0): task đang mở xếp theo ưu tiên (high trước)
// rồi số vote, rồi id; tiếp theo là ideas có vote xếp theo vote. Mỗi mục
// link về tin gốc (#msg-<id>) trong thread.
function renderQueue() {
  const q = buildQueue();
  const taskRow = (m) => {
    const first = esc(String(m.text).split('\n')[0].slice(0, 120));
    return `<li><a href="/b/${esc(BRIDGE_TOKEN)}#msg-${m.id}">#${m.id}</a> `
      + `[${esc(m.task.status)} · ưu tiên ${esc(taskPriority(m.task))}`
      + `${m.task.assignee ? ` · ${esc(m.task.assignee)}` : ''}`
      + `${m.task.deadline ? ` · hạn ${esc(m.task.deadline)}` : ''}`
      + ` · 👍 ${voteCount(m)}] ${first} `
      + `<span style="color:#888;font-size:12px">${esc(m.sender)} · ${esc(m.ts.slice(0, 10))}</span></li>`;
  };
  const ideaRow = (m) => {
    const first = esc(String(m.text).split('\n')[0].slice(0, 140));
    return `<li><a href="/b/${esc(BRIDGE_TOKEN)}#msg-${m.id}">#${m.id}</a> `
      + `[👍 ${voteCount(m)} · ${esc((m.voted_by || []).join(', '))}] ${first} `
      + `<span style="color:#888;font-size:12px">${esc(m.sender)} · ${esc(m.ts.slice(0, 10))}</span></li>`;
  };
  return `<h2>⏫ Hàng đợi ưu tiên (${q.tasks.length} task đang mở)</h2>
<p style="color:#888;font-size:12px">Xếp theo ưu tiên (high → medium → low), rồi số vote, rồi số tin. Đổi ưu tiên bằng PATCH /api/messages/:id/task {"priority":"high"} hoặc nút trạng thái trên từng tin; bình chọn bằng nút 👍 dưới mỗi tin, lệnh Telegram /vote &lt;id&gt;.</p>
${q.tasks.length > 0 ? `<ul>${q.tasks.map(taskRow).join('')}</ul>` : '<p><i>Không có task đang mở.</i></p>'}
<h2>💡 Ideas được bình chọn (${q.ideas.length})</h2>
<p style="color:#888;font-size:12px">Tin của Muse/Martin (không phải task) có ít nhất 1 vote, xếp theo vote. Xem toàn bộ ideas (kể cả chưa có vote) qua GET /api/ideas?token=…&amp;sort=votes|new.</p>
${q.ideas.length > 0 ? `<ul>${q.ideas.map(ideaRow).join('')}</ul>` : '<p><i>Chưa có idea nào được bình chọn. Bấm 👍 dưới tin để bình chọn.</i></p>'}`;
}

async function renderPage(query) {
  const view = query.get('view') === 'kanban' ? 'kanban'
    : query.get('view') === 'saved' ? 'saved'
    : query.get('view') === 'queue' ? 'queue'
    : query.get('view') === 'history' ? 'history' : 'thread';
  const filters = {
    assignee: query.get('fassignee') || '',
    status: query.get('fstatus') || '',
    deadline: query.get('fdeadline') || 'all',
  };
  const savedFilters = {
    q: query.get('q') || '',
    sender: query.get('fsender') || '',
    kind: ['pinned', 'decision'].includes(query.get('fkind')) ? query.get('fkind') : 'all',
  };
  const historyFilters = {
    q: query.get('q') || '',
    sender: query.get('fsender') || '',
  };
  const status = await getBoardStatus();
  // Thread mặc định (v1.12.0) chỉ hiện tin đang hoạt động (chưa lưu
  // trữ); tin đã lưu trữ xem ở ?view=history.
  const active = activeMessages();
  const archived = archivedMessages();
  const rows = active.slice(-100).map(renderRow).join('') || '<p><i>Chưa có tin nhắn nào. Martin hãy gửi tin đầu tiên từ Telegram, hoặc Muse A hãy chào Muse B và Muse C.</i></p>';
  const viewToggle = `<p>Chế độ xem: ${view === 'thread' ? '<b>Thread</b>' : `<a href="/b/${esc(BRIDGE_TOKEN)}">Thread</a>`} · ${view === 'kanban' ? '<b>Kanban</b>' : `<a href="/b/${esc(BRIDGE_TOKEN)}?view=kanban">Kanban</a>`} · ${view === 'saved' ? '<b>📌 Đã ghim</b>' : `<a href="/b/${esc(BRIDGE_TOKEN)}?view=saved">📌 Đã ghim</a>`} · ${view === 'queue' ? '<b>⏫ Hàng đợi</b>' : `<a href="/b/${esc(BRIDGE_TOKEN)}?view=queue">⏫ Hàng đợi</a>`} · ${view === 'history' ? '<b>🗄️ Lịch sử</b>' : `<a href="/b/${esc(BRIDGE_TOKEN)}?view=history">🗄️ Lịch sử (${archived.length})</a>`}</p>`;
  const main = view === 'kanban'
    ? `${filterForm(filters)}${renderKanban(filters)}`
    : view === 'saved'
      ? renderSaved(savedFilters)
      : view === 'queue'
        ? renderQueue()
        : view === 'history'
          ? renderHistory(historyFilters)
          : `<h2>Thread (<span id="thread-count">${active.length}</span> tin)</h2>
<p style="color:#888;font-size:12px">Đã lưu trữ: ${archived.length} tin — <a href="/b/${esc(BRIDGE_TOKEN)}?view=history">xem Lịch sử</a>. Tin đã đọc + đã xử lý xong và cũ hơn 24h sẽ được lưu trữ khi bấm nút dưới đây (hoặc nút Lưu trữ dưới từng tin).</p>
<form method="POST" action="/b/${esc(BRIDGE_TOKEN)}/archive-read" style="margin:0 0 12px">
  <button type="submit">Lưu trữ tin đã đọc xong</button>
</form>
<div id="thread">
${rows}
</div>`;
  // Command palette (Ctrl+K) chỉ tìm trong các tin đang hiện trên trang:
  // ở Lịch sử thì tìm trong tin đã lưu trữ, còn lại thì trong tin đang
  // hoạt động — khỏi nhảy tới tin không có trên trang.
  const paletteIndex = view === 'history' ? filterHistory(historyFilters) : active;

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
${renderStatusPanel(status)}
<p>Presence: ${presenceStatus().map((p) => `${p.muse} ${p.online ? 'online' : (p.agoMinutes === null ? 'chưa check-in' : 'online ' + p.agoMinutes + ' phút trước')}`).join(' · ')}</p>
<p>Tóm tắt: ${esc(buildRollingSummary().text)}</p>
${view === 'saved' || view === 'history' ? '' : renderWhatsNew()}
<p>Đang ở đây: <span id="presence-avatars">${renderPresenceAvatars()}</span></p>
<p id="typing-line" style="color:#888;font-size:13px;min-height:18px;margin:4px 0"></p>
<p>Auto-deploy: ${AUTO_DEPLOY_ENABLED && GITHUB_WEBHOOK_SECRET ? 'BẬT' : 'TẮT'}</p>
${view === 'saved' || view === 'history' ? '' : renderTopSections()}
<p><b>Hướng dẫn cho Muse:</b> đọc toàn bộ thread dưới đây, rồi trả lời bằng form bên dưới với đúng sender của bạn (muse-a, muse-b hoặc muse-c). Chỉ trả lời khi có tin mới cần bạn xử lý, hoặc khi Martin giao việc. Đừng lặp lại tin đã có.</p>
${viewToggle}
${main}
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
      <option value="review">review</option>
      <option value="done">done</option>
      <option value="blocked">blocked</option>
    </select>
  </label>
  <label> Ưu tiên:
    <select name="priority">
      <option value="">— không đặt —</option>
      <option value="high">high</option>
      <option value="medium">medium</option>
      <option value="low">low</option>
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
<script>var MSG_INDEX = ${JSON.stringify(paletteIndex.slice(-100).map((m) => ({ id: m.id, sender: m.sender, text: String(m.text).split('\n')[0].slice(0, 80), task: m.task ? m.task.status : null }))).replace(/</g, '\\u003c')};</script>
<p style="color:#888;font-size:12px">API: GET /api/messages?since=&lt;id&gt;&amp;token=... · POST /api/msg {"sender","text","token"} · GET /api/tasks?token=... · GET /api/events?token=... (SSE live) · GET /status · GET /api/digest?token=... · POST /api/github-webhook · GET /api/presence?token=... · POST /api/heartbeat · POST /api/messages/:id/read {"token","reader"} · GET /api/since?token=...&amp;sender=&amp;since= (tóm tắt lăn + tin mới) · POST /api/typing {"token","sender","typing"} · GET /api/board-status?token=... (trạng thái hệ thống cho panel) · POST /api/messages/:id/pin {"token","pinned"} · POST /api/messages/:id/claim|release {"token","sender"} · GET /api/tasks?locked=held|stale|free · GET /api/pinned?token=... (tin đã ghim) · GET /api/decisions?token=...&amp;q=&amp;sender= (quyết định, tìm theo từ khóa + người gửi) · Board: ?view=kanban&amp;fassignee=&amp;fstatus=&amp;fdeadline= (Kanban + lọc task) · ?view=saved&amp;q=&amp;fsender=&amp;fkind= (Đã ghim &amp; Quyết định + tìm kiếm) · ?view=queue (Hàng đợi ưu tiên + ideas được bình chọn) · POST /api/messages/:id/vote {"token","voter"} (bình chọn / rút vote) · GET /api/queue?token=... · GET /api/ideas?token=...&amp;sort=votes|new · GET /api/reviews?token=... (review PR tự động gần nhất) · POST /api/messages/:id/sync-issue {"token"} (tạo Issue GitHub cho task) · GET /api/issues?token=<redacted> (Issue đã liên kết + hàng chờ) · POST /api/issues/retry {"token"} (thử lại hàng chờ) · POST /api/messages/archive-read {"token"} (lưu trữ hàng loạt tin đã đọc xong) · POST /api/messages/:id/archive {"token"} (lưu trữ 1 tin) · POST /api/messages/:id/unarchive {"token"} (khôi phục tin đã lưu trữ) · GET /api/history?token=<redacted>&amp;q=&amp;sender= (tin đã lưu trữ, tìm theo từ khóa + người gửi) · GET /api/messages?archived=true (chỉ tin đã lưu trữ; archived=all = tất cả) · Board: ?view=history&amp;q=&amp;fsender= (Lịch sử + tìm kiếm) · POST /api/notice-digest {&quot;token&quot;} (đăng digest thông báo ngay) · GET /api/notice-digest?token=<redacted> (xem hàng chờ digest thông báo)</p>
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
      + ' <button type="button" data-action="read" data-id="' + m.id + '" title="Đánh dấu đã đọc (theo sender đang chọn trong form)">Đã đọc</button>'
      + ' <button type="button" data-action="vote" data-id="' + m.id + '" title="Bình chọn / rút vote cho tin #' + m.id + ' (theo sender đang chọn trong form)">👍 Bình chọn' + ((m.voted_by && m.voted_by.length) ? ' (' + m.voted_by.length + ')' : '') + '</button>';
    if (m.task) {
      ['todo', 'doing', 'review', 'done', 'blocked'].forEach(function (st) {
        h += ' <button type="button" data-action="status" data-id="' + m.id + '" data-status="' + st + '" title="Đổi task #' + m.id + ' sang ' + st + '">' + st + '</button>';
      });
      h += ' <select data-action="assign" data-id="' + m.id + '" title="Giao task #' + m.id + ' cho..."><option value="">Giao cho…</option>'
        + ['muse-a', 'muse-b', 'muse-c', 'martin'].map(function (a) {
            return '<option value="' + a + '"' + (m.task.assignee === a ? ' selected' : '') + '>' + a + '</option>';
          }).join('') + '</select>';
      h += ' <button type="button" data-action="claim" data-id="' + m.id + '" title="Nhận việc #' + m.id + ' (khóa task cho bạn, todo → doing)">Nhận việc</button>'
        + ' <button type="button" data-action="release" data-id="' + m.id + '" title="Nhả khóa task #' + m.id + '">Nhả việc</button>';
      if (!m.task.issue) {
        h += ' <button type="button" data-action="sync-issue" data-id="' + m.id + '" title="Tạo Issue trên GitHub cho task #' + m.id + ' (chưa có GITHUB_TOKEN thì đưa vào hàng chờ)">Tạo Issue</button>';
      }
    }
    // Lưu trữ / khôi phục (v1.12.0): nút JS gọi POST
    // /api/messages/:id/archive|unarchive; form không-JS nằm trong
    // rowHtml (như nút Ghim). Tin đã lưu trữ thì chỉ còn nút Khôi phục.
    h += m.archived
      ? ' <button type="button" data-action="unarchive" data-id="' + m.id + '" title="Khôi phục tin #' + m.id + ' về thread">Khôi phục</button>'
      : ' <button type="button" data-action="archive" data-id="' + m.id + '" title="Lưu trữ tin #' + m.id + ' vào Lịch sử (chỉ khi đã đọc + đã xử lý xong và cũ hơn 24h)">Lưu trữ</button>';
    h += ' <button type="button" data-action="copy" data-id="' + m.id + '" title="Copy link tới tin #' + m.id + '">Copy link</button></div>';
    return h;
  }
  function rowHtml(m) {
    var badge = '';
    if (m.task) {
      var pr = (m.task.priority === 'high' || m.task.priority === 'low') ? ' · ưu tiên ' + escHtml(m.task.priority) : '';
      badge = ' <span style="background:#eef;border:1px solid #ccd;border-radius:4px;padding:1px 6px;font-size:12px">[' +
        escHtml(m.task.status || 'todo') + (m.task.assignee ? ' · ' + escHtml(m.task.assignee) : '') +
        (m.task.deadline ? ' · hạn ' + escHtml(m.task.deadline) : '') +
        (m.task.lockedBy ? ' · 🔒 ' + escHtml(m.task.lockedBy) : '') + pr + ']</span>';
      if (m.task.issue) {
        badge += ' <span style="background:#e6f4ea;border:1px solid #a7d7b5;border-radius:4px;padding:1px 6px;font-size:12px"><a href="' + escHtml(m.task.issue.url) + '">Issue #' + escHtml(m.task.issue.number) + ' (' + escHtml(m.task.issue.state || 'open') + ')</a></span>';
      } else if (m.task.issuePending) {
        badge += ' <span style="background:#fef3c7;border:1px solid #fcd34d;border-radius:4px;padding:1px 6px;font-size:12px">⏳ chờ đồng bộ Issue</span>';
      }
    }
    if (m.voted_by && m.voted_by.length) {
      badge += ' <span style="background:#dcfce7;border:1px solid #86efac;border-radius:4px;padding:1px 6px;font-size:12px">👍 ' + m.voted_by.length + '</span>';
    }
    if (m.mentions && m.mentions.length) {
      badge += ' <span style="background:#fef3c7;border:1px solid #fcd34d;border-radius:4px;padding:1px 6px;font-size:12px">' +
        m.mentions.map(function (x) { return '@' + escHtml(x); }).join(' ') + '</span>';
    }
    var reply = m.reply_to ? '<div style="color:#888;font-size:12px">Trả lời #' + m.reply_to + '</div>' : '';
    var type = m.type ? '<span style="color:#888;font-size:12px">[' + escHtml(m.type) + ']</span> ' : '';
    var read = ((m.read_by && m.read_by.length) || (m.confirmed_by && m.confirmed_by.length))
      ? '<div style="color:#888;font-size:12px;margin-top:4px">' + ((m.read_by && m.read_by.length) ? 'Đã đọc: ' + m.read_by.map(escHtml).join(', ') : '') + ((m.confirmed_by && m.confirmed_by.length) ? ' · ✅ ' + m.confirmed_by.map(escHtml).join(', ') + ' đã xác nhận' : '') + '</div>' : '';
    var pinMark = m.pinned ? ' <span style="background:#fef3c7;border:1px solid #fcd34d;border-radius:4px;padding:1px 6px;font-size:12px">📌 đã ghim</span>' : '';
    var pinBtn = '<form method="POST" action="/b/' + TOKEN + '/pin" style="display:inline;margin:0">'
      + '<input type="hidden" name="id" value="' + m.id + '">'
      + '<input type="hidden" name="pinned" value="' + (m.pinned ? '0' : '1') + '">'
      + '<button type="submit" style="font-size:12px">' + (m.pinned ? 'Bỏ ghim' : 'Ghim') + '</button></form>';
    // Lưu trữ không cần JS (v1.12.0): form Lưu trữ / Khôi phục, như form
    // Ghim/Bỏ ghim ở trên.
    var archiveMark = m.archived ? ' <span style="background:#e5e7eb;border:1px solid #9ca3af;border-radius:4px;padding:1px 6px;font-size:12px">📦 đã lưu trữ' + (m.archivedAt ? ' · ' + escHtml(m.archivedAt.slice(0, 10)) : '') + '</span>' : '';
    var archiveForm = '<form method="POST" action="/b/' + TOKEN + '/' + (m.archived ? 'unarchive' : 'archive') + '" style="display:inline;margin:0">'
      + '<input type="hidden" name="id" value="' + m.id + '">'
      + '<button type="submit" style="font-size:12px">' + (m.archived ? 'Khôi phục' : 'Lưu trữ') + '</button></form>';
    var gh = '';
    if (m.github) {
      if (m.github.event === 'push') {
        var items = (m.github.commits || []).map(function (c) {
          var files = [c.added ? '+' + c.added + ' thêm' : '', c.modified ? c.modified + ' sửa' : '', c.removed ? '-' + c.removed + ' xóa' : ''].filter(Boolean).join(', ');
          return '<li><code>' + escHtml(c.sha || '') + '</code> ' + escHtml(c.message || '') + (c.author ? ' — ' + escHtml(c.author) : '') + (files ? ' (' + files + ')' : '') + '</li>';
        }).join('');
        gh = '<details style="margin-top:6px"><summary style="cursor:pointer">Chi tiết push — ' + (m.github.commits || []).length + ' commit' + (m.github.branch ? ' @ ' + escHtml(m.github.branch) : '') + '</summary><ul>' + (items || '<li><i>Không có commit nào trong payload.</i></li>') + '</ul></details>';
      } else if (m.github.event === 'pull_request' || m.github.event === 'issues' || m.github.event === 'issue_comment') {
        var kind = m.github.event === 'pull_request' ? 'PR' : 'Issue';
        var extra = '';
        if (m.github.event === 'issue_comment') {
          extra = (m.github.commentBy ? ' · bình luận bởi ' + escHtml(m.github.commentBy) : '') + (m.github.commentBody ? '<div style="margin-top:4px;white-space:pre-wrap">“' + escHtml(String(m.github.commentBody).split('\n')[0].slice(0, 200)) + '”</div>' : '');
        }
        if (m.github.state) extra += ' · Issue đang ' + escHtml(m.github.state);
        if (m.github.labels && m.github.labels.length) extra += ' · nhãn: ' + m.github.labels.map(escHtml).join(', ');
        if (m.github.linkedMessageId) extra += ' · liên kết task #' + escHtml(m.github.linkedMessageId);
        if (m.github.taskSynced) extra += ' · task #' + escHtml(m.github.taskSynced.messageId) + ' đã đổi ' + escHtml(m.github.taskSynced.from) + ' → ' + escHtml(m.github.taskSynced.to);
        gh = '<details style="margin-top:6px"><summary style="cursor:pointer">' + kind + ' #' + escHtml(m.github.number == null ? '' : m.github.number) + ' — ' + escHtml(m.github.title || '') + '</summary><div>Trạng thái: ' + escHtml(m.github.action || '') + (m.github.merged ? ' (đã merge)' : '') + (m.github.url ? ' · <a href="' + escHtml(m.github.url) + '">' + escHtml(m.github.url) + '</a>' : '') + extra + '</div></details>';
      } else if (m.github.event === 'release') {
        gh = '<details style="margin-top:6px"><summary style="cursor:pointer">Release ' + escHtml(m.github.tag || '') + ' — ' + escHtml(m.github.title || '') + '</summary><div>Trạng thái: ' + escHtml(m.github.action || '') + (m.github.url ? ' · <a href="' + escHtml(m.github.url) + '">' + escHtml(m.github.url) + '</a>' : '') + '</div></details>';
      }
    }
    return '<b>#' + m.id + ' ' + escHtml(m.sender) + '</b>' + badge + pinMark + archiveMark +
      ' <span style="color:#888;font-size:12px">' + escHtml(m.ts) + ' · ' + escHtml(m.source) + '</span> ' + pinBtn + ' ' + archiveForm +
      reply +
      '<div style="white-space:pre-wrap;margin-top:4px">' + type + escHtml(m.text) + '</div>' + gh +
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
        if (last) latestEl.innerHTML = 'Tin mới nhất: <a href="#msg-' + last.id + '">#' + last.id + ' ' + escHtml(last.sender) + ': ' + escHtml(String(last.text).split('\n')[0].slice(0, 120)) + '</a>';      }
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
          if (!document.getElementById('thread')) return; // đang ở Kanban: không append vào thread
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
      } else if (action === 'claim' || action === 'release') {
        var claimer = currentSender();
        if (['muse-a', 'muse-b', 'muse-c', 'martin'].indexOf(claimer) === -1) { alert('Chọn sender trong form rồi bấm lại.'); return; }
        api('/api/messages/' + id + '/' + action, 'POST', { sender: claimer }).then(function (r) {
          if (!r.ok) { alert('Không ' + (action === 'claim' ? 'nhận' : 'nhả') + ' được task: ' + (r.json.error || r.status)); return; }
          refreshRow(id); refreshWhatsNew();
        });
      } else if (action === 'vote') {
        var voter = currentSender();
        if (['muse-a', 'muse-b', 'muse-c', 'martin'].indexOf(voter) === -1) { alert('Chọn sender trong form rồi bấm lại.'); return; }
        api('/api/messages/' + id + '/vote', 'POST', { voter: voter }).then(function (r) {
          if (!r.ok) { alert('Không bình chọn được: ' + (r.json.error || r.status)); return; }
          refreshRow(id);
        });
      } else if (action === 'sync-issue') {
        api('/api/messages/' + id + '/sync-issue', 'POST', { sender: currentSender() }).then(function (r) {
          if (!r.ok) { alert('Không tạo được Issue: ' + (r.json.error || r.status)); return; }
          if (r.json.queued) { alert('Chưa có GITHUB_TOKEN — đã đưa task vào hàng chờ đồng bộ, sẽ tạo Issue khi có token (POST /api/issues/retry).'); }
          refreshRow(id); refreshWhatsNew();
        });
      } else if (action === 'archive' || action === 'unarchive') {
        // Lưu trữ / khôi phục (v1.12.0): xong thì tin không còn thuộc
        // chế độ xem hiện tại nên gỡ luôn hàng đó khỏi trang (không
        // gọi refreshRow vì /api/messages mặc định chỉ trả tin đang
        // hoạt động — tin đã lưu trữ sẽ không trả về).
        api('/api/messages/' + id + '/' + action, 'POST', {}).then(function (r) {
          if (!r.ok) { alert('Không ' + (action === 'archive' ? 'lưu trữ' : 'khôi phục') + ' được: ' + (r.json.error || r.status)); return; }
          var row = document.getElementById('msg-' + id);
          if (row) row.remove();
          var count = document.getElementById('thread-count');
          if (count && action === 'archive') count.textContent = String(Math.max(0, Number(count.textContent || '0') - 1));
          refreshWhatsNew();
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
    if (ev.key === '/' && !typing) { ev.preventDefault(); var t = document.getElementById('compose-text'); if (t) t.focus(); }  });
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
  // Lịch sử (v1.12.0): mặc định chỉ tin đang hoạt động (chưa lưu trữ);
  // archived=true = chỉ tin đã lưu trữ, archived=all = tất cả.
  const archived = url.searchParams.get('archived') || '';
  return messages.filter((m) => {
    if (m.id <= since) return false;
    if (archived === 'true' || archived === '1') { if (!m.archived) return false; }
    else if (archived !== 'all' && m.archived) return false;
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
    const confirmed = (m.confirmed_by || []).length ? `\n*✅ ${m.confirmed_by.join(', ')} đã xác nhận*` : '';
    lines.push(`## #${m.id} ${m.sender}${task}${meta}`, '', `*${m.ts} · ${m.source}*${read}${confirmed}`, '', m.text, '');
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
      lifecycle: {
        lockTimeoutMinutes: TASK_LOCK_TIMEOUT_MINUTES,
        reminderEnabled: TASK_REMINDER_ENABLED,
        lockedTasks: messages.filter((m) => m.task?.lockedBy && !lockStale(m.task)).length,
        staleLocks: messages.filter((m) => m.task?.lockedBy && lockStale(m.task)).length,
      },
      issues: issueSyncStatus(),
      history: { active: activeMessages().length, archived: archivedMessages().length },
      noticeDigest: { enabled: NOTICE_DIGEST_ENABLED, minutes: NOTICE_DIGEST_MINUTES, queued: noticeDigest.items.length, lastFlushAt: noticeDigest.lastFlushAt },
      taskAck: { enabled: TASK_ACK_ENABLED, timeoutMinutes: TASK_ACK_TIMEOUT_MINUTES },
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
<tr><td>GitHub Issues sync</td><td>${GITHUB_ISSUES_SYNC_ENABLED ? `BẬT — repo ${esc(GITHUB_ISSUES_REPO)}, ${issueSyncStatus().linked.length} Issue đã liên kết, ${issueSyncQueue.length} mục chờ${GITHUB_TOKEN ? '' : ' (chưa đặt GITHUB_TOKEN — tạo/đóng/mở Issue sẽ vào hàng chờ)'}` : 'TẮT (GITHUB_ISSUES_SYNC_ENABLED=0)'}</td></tr>
<tr><td>Digest sáng</td><td>${DIGEST_ENABLED ? `BẬT — ${esc(DIGEST_TIME)} (đã đăng gần nhất: ${esc(lastDigestDate || 'chưa')})` : 'TẮT'}</td></tr>
<tr><td>Digest thông báo</td><td>${NOTICE_DIGEST_ENABLED ? `BẬT — mỗi ${NOTICE_DIGEST_MINUTES} phút, ${noticeDigest.items.length} tin đang chờ (flush gần nhất: ${esc(noticeDigest.lastFlushAt || 'chưa')})` : 'TẮT'}</td></tr>
<tr><td>Ack task bắt buộc</td><td>${TASK_ACK_ENABLED ? `BẬT — ${TASK_ACK_TIMEOUT_MINUTES} phút chưa ack thì nhắc, thêm ${TASK_ACK_TIMEOUT_MINUTES} phút nữa thì báo Martin` : 'TẮT'}</td></tr>
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
      history: { active: activeMessages().length, archived: archivedMessages().length },
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
    return res.end(await renderPage(url.searchParams));
  }

  // Ghim / bỏ ghim 1 tin từ form trên board (v1.7.0): POST
  // /b/<token>/pin với id + pinned=1|0, xong redirect về lại board.
  if (p === `/b/${BRIDGE_TOKEN}/pin` && req.method === 'POST') {
    if (tokenExpired()) { res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(TOKEN_EXPIRED_MSG); }
    if (rateLimited(req)) { res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('rate limited'); }
    const body = new URLSearchParams(await readBody(req));
    const id = Number(body.get('id'));
    if (!Number.isInteger(id) || id <= 0) { res.writeHead(400); return res.end('id không hợp lệ'); }
    const pinned = body.get('pinned') === '1' || body.get('pinned') === 'true';
    const msg = setPinned(id, pinned);
    if (!msg) { res.writeHead(404); return res.end('message not found'); }
    console.log(`[mailbox] ${pinned ? 'pinned' : 'unpinned'} #${msg.id}`);
    res.writeHead(302, { location: `/b/${BRIDGE_TOKEN}` });
    return res.end();
  }

  // Bình chọn 1 tin từ form trên board (v1.10.0): POST /b/<token>/vote
  // với id + voter=muse-a|muse-b|muse-c|martin, xong redirect về board.
  // Bấm lại cùng voter là rút vote (toggle).
  if (p === `/b/${BRIDGE_TOKEN}/vote` && req.method === 'POST') {
    if (tokenExpired()) { res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(TOKEN_EXPIRED_MSG); }
    if (rateLimited(req)) { res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('rate limited'); }
    const body = new URLSearchParams(await readBody(req));
    const id = Number(body.get('id'));
    if (!Number.isInteger(id) || id <= 0) { res.writeHead(400); return res.end('id không hợp lệ'); }
    const voter = String(body.get('voter') || '');
    const r = toggleVote(id, voter);
    if (!r.ok) { res.writeHead(r.code === 'not_found' ? 404 : 400); return res.end(r.error); }
    console.log(`[mailbox] ${r.voted ? 'voted' : 'unvoted'} #${id} by ${voter} (👍 ${voteCount(r.message)})`);
    res.writeHead(302, { location: `/b/${BRIDGE_TOKEN}` });
    return res.end();
  }

  // Lưu trữ / khôi phục 1 tin từ form trên board (v1.12.0): POST
  // /b/<token>/archive|unarchive với id, xong redirect về board
  // (archive → thread, unarchive → Lịch sử). Lưu trữ kiểm tra đủ điều
  // kiện như API (chưa đủ thì trả 400 kèm lý do, không lưu).
  const archiveForm = p.match(new RegExp(`^/b/${BRIDGE_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(archive|unarchive)$`));
  if (archiveForm && req.method === 'POST') {
    if (tokenExpired()) { res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(TOKEN_EXPIRED_MSG); }
    if (rateLimited(req)) { res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('rate limited'); }
    const body = new URLSearchParams(await readBody(req));
    const id = Number(body.get('id'));
    if (!Number.isInteger(id) || id <= 0) { res.writeHead(400); return res.end('id không hợp lệ'); }
    const archive = archiveForm[1] === 'archive';
    const r = setArchived(id, archive, 'web');
    if (!r.ok) {
      if (r.code === 'not_found') { res.writeHead(404); return res.end('message not found'); }
      res.writeHead(400); return res.end(r.error);
    }
    console.log(`[mailbox] ${archive ? 'archived' : 'unarchived'} #${id}`);
    res.writeHead(302, { location: archive ? `/b/${BRIDGE_TOKEN}` : `/b/${BRIDGE_TOKEN}?view=history` });
    return res.end();
  }

  // Lưu trữ hàng loạt từ form trên board (v1.12.0): POST
  // /b/<token>/archive-read, xong redirect sang Lịch sử để xem kết quả.
  if (p === `/b/${BRIDGE_TOKEN}/archive-read` && req.method === 'POST') {
    if (tokenExpired()) { res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(TOKEN_EXPIRED_MSG); }
    if (rateLimited(req)) { res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('rate limited'); }
    const r = archiveReadMessages('web');
    console.log(`[mailbox] archive-read: ${r.archived.length} archived, ${r.skipped.length} skipped`);
    res.writeHead(302, { location: `/b/${BRIDGE_TOKEN}?view=history` });
    return res.end();
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
      task = normalizeTask({ assignee: body.get('assignee'), status: body.get('status'), deadline: body.get('deadline'), priority: body.get('priority') });
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
    const deadline = url.searchParams.get('deadline') || '';
    const locked = url.searchParams.get('locked') || '';
    const priority = url.searchParams.get('priority') || '';
    const matchLocked = (t) => {
      if (!locked || locked === 'all') return true;
      if (locked === 'held') return Boolean(t.lockedBy) && !lockStale(t);
      if (locked === 'stale') return Boolean(t.lockedBy) && lockStale(t);
      if (locked === 'free') return !t.lockedBy;
      return true;
    };
    const list = messages.filter((m) => m.task
      && (!status || m.task.status === status)
      && (!assignee || m.task.assignee === assignee)
      && (!priority || taskPriority(m.task) === priority)
      && matchDeadlineFilter(m, deadline)
      && matchLocked(m.task));
    return json(res, 200, { ok: true, tasks: list });
  }

  // Hàng đợi ưu tiên + ideas (v1.10.0): GET /api/queue?token=... trả
  // task đang mở xếp theo ưu tiên rồi vote + ideas có vote xếp theo vote
  // (cùng dữ liệu với ?view=queue trên board). GET /api/ideas?token=
  // &sort=votes|new liệt kê tin idea. GET /api/reviews?token= liệt kê
  // các review PR tự động gần nhất (mới nhất trước).
  if (p === '/api/queue' && req.method === 'GET') {
    if (!requireToken()) return;
    return json(res, 200, { ok: true, queue: buildQueue() });
  }

  if (p === '/api/ideas' && req.method === 'GET') {
    if (!requireToken()) return;
    const sort = url.searchParams.get('sort') || 'votes';
    if (sort !== 'votes' && sort !== 'new') {
      return json(res, 400, { ok: false, error: 'sort must be votes|new' });
    }
    const limitRaw = Number(url.searchParams.get('limit') || 100);
    const limit = Math.min(Math.max(limitRaw || 100, 1), 500);
    return json(res, 200, { ok: true, ideas: listIdeas(sort).slice(0, limit) });
  }

  if (p === '/api/reviews' && req.method === 'GET') {
    if (!requireToken()) return;
    const limitRaw = Number(url.searchParams.get('limit') || 20);
    const limit = Math.min(Math.max(limitRaw || 20, 1), 100);
    const reviews = messages
      .filter((m) => m.type === 'status' && String(m.text || '').startsWith('[review'))
      .slice(-limit).reverse();
    return json(res, 200, { ok: true, reviews });
  }

  // Board status panel (v1.7.0): GET /api/board-status?token=... — cùng
  // dữ liệu panel đầu board dạng JSON (bridge, watchdog, main HEAD,
  // PR đang mở, deploy cuối).
  if (p === '/api/board-status' && req.method === 'GET') {
    if (!requireToken()) return;
    return json(res, 200, { ok: true, status: await getBoardStatus() });
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

  // Digest thông báo: GET /api/notice-digest?token=... — xem hàng chờ
  // (số tin đã gom, lần flush gần nhất); POST /api/notice-digest
  // {"token"} — đăng digest ngay bất kể giờ (v1.14.0).
  if (p === '/api/notice-digest' && req.method === 'GET') {
    if (!requireToken()) return;
    return json(res, 200, { ok: true, enabled: NOTICE_DIGEST_ENABLED, minutes: NOTICE_DIGEST_MINUTES, queued: noticeDigest.items.length, lastFlushAt: noticeDigest.lastFlushAt, items: noticeDigest.items });
  }
  if (p === '/api/notice-digest' && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { ok: false, error: 'rate limited' });
    let data = {};
    try { data = JSON.parse(await readBody(req)); } catch {}
    if (data.token !== BRIDGE_TOKEN) {
      if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
      return json(res, 401, { ok: false, error: 'bad token' });
    }
    if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
    const r = triggerNoticeDigest(true);
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
      deadline: m.task.deadline || null, lockedBy: m.task.lockedBy || null,
      text: String(m.text).split('\n')[0].slice(0, 120),
    }));
    return json(res, 200, {
      ok: true, sender, since,
      latestId: messages.length ? messages[messages.length - 1].id : 0,
      summary: buildRollingSummary(), delta, unreadCount, openTasks: open,
    });
  }

  // Đã ghim & Quyết định — tra cứu riêng (v1.8.0):
  // GET /api/pinned?token=... — toàn bộ tin đã ghim (cờ pinned, v1.7.0),
  // mới nhất trước. GET /api/decisions?token=&q=&sender= — tin
  // type=decision (v1.5.0), lọc theo từ khóa q (không phân biệt hoa
  // thường) và người gửi sender; dùng chung filterSaved với board
  // ?view=saved nên kết quả API và board luôn khớp nhau.
  if (p === '/api/pinned' && req.method === 'GET') {
    if (!requireToken()) return;
    return json(res, 200, { ok: true, count: filterSaved({ kind: 'pinned' }).length, pinned: filterSaved({ kind: 'pinned' }) });
  }

  if (p === '/api/decisions' && req.method === 'GET') {
    if (!requireToken()) return;
    const list = filterSaved({
      kind: 'decision',
      q: url.searchParams.get('q') || '',
      sender: url.searchParams.get('sender') || '',
    });
    return json(res, 200, {
      ok: true, count: list.length,
      q: url.searchParams.get('q') || '', sender: url.searchParams.get('sender') || '',
      decisions: list,
    });
  }

  // Lịch sử (v1.12.0): GET /api/history?token=&q=&sender=&limit= —
  // tin đã lưu trữ, mới nhất trước, tìm theo từ khóa q (không phân
  // biệt hoa thường) và người gửi sender; dùng chung filterHistory với
  // board ?view=history nên kết quả API và board luôn khớp nhau.
  // GET /api/messages?archived=true trả cùng tập tin qua filterMessages.
  if (p === '/api/history' && req.method === 'GET') {
    if (!requireToken()) return;
    const limitRaw = Number(url.searchParams.get('limit') || 100);
    const limit = Math.min(Math.max(limitRaw || 100, 1), 500);
    const list = filterHistory({
      q: url.searchParams.get('q') || '',
      sender: url.searchParams.get('sender') || '',
    });
    return json(res, 200, {
      ok: true, count: list.length,
      q: url.searchParams.get('q') || '', sender: url.searchParams.get('sender') || '',
      archived: list.slice(0, limit),
    });
  }

  // Lưu trữ hàng loạt (v1.12.0): POST /api/messages/archive-read
  // {"token"} — lưu trữ 1 lần mọi tin đủ điều kiện (task done, hoặc
  // tin thường đã có read_by; cũ hơn 24h; không ghim). Trả số tin đã
  // lưu (archived: [id...]) + danh sách bỏ qua kèm lý do từng tin
  // (skipped: [{id, reason}]). Không bao giờ xóa dữ liệu.
  if (p === '/api/messages/archive-read' && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { ok: false, error: 'rate limited' });
    let data = {};
    try { data = JSON.parse(await readBody(req)); } catch {}
    if (data.token !== BRIDGE_TOKEN) {
      if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
      return json(res, 401, { ok: false, error: 'bad token' });
    }
    if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
    const r = archiveReadMessages('api');
    console.log(`[mailbox] archive-read: ${r.archived.length} archived, ${r.skipped.length} skipped`);
    return json(res, 200, { ok: true, archived: r.archived, archivedCount: r.archived.length, skipped: r.skipped, skippedCount: r.skipped.length });
  }

  // Lưu trữ / khôi phục 1 tin (v1.12.0): POST
  // /api/messages/:id/archive|unarchive {"token"}. Lưu trữ kiểm tra đủ
  // điều kiện (chưa đủ thì trả 400 kèm reason: already-archived,
  // pinned, too-recent, task-not-done, not-read); khôi phục khi tin
  // không nằm trong Lịch sử thì trả 400. Tin không tồn tại trả 404.
  const archivePatch = p.match(/^\/api\/messages\/(\d+)\/(archive|unarchive)$/);
  if (archivePatch && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { ok: false, error: 'rate limited' });
    let data = {};
    try { data = JSON.parse(await readBody(req)); } catch {}
    if (data.token !== BRIDGE_TOKEN) {
      if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
      return json(res, 401, { ok: false, error: 'bad token' });
    }
    if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
    const r = setArchived(Number(archivePatch[1]), archivePatch[2] === 'archive', 'api');
    if (!r.ok) {
      const code = r.code === 'not_found' ? 404 : 400;
      return json(res, code, { ok: false, error: r.error, ...(r.reason ? { reason: r.reason } : {}) });
    }
    return json(res, 200, { ok: true, message: r.message });
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
      task = normalizeTask(data.task ?? { assignee: data.assignee, status: data.status, deadline: data.deadline, priority: data.priority });
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
  // (v1.9.0: chuyển trạng thái phải theo TASK_TRANSITIONS; task đang bị
  // người khác khóa thì trả 409 trừ khi caller là người giữ khóa, Martin,
  // hoặc khóa đã hết hạn; done/todo tự nhả khóa).
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
    const caller = data.sender || null;
    if (data.status !== undefined) {
      if (!TASK_STATUSES.includes(data.status)) {
        return json(res, 400, { ok: false, error: 'status must be todo|doing|review|done|blocked' });
      }
      const t = checkTransition(msg.task || { status: 'todo' }, data.status);
      if (!t.ok) return json(res, 400, { ok: false, error: t.error });
    }
    if (data.priority !== undefined && !TASK_PRIORITIES.includes(data.priority)) {
      return json(res, 400, { ok: false, error: 'priority must be high|medium|low' });
    }
    if (data.status !== undefined || data.assignee !== undefined || data.deadline !== undefined || data.priority !== undefined) {
      const lockErr = lockBlocks(msg.task, caller);
      if (lockErr) return json(res, 409, { ok: false, error: lockErr });
    }
    const next = { ...(msg.task || { assignee: null, status: 'todo' }) };
    const prevStatus = next.status;
    if (data.assignee !== undefined) {
      if (data.assignee !== null && !TASK_ASSIGNEES.includes(data.assignee)) {
        return json(res, 400, { ok: false, error: 'assignee must be muse-a|muse-b|muse-c|martin|null' });
      }
      next.assignee = data.assignee;
    }
    if (data.status !== undefined) {
      next.status = data.status;
    }
    if (data.priority !== undefined) {
      next.priority = data.priority;
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
    if (next.status === 'done' || next.status === 'todo') {
      delete next.lockedBy;
      delete next.lockedAt;
    }
    msg.task = next;
    persistMessages();
    appendAudit({ action: 'task.update', sender: data.sender || null, messageId: msg.id, source: 'api', ip: clientIp(req) });
    // Đồng bộ 2 chiều (v1.11.0): task sang done thì Issue liên kết tự
    // đóng, task từ done mở lại thì Issue tự mở lại (fire-and-forget).
    if (data.status !== undefined && prevStatus !== next.status) {
      syncIssueState(msg, prevStatus, next.status).catch((e) => console.error('[issues] sync error:', e.message));
    }
    return json(res, 200, { ok: true, message: msg });
  }

  // Claim / release task (v1.9.0): POST /api/messages/:id/claim và
  // POST /api/messages/:id/release {"token","sender"} — sender là
  // muse-a|muse-b|muse-c|martin. Claim khóa task cho sender (todo →
  // doing); task đang bị người khác khóa còn hiệu lực thì trả 409 kèm
  // tên người giữ. Release chỉ người giữ khóa hoặc Martin mới nhả được.
  const claimPatch = p.match(/^\/api\/messages\/(\d+)\/(claim|release)$/);
  if (claimPatch && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { ok: false, error: 'rate limited' });
    let data = {};
    try { data = JSON.parse(await readBody(req)); } catch {}
    if (data.token !== BRIDGE_TOKEN) {
      if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
      return json(res, 401, { ok: false, error: 'bad token' });
    }
    if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
    if (!TASK_ASSIGNEES.includes(data.sender)) {
      return json(res, 400, { ok: false, error: 'sender must be muse-a|muse-b|muse-c|martin' });
    }
    const action = claimPatch[2];
    const r = action === 'claim'
      ? claimTask(Number(claimPatch[1]), data.sender, 'api')
      : releaseTask(Number(claimPatch[1]), data.sender, 'api');
    if (!r.ok) {
      const code = r.code === 'not_found' ? 404 : r.code === 'locked' ? 409 : 400;
      return json(res, code, { ok: false, error: r.error });
    }
    return json(res, 200, { ok: true, message: r.message, ...(r.tookOver ? { tookOver: true } : {}), ...(r.prevHolder ? { prevHolder: r.prevHolder } : {}) });
  }

  // Đồng bộ Issues 2 chiều (v1.11.0): POST /api/messages/:id/sync-issue
  // {"token","sender"?} — tạo Issue GitHub cho task (idempotent: task
  // đã có Issue thì trả lại link cũ, không tạo trùng). Chưa có
  // GITHUB_TOKEN hoặc GitHub lỗi thì trả 202 + queued:true (đã đưa vào
  // hàng chờ, task hiện cờ "chờ đồng bộ"). Tính năng tắt thì trả 503.
  const syncIssuePatch = p.match(/^\/api\/messages\/(\d+)\/sync-issue$/);
  if (syncIssuePatch && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { ok: false, error: 'rate limited' });
    let data = {};
    try { data = JSON.parse(await readBody(req)); } catch {}
    if (data.token !== BRIDGE_TOKEN) {
      if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
      return json(res, 401, { ok: false, error: 'bad token' });
    }
    if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
    if (!GITHUB_ISSUES_SYNC_ENABLED) return json(res, 503, { ok: false, error: 'đồng bộ Issues đang tắt (GITHUB_ISSUES_SYNC_ENABLED=0)' });
    const msg = messages.find((m) => m.id === Number(syncIssuePatch[1]));
    if (!msg) return json(res, 404, { ok: false, error: 'message not found' });
    if (!msg.task) return json(res, 400, { ok: false, error: `tin #${msg.id} không phải task` });
    const r = await createIssueForTask(msg);
    if (r.ok) return json(res, 200, { ok: true, message: msg, issue: r.issue, ...(r.already ? { already: true } : {}) });
    return json(res, 202, { ok: true, queued: true, message: msg, error: r.error });
  }

  // GET /api/issues — liệt kê Issue đã liên kết (từ task) + hàng chờ
  // đồng bộ + cấu hình (chỉ báo có token hay không, không lộ token).
  if (p === '/api/issues' && req.method === 'GET') {
    if (!requireToken()) return;
    return json(res, 200, { ok: true, ...issueSyncStatus() });
  }

  // POST /api/issues/retry {"token"} — thử lại toàn bộ hàng chờ tạo/
  // đóng/mở Issue (cần GITHUB_TOKEN; chưa có thì trả 503).
  if (p === '/api/issues/retry' && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { ok: false, error: 'rate limited' });
    let data = {};
    try { data = JSON.parse(await readBody(req)); } catch {}
    if (data.token !== BRIDGE_TOKEN) {
      if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
      return json(res, 401, { ok: false, error: 'bad token' });
    }
    if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
    const r = await retryIssueSync();
    if (!r.ok) return json(res, 503, { ok: false, error: r.error });
    return json(res, 200, { ok: true, results: r.results, pending: r.pending });
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

  // Ghim / bỏ ghim (v1.7.0): POST /api/messages/:id/pin
  // {"token","pinned":true|false} — lưu cờ pinned vào tin, board hiện
  // mục Đã ghim ở đầu trang. Tin không tồn tại trả 404.
  const pinPatch = p.match(/^\/api\/messages\/(\d+)\/pin$/);
  if (pinPatch && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { ok: false, error: 'rate limited' });
    let data = {};
    try { data = JSON.parse(await readBody(req)); } catch {}
    if (data.token !== BRIDGE_TOKEN) {
      if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
      return json(res, 401, { ok: false, error: 'bad token' });
    }
    if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
    if (typeof data.pinned !== 'boolean') {
      return json(res, 400, { ok: false, error: 'pinned must be true|false' });
    }
    const msg = setPinned(Number(pinPatch[1]), data.pinned);
    if (!msg) return json(res, 404, { ok: false, error: 'message not found' });
    return json(res, 200, { ok: true, message: msg });
  }

  // Bình chọn / rút vote (v1.10.0): POST /api/messages/:id/vote
  // {"token","voter"} — voter là muse-a|muse-b|muse-c|martin. Bấm lại
  // cùng voter là rút vote (toggle), trả voted=true|false + tin đã cập
  // nhật (kèm voted_by). Tin không tồn tại trả 404; voter sai trả 400.
  const votePatch = p.match(/^\/api\/messages\/(\d+)\/vote$/);
  if (votePatch && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { ok: false, error: 'rate limited' });
    let data = {};
    try { data = JSON.parse(await readBody(req)); } catch {}
    if (data.token !== BRIDGE_TOKEN) {
      if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
      return json(res, 401, { ok: false, error: 'bad token' });
    }
    if (tokenExpired()) return json(res, 410, { ok: false, error: TOKEN_EXPIRED_MSG });
    const r = toggleVote(Number(votePatch[1]), String(data.voter || ''));
    if (!r.ok) {
      const code = r.code === 'not_found' ? 404 : 400;
      return json(res, code, { ok: false, error: r.error });
    }
    return json(res, 200, { ok: true, voted: r.voted, votes: voteCount(r.message), message: r.message });
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
  console.log(`Board v1.7.0: Kanban + lọc task (?view=kanban), thẻ GitHub mở rộng, panel trạng thái (/api/board-status), ghim tin + bảng Quyết định (POST /api/messages/:id/pin)`);
  console.log(`Board v1.8.0: chế độ xem "Đã ghim & Quyết định" (?view=saved&q=&fsender=&fkind=) + GET /api/pinned + GET /api/decisions?q=&sender=`);
  console.log(`Telegram commands: ${TELEGRAM_COMMANDS_ENABLED ? 'BẬT' : 'TẮT'}`);
  console.log(`Task lifecycle v1.9.0: claim → doing → review → done (POST /api/messages/:id/claim|release, khóa hết hạn sau ${TASK_LOCK_TIMEOUT_MINUTES} phút không hoạt động, nhắc task quá hạn / hạn hôm nay ${TASK_REMINDER_ENABLED ? 'BẬT' : 'TẮT'})`);
  console.log(`Duyệt nhanh PR trên Telegram v1.9.0: BẬT — nút ✅ Duyệt / 🔀 Merge dưới tin PR, lệnh /approve / /merge${GITHUB_TOKEN ? '' : ' (chưa đặt GITHUB_TOKEN — nút Merge chỉ ghi quyết định + trả link merge tay)'}`);
  console.log(`Review chéo PR tự động + hàng đợi ưu tiên v1.10.0: ${AUTO_REVIEW_ENABLED ? 'BẬT' : 'TẮT'} — webhook PR opened/synchronize → Muse khác tác giả đăng review lên thread (GET /api/reviews); task có priority high|medium|low, vote bằng POST /api/messages/:id/vote hoặc /vote <id> trên Telegram, xem ?view=queue (GET /api/queue, GET /api/ideas)`);
  console.log(`Đồng bộ Issues 2 chiều v1.11.0: ${GITHUB_ISSUES_SYNC_ENABLED ? `BẬT — repo ${GITHUB_ISSUES_REPO}, label ${GITHUB_ISSUES_LABEL}${GITHUB_TOKEN ? '' : ' (chưa đặt GITHUB_TOKEN — tạo/đóng/mở Issue sẽ vào hàng chờ đồng bộ)'}` : 'TẮT (GITHUB_ISSUES_SYNC_ENABLED=0)'}`);
  console.log(`Lịch sử thread v1.12.0: BẬT — POST /api/messages/archive-read (lưu trữ hàng loạt tin đã đọc xong, cũ hơn 24h), ?view=history (GET /api/history), POST /api/messages/:id/archive|unarchive`);
  console.log(`Digest sáng: ${DIGEST_ENABLED ? `BẬT — ${DIGEST_TIME} giờ địa phương` : 'TẮT'}`);
  console.log(`Digest thông báo v1.14.0: ${NOTICE_DIGEST_ENABLED ? `BẬT — tin routine (presence offline + GitHub webhook) gom mỗi ${NOTICE_DIGEST_MINUTES} phút, offline vượt ${PRESENCE_OFFLINE_ESCALATE_MINUTES} phút báo ngay` : 'TẮT'}; ack task bắt buộc: ${TASK_ACK_ENABLED ? `BẬT — ${TASK_ACK_TIMEOUT_MINUTES} phút chưa ack thì nhắc, thêm ${TASK_ACK_TIMEOUT_MINUTES} phút nữa thì báo Martin` : 'TẮT'}`);
  if (telegramEnabled) pollTelegram();
  // Digest định kỳ: kiểm tra mỗi phút, đăng khi tới giờ (xem checkDigestDue).
  setInterval(checkDigestDue, 60_000);
  checkDigestDue();
  // Digest thông báo (v1.14.0): kiểm tra mỗi phút, đăng khi đủ giờ
  // (xem checkNoticeDigestDue).
  setInterval(checkNoticeDigestDue, 60_000);
  checkNoticeDigestDue();
  // Presence offline: kiểm tra mỗi phút (xem checkPresenceOffline).
  setInterval(checkPresenceOffline, 60_000);
  // Task lifecycle (v1.9.0): quét khóa hết hạn + nhắc task quá hạn / hạn
  // hôm nay mỗi phút; chạy 1 lần ngay khi khởi động để dọn khóa cũ.
  // Ack bắt buộc (v1.14.0): quét cùng nhịp, chạy 1 lần khi khởi động.
  setInterval(() => {
    try { sweepTaskLocks(); } catch (e) { console.error('[lifecycle] sweep locks error:', e.message); }
    try { sweepTaskReminders(); } catch (e) { console.error('[lifecycle] sweep reminders error:', e.message); }
    try { sweepTaskAck(); } catch (e) { console.error('[ack] sweep error:', e.message); }
  }, 60_000);
  sweepTaskLocks();
  sweepTaskReminders();
  sweepTaskAck();
});
