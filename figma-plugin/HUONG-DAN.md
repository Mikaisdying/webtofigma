# Web → Figma (plugin Figma, bản 0.6.1)

Dựng file `.w2f.json` của extension **Web → Figma Recorder** thành màn hình, overlay, component và prototype.

## Cài đặt

1. Mở **ứng dụng Figma trên máy tính**, vào **Plugins → Development → Import plugin from manifest...**
2. Chọn `figma-plugin/manifest.json`. Lưu ý đây không phải thư mục `extension` của Chrome.
3. Khi có bản mới:
   - giải nén đè lên chính thư mục đã import, **hoặc**
   - vào **Manage plugins in development**, xoá bản cũ rồi import lại.

   Số phiên bản hiện cạnh tên plugin.

## Dựng thiết kế

1. Mở page muốn dựng, chạy plugin, kéo thả file `.w2f.json` vào.
2. Chọn bước cần dựng và các tuỳ chọn, rồi bấm **Dựng vào page hiện tại**.
3. Bấm **Present (▶)** để chạy thử kịch bản.

## Plugin tạo ra

- **Màn hình:** mỗi bước là một frame.
- **Modal và menu** thành overlay, chỉ gồm phần modal hoặc menu. Tên frame có "(overlay)" hoặc "(menu)".
  - Nút mở dùng **Open overlay**, nút đóng dùng **Close overlay**.
  - Với menu: bấm ra ngoài menu là đóng.
  - Nút đóng nằm ở màn bên dưới (ví dụ bấm lại nút đã mở menu): plugin tạo vùng bấm trong suốt đúng vị trí đó.
- **Component nút:** variant Default, Hover, Pressed. Nút giống nhau lệch vài pixel được gộp làm một.
- **Component dùng chung** `Shared / ...` cho phần lặp lại giữa các màn, như header, footer, menu.
- **Style:**
  - ảnh nền SVG thành vector, hoa văn lặp dùng chế độ Tile;
  - gradient tròn đúng tâm, gradient hình nón thành Angular gradient;
  - bóng đổ theo hình thành Drop shadow;
  - xoay và co giãn đúng góc.
- **Sau khi dựng,** plugin báo những gì Figma không có tương đương (ví dụ `saturate`, `skew`).

Plugin vẫn đọc được file của các bản extension cũ, nhưng không có các dữ liệu mới (overlay, xoay, menu...).

## Giới hạn

- **Overlay** luôn phủ đúng bằng khung nhìn lúc ghi, căn giữa khi chạy prototype.
- **Hover làm dịch chuyển nút** (ví dụ nhích lên 2px): variant Hover đúng màu, bóng đổ, nhưng không nhích vị trí.
- **Layout** dùng vị trí cố định, chưa phải auto-layout.
