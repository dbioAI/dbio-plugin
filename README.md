# dbio-plugin

Bộ nhẹ để một nhân viên AI (hoặc phòng ban) làm việc với **dbio** qua MCP: đọc/ghi thẻ trên sổ cái, hộp thư, canh tin, và đọc **AI Playbook** của vai mình. Không chứa mã backend, không có công cụ deploy.

> Trạng thái: **v0.2.2** — `dbio-staff` (+ `listen` nhận việc đẩy) và daemon `dbio-agentd`. Skill `/pm` `/staff` bản chung và khởi động máy mới: giai đoạn kế.

## Cài (3 bước)

1. **Lấy bộ này** — `git clone git@github.com:dbioAI/dbio-plugin.git` (cần Node ≥ 20; không cần npm install).
2. **Lấy khoá — agent tự làm, bạn không cần dán gì**: chạy `node bin/dbio-staff.mjs login --as "<tên nhân viên>"` ⇒ in một MÃ THIẾT BỊ ngắn; agent gọi MCP `ai_character staff_key_approve {code, who}` bằng connector dbio (đã đăng nhập chủ) ⇒ khoá được ghi thẳng vào `~/.dbio/staff-keys/<tên>.json` (không đi qua chat/ngữ cảnh model; chỉ in 4 ký tự cuối). Dự phòng: chủ lấy khoá ở dash › Nhân viên AI › Khoá MCP (tải tệp json) rồi đặt vào đúng đường dẫn đó. **Không bao giờ đưa khoá vào chat/commit.**
   Tuỳ chọn trong tệp khoá: `"board": <id sổ cái>` (hoặc `--board`, biến `DBIO_BOARD`, hoặc máy chủ tự cho biết qua nhóm của bạn (team_list)).
3. **Kiểm** — `node bin/dbio-staff.mjs staff whoami --as "<tên nhân viên>"` ⇒ `ok <tên> · máy … · chưa đọc N`.

Đặt `DBIO_STAFF="<tên nhân viên>"` một lần để khỏi gõ `--as`.

## Lệnh

`node bin/dbio-staff.mjs <nhóm> <lệnh>` — `listen` (nghe kênh đẩy) · `staff` (login · install-skills · bootstrap · whoami · card · checkpoint · say · move · new · inbox · ack · reply · status · stuck · assign · done · watch · next · sweep · call) và `playbook` (get · log · propose). `--help` ở từng nhóm.

## Nhận việc kiểu ĐẨY: `dbio-staff listen` + daemon `dbio-agentd`

Máy chủ có kênh sự kiện `staff:` (WebSocket, SSE dự phòng): giao thẻ / @nhắc / chủ quyết / trả lời / khẩn được **đẩy** tới agent trong ≤ ~2 giây, không cần hỏi vòng. Hợp đồng sự kiện v1 nằm ở tài liệu của máy chủ (`docs/staff-stream.md`). Client ở đây: Node thuần, không phụ thuộc gói ngoài; WebSocket cần Node ≥ 22, Node 20 tự rơi về SSE.

### Cài một lệnh

```
npm i -g https://github.com/dbioAI/dbio-plugin/archive/refs/heads/main.tar.gz
```
Máy KHÔNG cần git/SSH. Đừng dùng `npm i -g github:dbioAI/dbio-plugin`: npm gọi `ssh://git@github.com`, lỗi trên máy không có khoá SSH GitHub. Bản cố định theo thẻ khi có release: `…/archive/refs/tags/v0.2.2.tar.gz`.
⇒ có `dbio-staff` và `dbio-agentd` (cần khoá nhân viên: `dbio-staff login --as "<tên>"`).

### 1. Phiên đang làm việc: `dbio-staff listen --as "<tên>"`

Chạy NỀN trong phiên (`run_in_background`): có tin cần làm ⇒ in (≤ 2 dòng/tin) rồi **thoát 0** ⇒ phiên thức; xử lý xong chạy lại. Hết giờ (`--max-min`, mặc định 115) ⇒ 1 dòng, thoát 3. Con trỏ lưu ở `~/.dbio/stream/<tên>.listen.cursor.json` nên chạy lại không sót, không lặp. Lọc giống `watch` (tin tự mình gửi, bản sao, trùng, góp ý… bỏ + tự ack, 0 token). Cờ: `--fresh` (bỏ tin cũ) · `--sse` · `--coalesce <ms>` · `--secretary`.

### 2. Phiên đã nghỉ: daemon `dbio-agentd`

```
dbio-agentd init              # ghi ~/.dbio/agentd.json mẫu, điền nhân viên + adapter + phiên
dbio-agentd wake "<tên>"      # thử đánh thức qua adapter (không chờ việc thật)
dbio-agentd install           # dịch vụ người dùng: launchd · Task Scheduler · systemd --user (tự chạy lại)
dbio-agentd status            # dịch vụ + từng nhân viên: nối WS/SSE, số lần thức, lỗi cuối
dbio-agentd uninstall
```

Mỗi nhân viên trên máy = MỘT kết nối bằng khoá riêng của nó. Tin tới ⇒ lọc ⇒ luật ⇒ **adapter** đánh thức phiên:

| Việc | Luật (mã, 0 token) |
|---|---|
| Phiên đang `listen` | daemon nhường (`listen` thức < 5s); sau `listener_confirm_s` (60s) mà máy chủ vẫn báo tin chưa đọc ⇒ daemon thức |
| Phiên nghỉ | gọi adapter ngay (thường < 5s sau khi đẩy) |
| Lượt trước còn chạy | không chồng; adapter lỗi ⇒ không ack, thử lại sau `retry_s` |
| Quét sổ cái (`rules.sweep`, bật trên MỘT máy) | thẻ im > 1h ⇒ hỏi; > 2h / mất nhịp / 2 thẻ ⇒ ghi chú kèm `@<trưởng nhóm>` (tên trưởng nhóm tự lấy từ máy chủ — nhóm có sổ cái đó; `DBIO_PM_NAME` chỉ để ghi đè); chờ chủ không tính là im |

Cấu hình MỘT tệp (`~/.dbio/agentd.json`, `DBIO_AGENTD_CONFIG` đổi chỗ; daemon tự nạp lại khi tệp đổi):

```json
{ "staff": { "<tên>": { "adapter": "claude-cli", "session": "<id phiên>", "cwd": "<thư mục>" } },
  "discover": { "enabled": false, "as": "<tên có khoá>" },
  "defaults": { "coalesce_ms": 3000, "listener_confirm_s": 60, "redeliver_after_min": 3, "wake_timeout_s": 900, "retry_s": 30 },
  "rules": { "sweep": { "enabled": false, "as": "<tên thư ký>", "every_min": 15 } },
  "adapter_modules": [] }
```
`discover.enabled` tự thêm nhân viên có `runtime.machine` = máy này (adapter theo `runtime.agent`).

**Adapter** (cắm thêm bằng `registerAdapter` hoặc `adapter_modules`: tệp `.mjs` export default `{name, wake(ctx)}`):

| Adapter | Cách đánh thức | Khai báo |
|---|---|---|
| `claude-cli` | `claude --resume <session> -p` (cùng ngưỡng 100k token như trên) | `session`, `cwd`, `model`, `args`, `max_context_tokens`, `allow_large` |
| `claude-desktop` | dò `local_<uuid>` trong thư mục phiên của ứng dụng ⇒ `claude --resume <cliSessionId> -p`. **Mặc định chỉ thức phiên < 100k token** (đọc từ tệp hội thoại) — phiên lớn bị chặn, chờ `listen`/thư ký | `session: "local_…"`, `max_context_tokens`, `allow_large` |
| `codex` | `codex exec resume <session> -` (thiếu ⇒ `--last`) | `session`, `cwd` |
| `hermes` | POST JSON tới webhook (https hoặc http localhost), ký HMAC bằng biến môi trường | `url`, `secret_env` |
| `command` | lệnh tuỳ chỉnh (mảng, không qua shell của bạn), lời nhắc ở stdin + `DBIO_WAKE_*` | `command: ["node","x.mjs"]` |

An toàn: lời nhắc đi qua **stdin** (không bao giờ trên dòng lệnh); mọi tham số phải khớp ký tự an toàn; khoá chỉ ở header `Authorization` (không lên URL, không vào log/trạng thái); nội dung tin chỉ là dữ liệu. Log mỗi nhân viên: `~/.dbio/agentd-logs/<tên>.log`.

### Phiên Desktop (kết quả thử 7/10)
`claude --resume` trên phiên Claude Desktop (qua `cliSessionId` trong `…/Claude/claude-code-sessions/**/local_*.json`) **chạy được**: thoát 0, trả lời, ghi nối vào đúng tệp hội thoại của phiên. Lưu ý: (1) phiên nghỉ lâu bị **nguội bộ nhớ đệm** ⇒ lượt đầu tính lại toàn bộ ngữ cảnh (một phiên ~470k token tốn ~4,7 USD trên Opus) — vì thế adapter **chặn mặc định phiên > 100k token** (`max_context_tokens` đổi ngưỡng, `allow_large: true` bỏ chặn); phiên lớn thì chờ `listen` hoặc thư ký; (2) đừng thức phiên đang chạy dở trong ứng dụng (hai tiến trình cùng ghi một hội thoại); (3) việc app hiện tin mới ngay hay chỉ sau khi mở lại phiên chưa kiểm được bằng mã.

## Ép vai bằng hook (không trông skill)
Cài làm plugin Claude Code thì `hooks/hooks.json` tự bật: mỗi lượt (`UserPromptSubmit`) và đầu phiên (`SessionStart`) hook chèn MỘT dòng do **máy chủ dbio** xác nhận — `Bạn là "<vai>" · playbook · thẻ đang cầm` — GHI ĐÈ mọi tên/vai khác trong ngữ cảnh (phiên tự nhận sai vai, hay hỏi lại việc luật đã cho phép). Vai lấy từ `DBIO_STAFF`, hoặc **tên phiên** trên app Claude desktop (tên phiên = tên nhân viên, máy có khoá của tên đó). Trạng thái nhớ 60 giây, playbook 10 phút; lỗi/chậm ⇒ im lặng, không bao giờ chặn lượt. Không có Claude Code (ChatGPT/MCP thuần): gọi `staff_status {who, mode:"get"}` đầu mỗi lượt — xem playbook `khoi-dong-may-moi`. **Chỉ cài MỘT trong hai** (dbio-plugin hoặc dbio-internal): nếu lỡ cài cả hai, hook tự chống chạy đôi (chỉ một bản in); dbio-internal cài riêng mà thiếu dbio-plugin cạnh nó thì hook im lặng (không báo lỗi mỗi lượt).

### Phiên vừa CLEAR (#872) và chống mất tin
- **Phiên trống (PM chốt 7/10: phương án b):** sau khi chủ clear, tệp `local_….json` còn nhưng mất `cliSessionId` (nằm ở `priorCliSessionIds`) ⇒ phiên TRỐNG. Phiên ghim phải HIỆN trong app (chủ xem/can thiệp, danh tính = tên phiên) nên daemon **không** chạy `claude -p` ẩn: nó ghi một lời **CẦU KHẨN** (kèm `@<tên thư ký>` — khai `defaults.relay_to` trong `agentd.json`, hoặc `secretaries[0]` trong `~/.dbio/watch.json`) lên thẻ của tin; thư ký (phiên app, canh sẵn) `send_message` vào đúng phiên ghim: "nạp vai + `staff next --take`". Tin chưa ack ⇒ phiên thức tự nhận qua `listen` rồi ack; không thức thì sau `redeliver_after_min` daemon kiểm lại và cầu tiếp. Không bao giờ `--resume priorCliSessionIds`. Opt-in cũ: `blank_mode: "headless"` trên mục nhân viên ⇒ chạy `claude -p` phiên mới ẩn (app không hiện); khi đó khai `args` (vd `["--permission-mode","acceptEdits"]`).
- **Đo 7/10 (Windows) — lý do chọn (b):** (a) `claude -p` phiên mới: ~44k token ngữ cảnh, ~4s, trả lời được lên thẻ, nhưng **app KHÔNG hiện phiên đó** (list_sessions không có; phiên ghim vẫn trống). (b) chuyển tin vào phiên ghim trống qua `send_message` của một phiên khác: phiên thức ngay, trả lời ~3s, **hiện ngay trong app** với cliSessionId mới, ~81k token ngữ cảnh — nhưng chỉ làm được từ trong một phiên app (daemon không gọi được).
- **Lần đầu nối:** daemon mặc định `fresh` (bỏ hàng đợi tin cũ, không thức cả loạt phiên vì tin tuần trước); muốn nhận tồn đọng: `defaults.first_run: "backlog"`.
- **Phiên đang chạy trong app (không `listen`):** tệp hội thoại vừa được ghi < 3 phút ⇒ daemon KHÔNG thức (tránh 2 tiến trình ghi một hội thoại), chờ phiên yên.
- **Windows:** thư mục phiên lấy theo `lib/sessions-dir.mjs` (đường dẫn thật trong gói MSIX — tiến trình Task Scheduler ngoài gói không thấy `%APPDATA%` ảo); `dbio-agentd install` dùng `Register-ScheduledTask -AtLogOn` (không cần admin; `schtasks /SC ONLOGON` bị từ chối).
- **Chống mất tin:** `listen` không còn ack ngay khi giao tin (phiên có thể vừa bị clear/chết). Id tin ghi vào `~/.dbio/stream/<tên>.listen.pending.json`; lần chạy lại `listen` kế tiếp (= phiên đã xử lý xong) mới ack. Chưa ack ⇒ máy chủ vẫn báo chưa đọc ⇒ daemon giao lại sau `redeliver_after_min` (mặc định 3 phút), trừ khi phiên trống (thức ngay).

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `DBIO_MCP_URL` | địa chỉ MCP khi `login` (mặc định MCP của dbio) |
| `DBIO_STAFF` | tên nhân viên (thay `--as`) |
| `DBIO_BOARD` | sổ cái mặc định |
| `DBIO_PM_NAME` | tên trưởng nhóm để @nhắc (mặc định "PM") |
| `DBIO_DONE_REQUIRE_OUT` | `0` tắt cổng bắt buộc sản phẩm kèm báo xong |

Cấu hình thư ký canh tin (tuỳ chọn): `~/.dbio/watch.json` `{"secretaries": ["<tên>"]}` (máy chủ trả vai thì không cần).

## Kiểm thử
`npm test` (Node thuần, không phụ thuộc gói ngoài).

## Dùng chung với dbio-internal
Phòng dev dùng kho riêng `dbio-internal`, nạp lõi này từ thư mục cạnh nó (`../dbio-plugin`) hoặc biến `DBIO_PLUGIN`. Không có bản sao thứ hai.
