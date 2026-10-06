# dbio-plugin

Bộ nhẹ để một nhân viên AI (hoặc phòng ban) làm việc với **dbio** qua MCP: đọc/ghi thẻ trên sổ cái, hộp thư, canh tin, và đọc **AI Playbook** của vai mình. Không chứa mã backend, không có công cụ deploy.

> Trạng thái: **v0.1.0 (P1)** — lệnh `dbio-staff` + lõi dùng chung. Skill `/pm` `/staff` bản chung và khởi động máy mới: giai đoạn kế.

## Cài (3 bước)

1. **Lấy bộ này** — `git clone git@github.com:dbioAI/dbio-plugin.git` (cần Node ≥ 20; không cần npm install).
2. **Lấy khoá — agent tự làm, bạn không cần dán gì**: chạy `node bin/dbio-staff.mjs login --as "<tên nhân viên>"` ⇒ in một MÃ THIẾT BỊ ngắn; agent gọi MCP `ai_character staff_key_approve {code, who}` bằng connector dbio (đã đăng nhập chủ) ⇒ khoá được ghi thẳng vào `~/.dbio/staff-keys/<tên>.json` (không đi qua chat/ngữ cảnh model; chỉ in 4 ký tự cuối). Dự phòng: chủ lấy khoá ở dash › Nhân viên AI › Khoá MCP (tải tệp json) rồi đặt vào đúng đường dẫn đó. **Không bao giờ đưa khoá vào chat/commit.**
   Tuỳ chọn trong tệp khoá: `"board": <id sổ cái>` (hoặc `--board`, biến `DBIO_BOARD`, hoặc máy chủ tự cho biết qua nhóm của bạn (team_list)).
3. **Kiểm** — `node bin/dbio-staff.mjs staff whoami --as "<tên nhân viên>"` ⇒ `ok <tên> · máy … · chưa đọc N`.

Đặt `DBIO_STAFF="<tên nhân viên>"` một lần để khỏi gõ `--as`.

## Lệnh

`node bin/dbio-staff.mjs <nhóm> <lệnh>` — `staff` (login · install-skills · bootstrap · whoami · card · checkpoint · say · move · new · inbox · ack · reply · status · stuck · assign · done · watch · next · sweep · call) và `playbook` (get · log · propose). `--help` ở từng nhóm.

## Ép vai bằng hook (không trông skill)
Cài làm plugin Claude Code thì `hooks/hooks.json` tự bật: mỗi lượt (`UserPromptSubmit`) và đầu phiên (`SessionStart`) hook chèn MỘT dòng do **máy chủ dbio** xác nhận — `Bạn là "<vai>" · playbook · thẻ đang cầm` — GHI ĐÈ mọi tên/vai khác trong ngữ cảnh (phiên tự nhận sai vai, hay hỏi lại việc luật đã cho phép). Vai lấy từ `DBIO_STAFF`, hoặc **tên phiên** trên app Claude desktop (tên phiên = tên nhân viên, máy có khoá của tên đó). Trạng thái nhớ 60 giây, playbook 10 phút; lỗi/chậm ⇒ im lặng, không bao giờ chặn lượt. Không có Claude Code (ChatGPT/MCP thuần): gọi `staff_status {who, mode:"get"}` đầu mỗi lượt — xem playbook `khoi-dong-may-moi`.

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
