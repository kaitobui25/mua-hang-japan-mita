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

  return <>
    <section className="review-page-intro"><div className="container">
      <nav className="breadcrumb" aria-label="Đường dẫn"><Link href="/">Trang chủ</Link><span>/</span><span>Hình ảnh phản hồi</span></nav>
      <span className="overline">Mita Japan / Thư viện hình ảnh</span>
      <h1>{demoCount > 0 && demoCount === images.length ? 'Góc trao đổi cùng Mita' : 'Những lời gửi lại.'}</h1>
      <p className="lead">Hình ảnh trao đổi và những tình huống tư vấn mẫu từ Mita Japan.</p>
    </div></section>
    <section className="review-gallery-section container" aria-labelledby="review-gallery-heading">
      <div className="review-gallery-intro">
        <div><span className="overline">Hình ảnh phản hồi</span><h2 id="review-gallery-heading">Thư viện hình ảnh</h2></div>
      </div>
      {demoCount > 0 && <p className="review-demo-intro">Một vài tình huống tư vấn mẫu để bạn hình dung cách Mita Japan hỗ trợ.</p>}
      <ReviewCarousel images={images}/>
    </section>
    <section className="review-page-footer"><div className="container review-page-footer-inner">
      <div><span className="overline">Mita Japan</span><h2>Chọn sản phẩm phù hợp với bạn.</h2></div>
      <Link className="button button-primary" href="/san-pham">Xem sản phẩm</Link>
    </div></section>
  </>;
}
