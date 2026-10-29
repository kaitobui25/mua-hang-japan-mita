import Link from "next/link";
import { Icon } from "@/components/ui/icons";
import { FacebookChatPopup } from "@/components/layout/facebook-chat-popup";
import { contactHref, facebookMessengerHref, DEFAULT_FACEBOOK_PAGE, DEFAULT_ZALO_CONTACT } from "@/lib/contact-links";

export function Footer() {
  const zalo = contactHref(process.env.NEXT_PUBLIC_ZALO_CONTACT_URL ?? DEFAULT_ZALO_CONTACT, "zalo");
  const facebook = facebookMessengerHref(process.env.NEXT_PUBLIC_FACEBOOK_PAGE_URL ?? DEFAULT_FACEBOOK_PAGE);
  return <footer className="site-footer">
    <div className="container footer-grid">
      <div><Link href="/" className="wordmark footer-wordmark">mita<span>japan</span><span className="wordmark-mark">.</span></Link><p>Những sản phẩm Nhật Bản dành cho nhịp sống mỗi ngày của gia đình Việt.</p></div>
      <div><h3>Khám phá</h3><Link href="/san-pham">Tất cả sản phẩm</Link><Link href="/danh-muc/thuc-pham-bo-sung">Thực phẩm bổ sung</Link><Link href="/danh-muc/thuc-pham-cho-be">Thực phẩm cho bé</Link></div>
      <div><h3>Hướng dẫn</h3><Link href="/cach-mua-hang">Cách mua hàng</Link><Link href="/danh-gia">Đánh giá khách hàng</Link><Link href="/gio-hang">Giỏ hàng</Link>{process.env.NEXT_PUBLIC_READ_ONLY !== '1' && <Link href="/thanh-toan">Đặt hàng</Link>}
        {(zalo || facebook) && <h3>Liên hệ trực tiếp</h3>}
        {zalo && <a href={zalo} target="_blank" rel="noopener noreferrer">Liên hệ Zalo</a>}
        {facebook && <FacebookChatPopup href={facebook} />}
      </div>
      <div className="footer-statement"><Icon name="leaf" size={28}/><p>Từ những lựa chọn nhỏ, chăm chút điều quan trọng.</p></div>
    </div>
    <div className="container footer-bottom"><span>© {new Date().getFullYear()} mita japan</span><span>Thiết kế cho những điều gần gũi.</span></div>
  </footer>;
}
