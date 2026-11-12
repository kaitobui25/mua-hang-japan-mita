"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icons";
import { ProductImage } from "@/components/ui/product-image";
import { ProductInformation } from "@/components/catalog/product-information";
import { QuantitySelector } from "@/components/cart/quantity-selector";
import { formatVnd } from "@/lib/format";
import type { AmazonQuote, AmazonSourcePreview, AmazonObservedDetails } from "@/types/amazon-quote";
import { AmazonPurchaseRequest } from "@/components/amazon/amazon-purchase-request";

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
  return <div className="amazon-stars" style={{ fontSize: "0.8rem" }}>
    {stars !== undefined && <span aria-label={`${stars} trên 5 sao`} style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
      <span>{stars.toLocaleString("vi-VN")}</span>
      <span aria-hidden="true" style={{ position: "relative", display: "inline-block", color: "var(--color-muted)", lineHeight: 1, whiteSpace: "nowrap" }}>
        ★★★★★<span style={{ position: "absolute", inset: 0, width: `${Math.round(stars * 20)}%`, overflow: "hidden", color: "var(--color-accent)" }}>★★★★★</span>
      </span>
    </span>}
    {reviews !== undefined && <span> ({reviews.toLocaleString("vi-VN")} lượt đánh giá)</span>}
  </div>;
}

function info(source?: AmazonObservedDetails, translated?: AmazonObservedDetails) {
  if (!source) return null;
  const fields = { ...source, ...translated };
  return { description: fields.description, detail: {
    features: fields.features ?? [], ingredients: fields.ingredients ? [fields.ingredients] : [],
    usage: fields.usage ? [fields.usage] : [], cautions: fields.warnings ? [fields.warnings] : [],
    specs: Object.fromEntries((fields.specifications ?? []).map(({ name, value }) => [name, value])),
    variantAttributes: {},
  } };
}

/** Match the catalog detail hierarchy without turning source facts into a purchase quote. */
export function AmazonSourceProductDetail({ preview, purchaseRequest }: {
  preview: AmazonSourcePreview; purchaseRequest?: { id: string; expiresAt: string } | null;
}) {
  const [selectedImage, setSelectedImage] = useState("");
  const display = preview.display ?? preview.observedDetails;
  const localized = info(display, preview.translated);
  const title = preview.translated?.title || preview.title;
  const pictures = [...new Set((display?.images ?? []).filter(sourceImage))].slice(0, 10);
  const currentImage = pictures.includes(selectedImage) ? selectedImage : pictures[0];
  return <article className="amazon-quote-result amazon-source-result" aria-label="Chi tiết sản phẩm mua hộ">
    <section className="product-detail" aria-label="Sản phẩm Amazon">
      <div className="detail-image">
        <ProductImage key={currentImage ?? "empty"} src={currentImage} name={title} priority/>
        {pictures.length > 1 && <div className="detail-gallery" aria-label="Ảnh sản phẩm">
          {pictures.map((src, index) => <button key={src} type="button" className={src === currentImage ? "gallery-thumb active" : "gallery-thumb"}
            onClick={() => setSelectedImage(src)} aria-pressed={src === currentImage} aria-label={`Xem ảnh ${index + 1}`}>
            <img src={src} alt="" loading="lazy"/>
          </button>)}
        </div>}
      </div>
      <div className="detail-content">
        {display?.brand && <p className="product-brand">{preview.translated?.brand || display.brand}</p>}
        <h1 className="amazon-preview-title">{title}</h1>
        <SourceRating rating={display?.rating} count={display?.reviewCount}/>
        <p><a href={preview.sourceUrl} target="_blank" rel="noopener noreferrer">Xem sản phẩm gốc trên Amazon Japan ↗</a></p>
        <p className="detail-category">Mua hộ Amazon</p>
        <div className="detail-price-block">
          <div className="detail-price">{preview.estimatedPriceVnd ? formatVnd(preview.estimatedPriceVnd) : "Giá đang cập nhật"}</div>
          <small>Giá VND tham khảo theo tỷ giá và phụ phí Mita; chưa phải báo giá chốt.</small>
        </div>
        <p className="detail-eta"><Icon name="truck" size={18}/> Ngày giao dự kiến tại Nhật: <strong>{preview.advertisedJapanDeliveryDate ? date(preview.advertisedJapanDeliveryDate) : "Chưa xác định"}</strong>
          {preview.advertisedDeliveryConditional && <small> (ưu đãi có điều kiện, chưa chắc áp dụng cho Mita)</small>}
        </p>
        {purchaseRequest ? <AmazonPurchaseRequest key={purchaseRequest.id} requestId={purchaseRequest.id} expiresAt={purchaseRequest.expiresAt}/> :
          <p className="detail-notice" role="status">Chưa đủ dữ liệu để gửi yêu cầu. Hãy tra lại link Amazon.</p>}
        <div className="detail-facts"><p><Icon name="truck"/> Phí vận chuyển tính riêng, Mita xác nhận trước khi mua.</p></div>
        <dl className="detail-metadata"><div><dt>Mã sản phẩm</dt><dd>{preview.asin}</dd></div></dl>
      </div>
    </section>
    {localized && <ProductInformation description={localized.description} detail={localized.detail}
      hasStructuredRatings={display?.rating !== undefined || display?.reviewCount !== undefined}
      className="detail-description"/>}
  </article>;
}

export function AmazonProductDetail({
  quote, quantity, onQuantityChange, onRefresh, refreshing, expired,
  confirmed, onConfirm, added, onAdd,
}: Props) {
  const [selectedImage, setSelectedImage] = useState("");
  const display = quote.display;
  const pictures = [...new Set((display?.images ?? []).filter(sourceImage))].slice(0, 10);
  const currentImage = pictures.includes(selectedImage) ? selectedImage : pictures[0];
  const quantityChanged = quantity !== quote.quantity;
  const canAdd = quote.canOrder && quote.freeShipping && !refreshing && !expired && !quantityChanged;
  const localized = info(display, quote.translated);
  const amazonUrl = `https://www.amazon.co.jp/dp/${encodeURIComponent(quote.asin)}`;

  return <article className="amazon-quote-result" aria-live="polite">
    <section className="product-detail" aria-label="Chi tiết sản phẩm mua hộ Amazon">
      <div className="detail-image">
        <ProductImage key={currentImage ?? "empty"} src={currentImage} name={quote.translated?.title || quote.name} priority/>
        {pictures.length > 1 && <div className="detail-gallery" aria-label="Bộ ảnh sản phẩm">
          {pictures.map((src, index) => <button type="button" key={src}
            className={src === currentImage ? "gallery-thumb active" : "gallery-thumb"}
            onClick={() => setSelectedImage(src)} aria-label={`Xem ảnh ${index + 1}`}
            aria-pressed={src === currentImage}>
            <img src={src} alt="" loading="lazy"/>
          </button>)}
        </div>}
      </div>

      <div className="detail-content">
        {display?.brand && <p className="product-brand">{quote.translated?.brand || display.brand}</p>}
        <h1>{quote.translated?.title || quote.name}</h1>
        <SourceRating rating={display?.rating} count={display?.reviewCount}/>
        <p><a href={amazonUrl} target="_blank" rel="noopener noreferrer">Xem sản phẩm gốc trên Amazon Japan ↗</a></p>
        <p className="detail-category">Mua hộ Amazon</p>
        <div className="detail-price-block"><div className="detail-price">{formatVnd(quote.priceVnd)}</div></div>
        <p className="detail-eta"><Icon name="truck" size={18}/> Dự kiến tới Việt Nam: <strong>{period(quote.vietnamDeliveryDate, quote.vietnamDeliveryEnd)}</strong></p>
        {quote.warning && <p className="inline-alert" role="status">{quote.warning}</p>}
        {expired && <p className="inline-alert" role="alert">Báo giá đã hết hạn. Cần tra lại trước khi thêm vào giỏ.</p>}

        <div className="quantity-field"><span>Số lượng</span><QuantitySelector value={quantity} onChange={onQuantityChange}/></div>
        {quantityChanged && <p className="inline-alert" role="status">Bạn đã đổi số lượng. Giá và điều kiện giao hiện tại chỉ áp dụng cho {quote.quantity} sản phẩm. Hãy cập nhật báo giá.</p>}
        {(expired || quantityChanged) && <button type="button" className="button button-outline amazon-update-quote" disabled={refreshing} onClick={onRefresh}>Cập nhật báo giá cho {quantity} sản phẩm</button>}

        {canAdd ? <>
          <label className="amazon-consent"><input type="checkbox" checked={confirmed} onChange={event => onConfirm(event.target.checked)}/>
            <span>Tôi xác nhận đúng sản phẩm, phiên bản, người bán, số lượng, giá và hiểu phí vận chuyển về Việt Nam được tính riêng sau.{!quote.amazonDeliveryDate && " Ngày giao hiện chưa xác định."}</span>
          </label>
          <button type="button" className="button button-primary detail-cta" disabled={!confirmed || added} onClick={onAdd}>
            <Icon name={added ? "check" : "bag"}/>{added ? "Đã thêm vào giỏ" : "Thêm vào giỏ"}<Icon name="arrow"/>
          </button>
          {added && <p className="cart-added" role="status"><Icon name="check" size={18}/> Đã thêm vào giỏ. <Link href="/gio-hang">Xem giỏ hàng</Link></p>}
        </> : !expired && !quantityChanged && <p className="detail-notice">Chưa đủ điều kiện đặt mua. Vui lòng kiểm tra lại dữ liệu nguồn.</p>}
        <div className="detail-facts"><p><Icon name="truck"/> Phí vận chuyển tính riêng.</p></div>
        <dl className="detail-metadata"><div><dt>Mã sản phẩm</dt><dd>{quote.asin}</dd></div></dl>
      </div>
    </section>
    {localized && <ProductInformation description={localized.description} detail={localized.detail}
      hasStructuredRatings={display?.rating !== undefined || display?.reviewCount !== undefined} className="detail-description"/>}
  </article>;
}
