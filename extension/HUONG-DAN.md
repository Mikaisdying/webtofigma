# Web → Figma Recorder (bản 0.6.1)

Extension cho Chrome và Opera. Ghi lại các màn hình, menu, modal và trạng thái hover/pressed của một trang web, rồi xuất file `.w2f.json` để plugin Figma **Web → Figma** dựng lại.

## Cài đặt

1. Giải nén file zip.
2. Vào `chrome://extensions` (Opera: `opera://extensions`), bật **Developer mode**.
3. Bấm **Load unpacked**, chọn thư mục `extension`.
4. Khi có bản mới: giải nén đè thư mục cũ rồi bấm nút tải lại trên thẻ extension.

## Ghi một phiên

1. Mở trang cần ghi, bấm biểu tượng extension hoặc `Alt+Shift+R`.
2. Trình duyệt hiện thanh "đang gỡ lỗi". **Đừng bấm Huỷ trên thanh này.** Extension cần nó để quét hover. Extension cũng giữ nguyên kích thước khung nhìn như lúc chưa có thanh, nên chiều cao trang không bị thay đổi.
3. Dùng trang bình thường. Extension tự chụp một bước khi:
   - mở hoặc chuyển trang;
   - một click làm đổi màn, mở hoặc đóng modal;
   - một click mở hoặc đóng menu, danh sách thả xuống, popup nhỏ.
4. Menu hoặc popup hiện chậm vẫn được bắt: nếu sau click chưa thấy gì, extension kiểm tra lại ở giây thứ 5.
5. Bấm **Dừng** để tải file.

## Nút trên box

- **Chụp bước:** chụp tay trạng thái hiện tại.
- **Tạm dừng / Tiếp tục** (`Alt+Shift+P`): khi tạm dừng, click không được ghi. Bấm Tiếp tục thì extension chụp lại màn hiện tại để các bước sau nối đúng.
- **Dừng:** kết thúc và tải file.
- **Nút `⋯`:**
  - **Xoá bước cuối:** dùng khi vừa chụp nhầm.
  - **Làm lại từ đầu:** bấm hai lần để xác nhận.
  - **Huỷ phiên:** không xuất file, bấm hai lần để xác nhận.
  - **Log chi tiết:** ghi cả những click bị bỏ qua và lý do, dùng khi extension không nhận ra thao tác của bạn.
- **Nút 4 mũi tên:** kéo để di chuyển box, hoặc bấm vào rồi dùng phím mũi tên. Nút `–` thu gọn box.
- **Box viền vàng** nghĩa là debug đang tắt. Bấm **Bật lại** trên box.

## Trước khi chụp mỗi bước

- **Hiệu ứng:** hiệu ứng có hồi kết được cho chạy tới trạng thái cuối. Hiệu ứng lặp vô hạn được chụp ở khung hình đầu rồi chạy tiếp.
- **Chờ ổn định:** extension chờ ảnh, font và bố cục ổn định, tối đa 5 giây. Phần tử đung đưa liên tục bằng JavaScript được nhận ra và bỏ qua.
- **Nếu hết 5 giây mà trang vẫn chuyển động:** log báo "có thể chưa hiện đầy đủ". Khi đó dùng "Xoá bước cuối" rồi chụp tay lại.
- **Bước trùng:**
  - màn giống hệt màn đang xem thì bỏ qua;
  - màn giống một màn cũ thì ghi là "quay lại bước N".

## Những gì được ghi

- **Bố cục, màu, chữ, font, viền, bo góc, bóng đổ.**
- **Gradient:** thẳng, tròn (đúng tâm), hình nón.
- **Ảnh:** ảnh thường, SVG, canvas (ảnh tĩnh).
- **Ảnh nền:** SVG, ảnh thường, hoa văn lặp.
- **Hiệu ứng khác:** bóng đổ theo hình (`drop-shadow`), xoay và co giãn.
- **Trạng thái nút:** Hover và Pressed của nút, tự quét bằng debug.

Không ghi:
- tiêu đề ẩn cho trình đọc màn hình;
- bộ lọc riêng của trình duyệt (như `-opera-shader`);
- rê chuột, cuộn trang, gõ phím. Chữ đã gõ sẽ xuất hiện ở bước chụp sau.

Ảnh và SVG giống nhau chỉ lưu một lần trong file, nên file nhẹ hơn nhiều so với bản cũ.

## Giới hạn

- Nội dung trong iframe và phần `::before`/`::after` chưa được đọc.
- Hover làm bằng JavaScript (ví dụ tooltip hiện khi rê chuột) không quét được.
- Không ghi được trang `chrome://` và cửa hàng extension.
