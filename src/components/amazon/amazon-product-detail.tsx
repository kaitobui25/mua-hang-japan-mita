"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icons";
import { ProductImage } from "@/components/ui/product-image";
import { ProductInformation } from "@/components/catalog/product-information";
import { QuantitySelector } from "@/components/cart/quantity-selector";
import { formatVnd } from "@/lib/format";
import type { AmazonQuote, AmazonSourcePreview } from "@/types/amazon-quote";

type Props = {
  quote: AmazonQuote;
  quantity: number;
  onQuantityChange: (value: number) => void;
  onRefresh: () => void;
  refreshing: boolean;
  expired: boolean;
  confirmed: boolean;
  onConfirm: (value: boolean) => void;
  added: boolean;
  onAdd: () => void;
};

const jpy = (amount: number) => new Intl.NumberFormat("ja-JP", {
  style: "currency", currency: "JPY", maximumFractionDigits: 0,
}).format(amount);
const date = (value: string) => {
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00+09:00` : value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Tokyo",
  }).format(parsed);
};
const period = (start?: string | null, end?: string | null) =>
  start ? `${date(start)}${end && end !== start ? ` – ${date(end)}` : ""}` : "Chưa xác định";
const deadline = (value: string) => new Intl.DateTimeFormat("vi-VN", {
  hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit",
  year: "numeric", timeZone: "Asia/Tokyo",
}).format(new Date(value)) + " JST";

function sourceImage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port &&
      /^(?:[a-z0-9-]+\.)*media-amazon\.com$/i.test(parsed.hostname) && parsed.pathname.startsWith("/images/I/");
  } catch { return false; }
}

function SourceRating({ rating, count }: { rating?: number; count?: number }) {
  const stars = typeof rating === "number" && rating > 0 && rating <= 5 && Number.isFinite(rating) ? rating : undefined;
  const reviews = typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
  if (stars === undefined && reviews === undefined) return null;
  return <div className="amazon-detail-rating" aria-label="Đánh giá tại Amazon Japan">
    {stars !== undefined && <span aria-label={`${stars} trên 5 sao`} className="amazon-rating-value">
      {stars.toLocaleString("vi-VN")}
      <span className="amazon-rating-stars" aria-hidden="true">★★★★★<span style={{ width: `${Math.round(stars * 20)}%` }}>★★★★★</span></span>
    </span>}
    {reviews !== undefined && <span>{reviews.toLocaleString("vi-VN")} lượt đánh giá trên Amazon</span>}
  </div>;
}

/** Product-page layout for source evidence only. It never enables quote/cart actions. */
export function AmazonSourceProductDetail({ preview, error }: { preview: AmazonSourcePreview; error: string }) {
  const [selectedImage, setSelectedImage] = useState("");
  const display = preview.display;
  const pictures = [...new Set((display?.images ?? []).filter(sourceImage))].slice(0, 10);
  const currentImage = pictures.includes(selectedImage) ? selectedImage : pictures[0];
  const detail = display && {
    features: display.features ?? [],
    ingredients: display.ingredients ? [display.ingredients] : [],
    usage: display.usage ? [display.usage] : [],
    cautions: display.warnings ? [display.warnings] : [],
    specs: Object.fromEntries((display.specifications ?? []).map(({ name, value }) => [name, value])),
    variantAttributes: {},
  };
  const translationText = Array.from([preview.title, display?.description, ...(display?.features ?? [])]
    .filter(Boolean).join("\n\n").toWellFormed()).slice(0, 1200).join("");
  const googleTranslateUrl = `https://translate.google.com/?sl=auto&tl=vi&text=${encodeURIComponent(translationText)}&op=translate`;

  return <article className="amazon-quote-result amazon-source-result" aria-label="Thông tin sản phẩm từ Amazon">
    <p className="amazon-preview-result-status" role="status">Đã đọc thông tin sản phẩm từ Amazon. Chưa có báo giá mua hộ hợp lệ.</p>
    <section className="product-detail amazon-product-detail" aria-label="Sản phẩm quan sát từ Amazon">
      <div className="detail-image">
        <ProductImage key={currentImage ?? "empty"} src={currentImage} name={preview.title} priority/>
        {pictures.length > 1 && <div className="detail-gallery" aria-label="Ảnh sản phẩm từ Amazon">
          {pictures.map((src, index) => <button key={src} type="button" className={src === currentImage ? "gallery-thumb active" : "gallery-thumb"}
            onClick={() => setSelectedImage(src)} aria-pressed={src === currentImage} aria-label={`Xem ảnh ${index + 1}`}>
            <ProductImage src={src} name={`Ảnh ${index + 1} của ${preview.title}`}/>
          </button>)}
        </div>}
        <p>{pictures.length ? "Ảnh sản phẩm từ Amazon." : "Chưa có ảnh được phép hiển thị; đang dùng ảnh dự phòng Mita."}</p>
      </div>
      <div className="detail-content amazon-detail-content">
        {display?.brand && <p className="product-brand">{display.brand}</p>}
        <p className="amazon-source">THÔNG TIN SẢN PHẨM TỪ AMAZON.CO.JP</p>
        <h2 className="amazon-preview-title">{preview.title}</h2>
        <SourceRating rating={display?.rating} count={display?.reviewCount}/>
        <div className="amazon-detail-identifiers">
          <p><strong>ASIN:</strong> {preview.asin}</p>
          <p><strong>Quan sát nguồn:</strong> <time dateTime={preview.observedAt}>{deadline(preview.observedAt)}</time></p>
        </div>
        <div className="amazon-detail-links">
          <a href={preview.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-link">Xem sản phẩm gốc trên Amazon <Icon name="arrow" size={15}/></a>
        </div>
        {preview.priceJpy !== undefined && <div className="detail-price-block">
          <p className="amazon-price-caption">Giá Amazon tham khảo, chưa phải báo giá Mita</p>
          <div className="detail-price">{jpy(preview.priceJpy)}</div>
        </div>}
        <p className="inline-alert amazon-preview-warning" role="alert">{error} Đây là thông tin nguồn, chưa phải báo giá. Chưa thể thêm vào giỏ hoặc đặt hàng.</p>
        <dl className="amazon-delivery-details amazon-preview-terms">
          <div><dt>Giá bán VND tại Mita</dt><dd>Chưa có báo giá hợp lệ</dd></div>
          <div><dt>Giao thường miễn phí tại Nhật</dt><dd>Chưa xác minh</dd></div>
          <div><dt>Ngày giao và phí vận chuyển</dt><dd>Chưa xác định</dd></div>
        </dl>
      </div>
    </section>
    <section className="amazon-translation-bar" aria-label="Dịch tên và thông tin nguồn">
      <div>
        <h2>Thông tin nguồn Amazon</h2>
        <p>Giữ nguyên ngôn ngữ từ nguồn. Google Dịch chỉ mở khi bạn chọn; không tự dịch nội dung.</p>
      </div>
      <a className="button button-outline" href={googleTranslateUrl} target="_blank" rel="noopener noreferrer">Dịch bằng Google <Icon name="arrow" size={18}/></a>
    </section>
    {display && <ProductInformation description={display.description} detail={detail}
      hasStructuredRatings={display.rating !== undefined || display.reviewCount !== undefined}
      className="detail-description amazon-detail-description"/>}
    {!!display?.reviews?.length && <section className="amazon-detail-reviews" aria-label="Đánh giá từ nguồn Amazon">
      <h2>Đánh giá từ Amazon</h2>
      <p>Đánh giá của nguồn Amazon, không phải đánh giá của khách Mita.</p>
      <div className="amazon-review-list">{display.reviews.map((review, index) => <article key={index} className="detail-info-card">
        {review.title && <h3>{review.title}</h3>}
        {review.rating !== undefined && <p>{review.rating.toLocaleString("vi-VN")} / 5 sao</p>}
        <p>{review.body}</p>
      </article>)}</div>
    </section>}
  </article>;
}

export function AmazonProductDetail({
  quote, quantity, onQuantityChange, onRefresh, refreshing, expired,
  confirmed, onConfirm, added, onAdd,
}: Props) {
  const [selectedImage, setSelectedImage] = useState("");
  const display = quote.display;
  // Legacy quote.imageUrl alone does not establish permission to re-display a source image.
  const pictures = [...new Set((display?.images ?? []).filter(sourceImage))].slice(0, 10);
  const currentImage = pictures.includes(selectedImage) ? selectedImage : pictures[0];
  const quantityChanged = quantity !== quote.quantity;
  const canAdd = quote.canOrder && quote.freeShipping && !refreshing && !expired && !quantityChanged;
  const detail = display && {
    features: display.features ?? [],
    ingredients: display.ingredients ? [display.ingredients] : [],
    usage: display.usage ? [display.usage] : [],
    cautions: display.warnings ? [display.warnings] : [],
    specs: Object.fromEntries((display.specifications ?? []).map(({ name, value }) => [name, value])),
    variantAttributes: {},
  };
  // Only user-triggered navigation to Google's public site: no paid API, no unofficial endpoint.
  // Never include any customer, cart or order details in the translation request.
  const translationText = [
    quote.name, display?.description, ...(display?.features ?? []),
    ...(display?.specifications ?? []).map(({ name, value }) => `${name}: ${value}`),
    display?.ingredients, display?.usage, display?.warnings,
  ].filter(Boolean).join("\n\n").toWellFormed();
  const shortTranslationText = Array.from(translationText).slice(0, 1200).join("");
  const googleTranslateUrl = `https://translate.google.com/?sl=auto&tl=vi&text=${encodeURIComponent(shortTranslationText)}&op=translate`;
  const amazonUrl = `https://www.amazon.co.jp/dp/${encodeURIComponent(quote.asin)}`;

  return <article className="amazon-quote-result" aria-live="polite">
    <section className="product-detail amazon-product-detail" aria-label="Chi tiết sản phẩm mua hộ Amazon">
      <div className="detail-image">
        <ProductImage key={currentImage ?? "empty"} src={currentImage} name={quote.name} priority/>
        {pictures.length > 1 && <div className="detail-gallery" aria-label="Bộ ảnh sản phẩm từ Amazon">
          {pictures.map((src, index) => <button type="button" key={src}
            className={src === currentImage ? "gallery-thumb active" : "gallery-thumb"}
            onClick={() => setSelectedImage(src)} aria-label={`Xem ảnh ${index + 1}`}
            aria-pressed={src === currentImage}>
            <ProductImage src={src} name={`Ảnh ${index + 1} của ${quote.name}`}/>
          </button>)}
        </div>}
        <p>{pictures.length ? "Ảnh sản phẩm từ nguồn Amazon Japan." : "Chưa có ảnh được xác minh; đang hiển thị ảnh dự phòng Mita."}</p>
      </div>

      <div className="detail-content amazon-detail-content">
        {display?.brand && <p className="product-brand">{display.brand}</p>}
        <p className="amazon-source">SẢN PHẨM MUA HỘ · AMAZON JAPAN</p>
        <h1>{quote.name}</h1>
        <SourceRating rating={display?.rating} count={display?.reviewCount}/>
        <div className="amazon-detail-identifiers">
          <p><strong>Phiên bản:</strong> {quote.variant || quote.name}</p>
          <p><strong>Người bán:</strong> {quote.seller}</p>
          <p><strong>ASIN:</strong> {quote.asin}</p>
        </div>
        <div className="amazon-detail-links">
          <a className="inline-link" href={amazonUrl} target="_blank" rel="noopener noreferrer">Xem sản phẩm gốc trên Amazon <Icon name="arrow" size={15}/></a>
        </div>

        <div className="detail-price-block">
          <p className="amazon-price-caption">Giá Mita đã bao gồm phụ phí</p>
          <div className="detail-price">{formatVnd(quote.priceVnd * quote.quantity)}</div>
          <small>Giá Amazon: {jpy(quote.priceJpy * quote.quantity)} / {quote.quantity} sản phẩm · Giá bán 1 sản phẩm: {formatVnd(quote.priceVnd)}</small>
        </div>

        <dl className="amazon-delivery-details">
          <div><dt><Icon name="truck" size={18}/> Ngày giao thường Amazon hiển thị</dt><dd>{period(quote.amazonDeliveryDate, quote.amazonDeliveryEnd)}</dd></div>
          <div><dt><Icon name="home" size={18}/> Dự kiến tới nhà tại Việt Nam</dt><dd>{period(quote.vietnamDeliveryDate, quote.vietnamDeliveryEnd)}</dd></div>
          <div><dt><Icon name="clock" size={18}/> Thời gian vận chuyển cộng thêm</dt><dd>{quote.deliveryBufferDays} ngày lịch</dd></div>
          <div><dt><Icon name="bag" size={18}/> Phí vận chuyển về Việt Nam</dt><dd>Chưa xác định · Báo riêng, khách xác nhận trước khi thu</dd></div>
        </dl>
        <p className="amazon-quote-validity"><Icon name="clock" size={16}/> Báo giá có hiệu lực đến {deadline(quote.expiresAt)}. Ngày giao chỉ là dự kiến, không xác minh đích nhận tại Nhật.</p>
        <p className="amazon-observed-at">Quan sát nguồn: <time dateTime={quote.observedAt}>{deadline(quote.observedAt)}</time>.</p>
        {quote.warning && <p className="inline-alert" role="status">{quote.warning}</p>}
        {expired && <p className="inline-alert" role="alert">Báo giá đã hết hạn. Cần tra lại trước khi thêm vào giỏ.</p>}

        <div className="quantity-field amazon-quantity-field"><span>Số lượng</span><QuantitySelector value={quantity} onChange={onQuantityChange}/></div>
        {quantityChanged && <p className="inline-alert" role="status">Bạn đã đổi số lượng. Giá và điều kiện giao hiện tại chỉ áp dụng cho {quote.quantity} sản phẩm. Hãy cập nhật báo giá.</p>}
        {(expired || quantityChanged) && <button type="button" className="button button-outline amazon-update-quote" disabled={refreshing} onClick={onRefresh}>Cập nhật báo giá cho {quantity} sản phẩm</button>}

        {canAdd ? <>
          <label className="amazon-consent"><input type="checkbox" checked={confirmed} onChange={event => onConfirm(event.target.checked)}/>
            <span>Tôi xác nhận đúng sản phẩm, phiên bản, người bán, số lượng, giá và hiểu phí vận chuyển về Việt Nam được tính riêng sau.{!quote.amazonDeliveryDate && " Ngày giao hiện chưa xác định."}</span>
          </label>
          <button type="button" className="button button-primary detail-cta" disabled={!confirmed || added} onClick={onAdd}>
            <Icon name={added ? "check" : "bag"}/>{added ? "Đã thêm vào giỏ" : "Thêm vào giỏ hàng"}<Icon name="arrow"/>
          </button>
          {added && <p className="cart-added" role="status"><Icon name="check" size={18}/> Đã thêm vào giỏ. <Link href="/gio-hang">Xem giỏ hàng</Link></p>}
        </> : !expired && !quantityChanged && <p className="detail-notice">Chưa đủ điều kiện đặt mua. Vui lòng kiểm tra lại dữ liệu nguồn.</p>}
        <dl className="detail-metadata">
          <div><dt>Giao thường miễn phí tại Nhật</dt><dd>{quote.freeShipping ? "Đã xác minh cho báo giá này" : "Chưa xác minh"}</dd></div>
          <div><dt>Điều kiện nguồn</dt><dd>{quote.shippingEvidence}</dd></div>
        </dl>
      </div>
    </section>

    <section className="amazon-translation-bar" aria-label="Dịch thông tin sản phẩm">
      <div>
        <h2>Thông tin nguồn Amazon</h2>
        <p>Thông tin dưới đây giữ nguyên từ nguồn. Google Dịch miễn phí mở ở tab riêng, không tự dịch trong Mita. Nếu Google Dịch không khả dụng, bạn vẫn có thể xem nguyên văn và mở trang Amazon. Văn bản gửi dịch có thể được rút gọn.</p>
      </div>
      <a className="button button-outline" href={googleTranslateUrl} target="_blank" rel="noopener noreferrer">Dịch bằng Google <Icon name="arrow" size={18}/></a>
      <details className="amazon-original-disclosure">
        <summary>Xem nguyên văn để đối chiếu</summary>
        <p>{quote.name}</p>
        {display?.description && <p>{display.description}</p>}
      </details>
      {display && <p className="amazon-display-provenance">Nội dung nguồn Amazon quan sát lúc <time dateTime={display.provenance.observedAt}>{deadline(display.provenance.observedAt)}</time>.</p>}
    </section>

    {display && <ProductInformation description={display.description} detail={detail} hasStructuredRatings={display.rating !== undefined || display.reviewCount !== undefined} className="detail-description amazon-detail-description"/>}
    {!!display?.reviews?.length && <section className="amazon-detail-reviews" aria-labelledby="amazon-review-heading">
      <h2 id="amazon-review-heading">Đánh giá từ Amazon</h2>
      <p>Trích thông tin nguồn được xác minh, không phải nhận xét của khách Mita.</p>
      <div className="amazon-review-list">{display.reviews.map((review, index) => <article key={index} className="detail-info-card">
        {review.title && <h3>{review.title}</h3>}
        {review.rating !== undefined && <p>{review.rating.toLocaleString("vi-VN")} / 5 sao</p>}
        <p>{review.body}</p>
      </article>)}</div>
    </section>}
  </article>;
}
