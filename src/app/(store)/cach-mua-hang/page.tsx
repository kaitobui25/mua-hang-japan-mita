import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Cách mua hàng" };

export default function HowToPage() {
  if (process.env.NEXT_PUBLIC_READ_ONLY === '1') {
    return <section className="container shopping-page"><h1>Cách xem sản phẩm Mita Japan</h1><p>Website đang thử nghiệm. Bạn có thể khám phá danh mục và xem thông tin sản phẩm có quyền công bố. Hiện chưa nhận đơn hàng hoặc thanh toán.</p><Link className="button button-primary" href="/san-pham">Xem sản phẩm</Link></section>;
  }
  return <><section className="guide-hero"><div className="container"><nav className="breadcrumb" aria-label="Đường dẫn"><Link href="/">Trang chủ</Link><span>/</span><span>Cách mua hàng</span></nav><h1>Từng bước nhỏ, thật rõ ràng.</h1><p className="lead">Mita Japan giúp bạn khám phá sản phẩm Nhật Bản và xem tiền hàng bằng VND. Hiện website đang thử nghiệm tạo đơn, chưa có thanh toán thật.</p></div></section>
    <section className="container guide-steps"><article><div className="guide-step-head"><span>01</span><Icon name="search" size={29}/></div><h2>Khám phá sản phẩm</h2><p>Duyệt thực phẩm bổ sung hoặc thực phẩm cho bé. Bạn có thể tìm theo từ khóa, xem thông tin sản phẩm và chọn số lượng.</p><Link href="/san-pham" className="inline-link">Đến danh mục <Icon name="arrow" size={18}/></Link></article><article><div className="guide-step-head"><span>02</span><Icon name="bag" size={29}/></div><h2>Kiểm tra giỏ hàng</h2><p>Giỏ lưu mã sản phẩm và số lượng. Giá bằng VND được lấy lại từ catalog khi bạn mở giỏ; giá quá 24 giờ sẽ bị chặn tại checkout.</p><Link href="/gio-hang" className="inline-link">Đến giỏ hàng <Icon name="arrow" size={18}/></Link></article><article><div className="guide-step-head"><span>03</span><Icon name="shield" size={29}/></div><h2>Tạo đơn mô phỏng</h2><p>Nhập thông tin giao hàng tại Việt Nam. Máy chủ kiểm tra lại giá và trả mã đơn mô phỏng. Bạn chưa bị tính phí và chưa phát sinh mua hàng thật.</p><Link href="/thanh-toan" className="inline-link">Đến trang thanh toán <Icon name="arrow" size={18}/></Link></article></section>
    <section className="guide-details"><div className="container guide-details-inner"><h2>Những điều cần biết về giá và vận chuyển.</h2><div><h3>Tiền hàng bằng VND</h3><p>Giá sản phẩm hiển thị từ dữ liệu đã ghi nhận. Giá phải được cập nhật trong 24 giờ để được tạo đơn; máy chủ xác nhận lại trước khi lưu đơn mô phỏng.</p><h3>Phí vận chuyển tính riêng</h3><p>Hàng đi qua điểm nhận tại Nhật rồi chuyển về Việt Nam. Phí vận chuyển chỉ là ước tính ban đầu và dự kiến thu ở giai đoạn sau trong quy trình thực tế.</p><h3>Phiên bản thử nghiệm</h3><p>Website chưa tích hợp cổng thanh toán thật, chưa xác nhận đơn mua và chưa thực hiện mua hộ. Trang xác nhận chỉ chứng minh API đã ghi nhận đơn mô phỏng.</p></div></div></section>
    <section className="container guide-bottom"><h2>Sẵn sàng khám phá?</h2><Link href="/san-pham" className="button button-primary">Xem sản phẩm <Icon name="arrow"/></Link></section>
  </>;
}
