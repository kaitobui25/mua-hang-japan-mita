# ADR 0010 — Quản lý hiển thị sản phẩm và tỷ giá qua Admin

**Ngày:** 27/10/2026 (JST)
**Trạng thái:** `proposed` — Q1 về thêm hàng chưa được owner chốt.
**Liên quan:** ADR 0002, 0003, 0006, 0007; `.agents/plan/04_mita_minimal_admin_grill_with_docs_plan.md`.

## Bối cảnh

Sản phẩm Mita hiện được tự động upsert từ Amazon theo ASIN; nếu xóa một hàng trong DB, lần quét sau có thể nhập lại. Giá VND đang tính từ JPY và hai biến env, còn order có snapshot tỷ giá và tiền hàng lúc tạo. Chủ cửa hàng cần chỉnh tỷ giá và quyết định hàng nào được thấy nhưng không muốn bảng điều khiển phức tạp.

## Quy tắc đề xuất

1. **“Xóa khỏi cửa hàng” = Ẩn**, có nút `Hiện lại`; không hard-delete một ASIN có lịch sử giá/đơn. Trạng thái ẩn admin độc lập trạng thái giá và điều kiện bán; một lần sync **không được tự bỏ ẩn**. Catalog và checkout đều kiểm tra trạng thái ẩn tại server.
2. **“Thêm hàng” theo hướng khuyến nghị:** dán ASIN hoặc URL Amazon.co.jp và chọn danh mục, đưa vào hàng đợi riêng để backend thu thập/xác minh. Đã có ASIN thì thông báo rõ; nguồn từ chối/cần xác minh thì ghi `needs_human` và không giả thành công. **Cần owner chọn phương án này hay nhập hàng thủ công trước khi implement**.
3. **Không nhập giá nguồn JPY bằng tay rồi đánh dấu là giá Amazon hợp lệ.** Giá nguồn/timestamp phải do quan sát hợp lệ cung cấp, stale quá 24 giờ không checkout; quyền tái hiển thị và điều kiện bán vẫn cần xác minh.
4. **Tỷ giá VND/JPY và phụ phí dịch vụ** được chỉnh ở một màn `Cấu hình`; dùng một `PricingPolicy` lưu DB với version, updated_at và audit. Chỉ có một policy hoạt động; cả catalog/checkout cùng áp dụng hàm pricing có sẵn, không nhân bản công thức ở frontend.
5. Khi thay policy, **giá hiển thị và các đơn mới** được tính theo policy mới; đơn đã tạo giữ snapshot `orders.fx_jpy_to_vnd`, `orders.service_fee_percent` và `order_items.unit_price_vnd`. Không tính lại đơn lịch sử.
6. Tính phí vận chuyển **ước tính riêng** theo category như hiện tại; không gom vào tỷ giá và không tuyên bố phí thực tế đã chốt.

## Ranh giới và hậu quả

- Thêm các thuộc tính/bảng tối thiểu cho `AdminVisibility`, `CatalogImportRequest`, `PricingPolicy`, `AdminAuditEvent`; tái dùng `products`, `price_observations`, `orders`, `sync_runs` có sẵn.
- Cần migration an toàn cho dữ liệu cũ và một lần chuyển biến cấu hình env → record DB với giá khởi tạo đúng mặc định đang dùng, có rollback/backup.
- Cần sửa các API công khai và checkout thống nhất: cả hidden và điều kiện bán được kiểm tra ở backend; frontend chỉ phản ánh kết quả.
- Không xây điều chỉnh giá riêng theo ASIN, giá giảm, kho tồn, live FX, CSV, voucher, báo cáo lợi nhuận, quyền nhiều nhân viên trong phiên bản đầu.

## Câu hỏi chưa giải quyết

**Q1. Thêm sản phẩm:** (A) link/ASIN Amazon nhập tự động (khuyến nghị), hay (B) tên/ảnh/giá nhập tay như một sản phẩm độc lập? Phương án B tạo thêm mô hình nguồn hàng, kiểm tra giá, quyền ảnh và các quy tắc đồng bộ khác; không nên triển khai cả hai cùng lúc.
