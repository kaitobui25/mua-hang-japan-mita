import Link from "next/link";
import { Icon } from "@/components/ui/icons";

export function Footer() {
  return <footer className="site-footer">
    <div className="container footer-grid">
      <div><Link href="/" className="wordmark footer-wordmark">mita<span>japan</span><span className="wordmark-mark">.</span></Link><p>Những sản phẩm Nhật Bản dành cho nhịp sống mỗi ngày của gia đình Việt.</p><p className="footer-note">Website đang chạy thử nghiệm. Chưa thu tiền thật hoặc xác nhận mua hàng.</p></div>
      <div><h3>Khám phá</h3><Link href="/san-pham">Tất cả sản phẩm</Link><Link href="/danh-muc/thuc-pham-bo-sung">Thực phẩm bổ sung</Link><Link href="/danh-muc/thuc-pham-cho-be">Thực phẩm cho bé</Link></div>
      <div><h3>Hướng dẫn</h3><Link href="/cach-mua-hang">Cách mua hàng</Link><Link href="/gio-hang">Giỏ hàng</Link>{process.env.NEXT_PUBLIC_READ_ONLY !== '1' && <Link href="/thanh-toan">Thanh toán mô phỏng</Link>}</div>
      <div className="footer-statement"><Icon name="leaf" size={28}/><p>Từ những lựa chọn nhỏ, chăm chút điều quan trọng.</p></div>
    </div>
    <div className="container footer-bottom"><span>© {new Date().getFullYear()} mita japan</span><span>Thiết kế cho những điều gần gũi.</span></div>
  </footer>;
}
