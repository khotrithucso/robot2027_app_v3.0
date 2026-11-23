# Robot 2027 — Phiên Bản V3.0 Pro

Dự án Capacitor 6 Android hoàn chỉnh, sẵn sàng import vào **Spck Editor** và tự động biên dịch file `.apk` trên **GitHub Actions** (`.github/workflows/build-apk.yml`).

## Các nâng cấp trọng tâm trong V3.0 Pro
1. **Robot sống động hơn:** 8 biểu cảm (`happy`, `excited`, `curious`, `proud`, `encourage`, `surprised`, `listening`, `sleeping`), đồng tử đảo mắt tự nhiên, kho thoại đa dạng chống lặp.
2. **Đổi & Tạo hồ sơ người dùng bằng giọng nói:** Nói *"Tôi là Minh"* / *"Con tên là Bông"* để tự đổi hoặc xác nhận 1 nhịp tạo mới ngay không cần vào Cài đặt.
3. **Ngủ thông minh & Ra lệnh ngủ:** Nói *"Ngủ đi"* / *"Chúc ngủ ngon"* để ngủ ngay; tự ngủ sau 60s không tương tác cả ở màn hình chính lẫn khi đang mở bài học mà chưa bấm đọc.
4. **Học tiếng Anh 30 giây chuẩn xác:** Đọc mẫu xong sáng nút `[B]`; trong lúc chờ bấm `[B]` vẫn nghe lệnh điều khiển tiếng Việt nhưng tuyệt đối không tự chấm điểm. Khi bấm `[B]`, Robot im lặng lắng nghe 30s (tự chốt nhanh sau 1.8s nếu đã đạt ngưỡng, chờ thoáng 4.0s nếu chưa đạt). Hỗ trợ 8 mức độ khó **30%–100%** (mặc định **60%**), chạm từng từ để nghe đọc chậm và hộp chúc mừng hết chủ đề.
5. **Camera Giám Sát Live 24/7 Thầm Lặng:** Khớp 100% với `camera_live.php` V3.0.1 Atomic (gom lô ICE 250ms, 2 STUN đồng bộ, chờ 5s grace khi rớt mạng tạm thời), không đổ chuông, không đánh thức bé khi ngủ.
6. **Wi-Fi & Bluetooth 100% trong App + Giả lập ESP32:**
   - Wi-Fi chỉ quét & chọn, có nút **🗑️ Quên mạng** (`forgetWifi`).
   - Box Bluetooth có rõ nút **⬅️ Xoay trái**, **🎯 Về giữa**, **➡️ Xoay phải**, **💡 Đèn đầu**, **🦾 Đèn tay**.
   - Bổ sung Insecure RFCOMM SPP để dùng điện thoại Android thứ 2 (cài *Serial Bluetooth Terminal*) kết nối giả lập mạch ESP32 và gửi `BTN_A` / `BTN_B` / `BTN_C` / `BTN_D`.
   - Tự động gửi `P:MOSFET_ON` khi pin `<= 50%` và `P:MOSFET_OFF` khi pin `>= 90%`.
7. **Kiosk khóa chặt & Mật khẩu chuẩn:** PIN Cài đặt mặc định `1234` (đổi được), mã dự phòng & mã gỡ ghim nhà phát triển `202799` (ô nhập không placeholder, không hint). Nhấn đúp nhanh phím `A` để thoát khẩn cấp về màn hình Robot.
