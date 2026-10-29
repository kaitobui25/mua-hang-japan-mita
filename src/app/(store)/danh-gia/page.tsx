import type { Metadata } from 'next';
import Link from 'next/link';
import { ReviewCarousel } from '@/components/reviews/review-carousel';
import { loadReviewImages } from '@/components/reviews/review-images';

export const metadata: Metadata = {
  title: 'Hình ảnh phản hồi',
  description: 'Thư viện hình ảnh phản hồi tại Mita Japan. Ảnh demo được ghi nhãn minh họa hư cấu rõ ràng.',
};

// Scan the live public/reviews folder on each request, without a rebuild.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function ReviewsPage() {
  const images = await loadReviewImages();
  const demoCount = images.filter(image => image.isDemo).length;
  const realCount = images.length - demoCount;

  return <>
    <section className="review-page-intro"><div className="container">
      <nav className="breadcrumb" aria-label="Đường dẫn"><Link href="/">Trang chủ</Link><span>/</span><span>Hình ảnh phản hồi</span></nav>
      <span className="overline">Mita Japan / Thư viện hình ảnh</span>
      <h1>Những lời gửi lại.</h1>
      <p className="lead">Góc lưu giữ hình ảnh trao đổi và phản hồi do cửa hàng chia sẻ.</p>
    </div></section>
    <section className="review-gallery-section container" aria-labelledby="review-gallery-heading">
      <div className="review-gallery-intro">
        <div><span className="overline">Hình ảnh phản hồi</span><h2 id="review-gallery-heading">Thư viện hình ảnh</h2></div>
        <p>Ảnh thật cần được xác nhận quyền công bố và che thông tin riêng tư trước khi đưa vào thư viện.</p>
      </div>
      {demoCount > 0 && <div className="review-demo-notice" role="note">
        <strong>MINH HỌA – HƯ CẤU</strong>
        <p>{realCount === 0 ? 'Tất cả ảnh bên dưới là hội thoại giả lập để thử giao diện. Đây không phải đánh giá hay trải nghiệm mua hàng của khách thật.' : `${demoCount} ảnh minh họa giả lập được dùng để thử giao diện; không phải phản hồi khách hàng thật.`}</p>
      </div>}
      <ReviewCarousel images={images}/>
    </section>
    <section className="review-page-footer"><div className="container review-page-footer-inner">
      <div><span className="overline">Mita Japan</span><h2>Chọn sản phẩm phù hợp với bạn.</h2></div>
      <Link className="button button-primary" href="/san-pham">Xem sản phẩm</Link>
    </div></section>
  </>;
}
