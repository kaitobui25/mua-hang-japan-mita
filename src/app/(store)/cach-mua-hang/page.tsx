import type { Metadata } from 'next';
import Link from 'next/link';
import { Icon } from '@/components/ui/icons';

export const metadata: Metadata = { title: 'Cách mua hàng' };

export default function HowToPage() {
  return <>
    <section className="guide-hero"><div className="container">
      <nav className="breadcrumb" aria-label="Đường dẫn"><Link href="/">Trang chủ</Link><span>/</span><span>Cách mua hàng</span></nav>
      <h1>Cách đặt hàng tại Mita Japan</h1>
      <p className="lead">Chọn sản phẩm Nhật, đặt hàng bằng VND và chờ cửa hàng xác nhận trước khi thanh toán.</p>
    </div></section>
    <section className="container guide-steps">
      <article><div className="guide-step-head"><span>01</span><Icon name="search" size={29}/></div><h2>Chọn sản phẩm</h2><p>Chọn mặt hàng và số lượng cần mua.</p><Link href="/san-pham" className="inline-link">Xem sản phẩm <Icon name="arrow" size={18}/></Link></article>
      <article><div className="guide-step-head"><span>02</span><Icon name="bag" size={29}/></div><h2>Gửi đơn hàng</h2><p>Điền thông tin nhận hàng. Giá tiền hàng được chốt khi đơn được ghi nhận.</p><Link href="/gio-hang" className="inline-link">Giỏ hàng <Icon name="arrow" size={18}/></Link></article>
      <article><div className="guide-step-head"><span>03</span><Icon name="check" size={29}/></div><h2>Xác nhận và thanh toán</h2><p>Nhân viên liên hệ xác nhận đơn và hướng dẫn thanh toán. Phí vận chuyển tính riêng.</p></article>
    </section>
    <section className="container guide-bottom"><h2>Bắt đầu mua sắm</h2><Link href="/san-pham" className="button button-primary">Xem sản phẩm <Icon name="arrow"/></Link></section>
  </>;
}
