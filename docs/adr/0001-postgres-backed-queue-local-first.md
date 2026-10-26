# Chọn Queue + PostgreSQL, phát triển local trước

Mita Japan chọn kiến trúc backend có API, worker xử lý công việc nền, hàng đợi và PostgreSQL để phục vụ catalog tự động, thanh toán và mở rộng sang các danh mục khác. Giai đoạn đầu chạy local để phát triển và kiểm thử, sau đó chuyển lên VPS. Chọn PostgreSQL làm nơi lưu dữ liệu chính và ưu tiên hàng đợi dựa trên PostgreSQL để giảm số dịch vụ cần vận hành khi dự án còn nhỏ; thư viện hàng đợi cụ thể chưa được chốt. Quyết định này thay cho các phương án Static JSON, SQLite đơn lẻ và backend phụ thuộc dịch vụ Supabase đã được cân nhắc trước đó.
