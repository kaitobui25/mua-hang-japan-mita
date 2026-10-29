import Link from "next/link";
import { Icon } from "@/components/ui/icons";

function contactHref(raw: string | undefined, service: "zalo" | "facebook") {
  if (!raw || !raw.startsWith("https://") || /[\\\s]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.port || url.hash) return null;
    if (service === "zalo") {
      if (url.hostname !== "zalo.me" || !/^\/[0-9]{8,15}\/?$/.test(url.pathname) || url.search) return null;
    } else {
      const facebook = ["facebook.com", "www.facebook.com", "m.facebook.com"].includes(url.hostname);
      const messenger = ["m.me", "www.m.me"].includes(url.hostname);
      const pagePath = /^\/[A-Za-z0-9._-]+\/?$/.test(url.pathname);
      const profile = url.pathname === "/profile.php" && /^\?id=[0-9]+$/.test(url.search);
      if (!(facebook && (pagePath && !url.search || profile) || messenger && pagePath && !url.search)) return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function Footer() {
  const zalo = contactHref(process.env.NEXT_PUBLIC_ZALO_CONTACT_URL, "zalo");
  const facebook = contactHref(process.env.NEXT_PUBLIC_FACEBOOK_PAGE_URL, "facebook");
  return <footer className="site-footer">
    <div className="container footer-grid">
      <div><Link href="/" className="wordmark footer-wordmark">mita<span>japan</span><span className="wordmark-mark">.</span></Link><p>Những sản phẩm Nhật Bản dành cho nhịp sống mỗi ngày của gia đình Việt.</p></div>
      <div><h3>Khám phá</h3><Link href="/san-pham">Tất cả sản phẩm</Link><Link href="/danh-muc/thuc-pham-bo-sung">Thực phẩm bổ sung</Link><Link href="/danh-muc/thuc-pham-cho-be">Thực phẩm cho bé</Link></div>
      <div><h3>Hướng dẫn</h3><Link href="/cach-mua-hang">Cách mua hàng</Link><Link href="/danh-gia">Đánh giá khách hàng</Link><Link href="/gio-hang">Giỏ hàng</Link>{process.env.NEXT_PUBLIC_READ_ONLY !== '1' && <Link href="/thanh-toan">Đặt hàng</Link>}
        {(zalo || facebook) && <h3>Liên hệ trực tiếp</h3>}
        {zalo && <a href={zalo} target="_blank" rel="noopener noreferrer">Liên hệ Zalo</a>}
        {facebook && <a href={facebook} target="_blank" rel="noopener noreferrer">Nhắn tin Facebook</a>}
      </div>
      <div className="footer-statement"><Icon name="leaf" size={28}/><p>Từ những lựa chọn nhỏ, chăm chút điều quan trọng.</p></div>
    </div>
    <div className="container footer-bottom"><span>© {new Date().getFullYear()} mita japan</span><span>Thiết kế cho những điều gần gũi.</span></div>
  </footer>;
}
