"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useCart } from "@/context/cart";
import { fetchProduct } from "@/lib/catalog";
import { canCheckout, categoryName, formatObservation, formatVnd, productStatus } from "@/lib/format";
import { Icon } from "@/components/ui/icons";
import { ProductImage } from "@/components/ui/product-image";
import { QuantitySelector } from "@/components/cart/quantity-selector";
import type { CatalogProduct } from "@/types/catalog";

export function ProductDetail({ asin }: { asin: string }) {
  const { add } = useCart();
  const [product, setProduct] = useState<CatalogProduct | null>(null);
  const [selected, setSelected] = useState("");
  const [selectedImage, setSelectedImage] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [added, setAdded] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setProduct(null); setSelected(""); setSelectedImage("");
    fetchProduct(asin).then(data => { if (active) { setProduct(data); setSelected(data.asin); } }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Không tìm thấy sản phẩm."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [asin, retry]);
  if (loading) return <section className="container detail-loading"><div className="product-skeleton large"><div/><span/><span/><span/></div><div className="product-skeleton large"><div/><span/><span/><span/></div></section>;
  if (error || !product) return <section className="container state-panel detail-error" role="alert"><h1>Chưa tải được sản phẩm</h1><p>{error}</p><button type="button" className="button button-primary" onClick={() => setRetry(value => value + 1)}>Thử lại</button><Link href="/san-pham" className="inline-link">Trở về danh mục</Link></section>;
  // Variant choices come exclusively from the source-grouped detail response.
  const variants = (product.variants?.length ? product.variants : [product])
    .filter((item, index, all) => all.findIndex(current => current.asin === item.asin) === index);
  const item = variants.find(variant => variant.asin === selected) || product;
  const pictures = [...new Set((item.imageUrls?.length ? item.imageUrls : item.imageUrl ? [item.imageUrl] : []).filter(Boolean))].slice(0, 5);
  const activeImage = pictures.includes(selectedImage) ? selectedImage : pictures[0] || item.imageUrl;
  const attributes = [...new Set(variants.flatMap(variant => Object.keys(variant.variantAttributes ?? {})))];
  const changeVariant = (asin: string) => { setSelected(asin); setSelectedImage(""); setAdded(false); };
  const selectAttribute = (key: string, value: string) => {
    const candidates = variants.filter(variant => variant.variantAttributes?.[key] === value);
    const next = candidates.find(variant => attributes.every(attr => attr === key || variant.variantAttributes?.[attr] === item.variantAttributes?.[attr])) ?? candidates[0];
    if (next) changeVariant(next.asin);
  };
  const purchasable = item.status === "ready" && item.availability !== "out_of_stock" && item.availability !== "requires_verification";
  const observedAt = formatObservation(item.priceObservedAt);
  return <><div className="container"><nav className="breadcrumb detail-breadcrumb" aria-label="Đường dẫn"><Link href="/">Trang chủ</Link><span>/</span><Link href="/san-pham">Sản phẩm</Link><span>/</span><Link href={`/danh-muc/${item.categorySlug}`}>{categoryName(item.categorySlug)}</Link></nav></div>
    <section className="container product-detail">
      <div className="detail-image"><ProductImage src={activeImage} name={item.name}/>
        {pictures.length > 1 && <div className="detail-gallery" aria-label="Bộ ảnh sản phẩm">{pictures.map((src, index) => <button type="button" key={src} className={src === activeImage ? "gallery-thumb active" : "gallery-thumb"} onClick={() => setSelectedImage(src)} aria-label={`Xem ảnh ${index + 1}`} aria-pressed={src === activeImage}><img src={src} alt="" loading="lazy"/></button>)}</div>}
        <p>Ảnh từ dữ liệu catalog khi nguồn cho phép hiển thị.</p></div>
      <div className="detail-content"><p className="product-brand">{item.brand || "Sản phẩm Nhật"}</p><h1>{item.name}</h1><p className="detail-category">{categoryName(item.categorySlug)}</p>
        <div className="detail-price-block"><div className="detail-price">{item.priceVnd && item.priceVnd > 0 ? formatVnd(item.priceVnd) : "Giá đang cập nhật"}</div><p className={canCheckout(item) ? "status-good" : "status-warning"}><Icon name="clock" size={17}/>{productStatus(item)}</p>{observedAt && <small>Giá ghi nhận: {observedAt} (giờ Việt Nam)</small>}</div>
        {variants.length > 1 && <fieldset className="variant-field"><legend>Chọn phiên bản theo sản phẩm nguồn</legend>
          {attributes.length > 0 ? <div className="variant-selectors">{attributes.map(attribute => <label key={attribute}><span>{attribute}</span><select value={item.variantAttributes?.[attribute] ?? ""} onChange={event => selectAttribute(attribute, event.target.value)}><option value="" disabled>Chọn {attribute}</option>{[...new Set(variants.map(variant => variant.variantAttributes?.[attribute]).filter((value): value is string => !!value))].map(value => <option key={value} value={value}>{value}</option>)}</select></label>)}</div>
            : <div className="variant-list">{variants.map(variant => <label key={variant.asin} className={selected === variant.asin ? "variant selected" : "variant"}><input type="radio" name="variant" value={variant.asin} checked={selected === variant.asin} onChange={() => changeVariant(variant.asin)}/><span>{variant.name} ({variant.asin}) · {variant.priceVnd ? formatVnd(variant.priceVnd) : "Chưa có giá"}</span></label>)}</div>}
          <p className="variant-asin">ASIN đã chọn: {item.asin}</p>
        </fieldset>}
        <div className="quantity-field"><span>Số lượng</span><QuantitySelector value={quantity} onChange={setQuantity}/></div>
        <button className="button button-primary detail-cta" type="button" disabled={!purchasable} onClick={() => { add(item.asin, quantity); setAdded(true); }}><Icon name={added ? "check" : "bag"}/>{added ? `Đã thêm ${quantity} sản phẩm` : "Thêm vào giỏ"}<Icon name="arrow"/></button>
        {added && <p className="cart-added" role="status"><Icon name="check" size={18}/> Đã thêm vào giỏ. <Link href="/gio-hang">Xem giỏ hàng</Link></p>}
        {!canCheckout(item) && <p className="detail-notice">Chưa thể thanh toán sản phẩm này. Hệ thống yêu cầu giá VND được cập nhật trong 24 giờ và sản phẩm đủ điều kiện đặt.</p>}
        <div className="detail-facts"><p><Icon name="shield"/> Giá được kiểm tra lại ở máy chủ khi tạo đơn.</p><p><Icon name="truck"/> Phí vận chuyển dự tính riêng; phí thực tế sẽ được xác định sau.</p></div>
        <dl className="detail-metadata"><div><dt>Mã sản phẩm (ASIN)</dt><dd>{item.asin}</dd></div>{item.priceJpy && <div><dt>Giá nguồn tham khảo</dt><dd>{new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(item.priceJpy)}</dd></div>}{item.sourceUrl && /^https:\/\//.test(item.sourceUrl) && <div><dt>Nguồn</dt><dd><a href={item.sourceUrl} rel="noopener noreferrer" target="_blank">Xem trang nguồn <Icon name="arrow" size={14}/></a></dd></div>}</dl>
      </div>
    </section>{(item.description || item.detail && (item.detail.features.length || item.detail.ingredients.length || item.detail.usage.length || Object.keys(item.detail.specs).length || item.detail.cautions.length)) &&
      <section className="container detail-description"><h2>Thông tin sản phẩm</h2><div className="detail-sections">
        {item.description && <p>{item.description}</p>}
        {item.detail && ([['Đặc điểm', item.detail.features], ['Thành phần', item.detail.ingredients], ['Cách sử dụng', item.detail.usage], ['Lưu ý', item.detail.cautions]] as const).map(([heading, values]) => values.length > 0 && <section key={heading}><h3>{heading}</h3><ul>{values.map((value, index) => <li key={`${heading}-${index}`}>{value}</li>)}</ul></section>)}
        {item.detail && Object.keys(item.detail.specs).length > 0 && <section><h3>Thông số</h3><dl className="detail-specifications">{Object.entries(item.detail.specs).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></section>}
      </div></section>}
  </>;
}
