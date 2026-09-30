# Web → Figma (w2f) — bản 0.6.1

Ghi lại một trang web thành các màn hình, overlay và trạng thái hover/pressed, rồi dựng lại trong Figma thành frame, component và prototype.

| Thư mục | Vai trò | Hướng dẫn |
|---|---|---|
| [extension/](extension/) | Extension Chrome/Opera **Web → Figma Recorder**: ghi phiên và xuất file `.w2f.json` | [HUONG-DAN.md](extension/HUONG-DAN.md) |
| [figma-plugin/](figma-plugin/) | Plugin Figma **Web → Figma**: đọc `.w2f.json` và dựng thiết kế | [HUONG-DAN.md](figma-plugin/HUONG-DAN.md) |

## Quy trình nhanh

1. **Cài extension:** `chrome://extensions` → bật *Developer mode* → *Load unpacked* → chọn thư mục `extension`.
2. **Ghi:** mở trang cần ghi, bấm `Alt+Shift+R`, dùng trang bình thường (đừng bấm Huỷ trên thanh "đang gỡ lỗi"), rồi bấm **Dừng** để tải file `.w2f.json`.
3. **Cài plugin:** Figma desktop → *Plugins → Development → Import plugin from manifest...* → chọn `figma-plugin/manifest.json`.
4. **Dựng:** chạy plugin, kéo thả file `.w2f.json`, bấm **Dựng vào page hiện tại**, rồi **Present (▶)** để chạy thử.

## Lưu ý

- Extension và plugin nên cùng số phiên bản. Plugin vẫn đọc được file từ extension cũ nhưng thiếu dữ liệu mới (overlay, xoay, menu...).
- Khi cập nhật: giải nén đè thư mục cũ, tải lại extension, và import lại plugin nếu cần.
- Giới hạn: layout dùng vị trí cố định (chưa auto-layout), hover làm dịch chuyển nút chưa được tái hiện.
