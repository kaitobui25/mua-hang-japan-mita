"use client";

import { AmazonStars } from "./amazon-stars";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useCart } from "@/context/cart";
import { fetchProduct } from "@/lib/catalog";
import { canCheckout, categoryName, formatVnd, productStatus } from "@/lib/format";
import { Icon } from "@/components/ui/icons";
import { ProductImage } from "@/components/ui/product-image";
import { ProductInformation } from "@/components/catalog/product-information";
import { QuantitySelector } from "@/components/cart/quantity-selector";
import type { CatalogProduct } from "@/types/catalog";
import { variantLabel } from "@/lib/variant-labels";

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
  const keys = variants.map(variant => attributes.map(attribute => variant.variantAttributes?.[attribute] ?? ""));
  const reliableAttributes = attributes.length > 0 && keys.every(values => values.every(Boolean)) && new Set(keys.map(values => JSON.stringify(values))).size === variants.length;
  const changeVariant = (asin: string) => { setSelected(asin); setSelectedImage(""); setAdded(false); };
  const selectAttribute = (key: string, value: string) => {
    const candidates = variants.filter(variant => variant.variantAttributes?.[key] === value);
    const next = candidates.find(variant => attributes.every(attr => attr === key || variant.variantAttributes?.[attr] === item.variantAttributes?.[attr])) ?? candidates[0];
    if (next) changeVariant(next.asin);
  };
  const purchasable = canCheckout(item);
  return <><div className="container"><nav className="breadcrumb detail-breadcrumb" aria-label="Đường dẫn"><Link href="/">Trang chủ</Link><span>/</span><Link href="/san-pham">Sản phẩm</Link><span>/</span><Link href={`/danh-muc/${item.categorySlug}`}>{categoryName(item.categorySlug)}</Link></nav></div>
    <section className="container product-detail">
      <div className="detail-image"><ProductImage src={activeImage} name={item.name}/>
        {pictures.length > 1 && <div className="detail-gallery" aria-label="Bộ ảnh sản phẩm">{pictures.map((src, index) => <button type="button" key={src} className={src === activeImage ? "gallery-thumb active" : "gallery-thumb"} onClick={() => setSelectedImage(src)} aria-label={`Xem ảnh ${index + 1}`} aria-pressed={src === activeImage}><img src={src} alt="" loading="lazy"/></button>)}</div>}
        </div>
      <div className="detail-content"><p className="product-brand">{item.brand || "Sản phẩm Nhật"}</p><h1>{item.name}</h1><AmazonStars product={item}/>{/^[A-Z0-9]{10}$/.test(item.asin) && <p><a href={`https://www.amazon.co.jp/dp/${item.asin}`} target="_blank" rel="noopener noreferrer">Xem sản phẩm gốc trên Amazon Japan ↗</a></p>}<p className="detail-category">{categoryName(item.categorySlug)}</p>
        <div className="detail-price-block"><div className="detail-price">{item.priceVnd && item.priceVnd > 0 ? formatVnd(item.priceVnd) : "Giá đang cập nhật"}</div>{productStatus(item) && <p className="status-warning">{productStatus(item)}</p>}</div>
        {variants.length > 1 && <fieldset className="variant-field"><legend>Chọn phiên bản theo sản phẩm nguồn</legend>
          {reliableAttributes ? <div className="variant-selectors">{attributes.map(attribute => <label key={attribute}><span>{variantLabel(attribute)}</span><select value={item.variantAttributes?.[attribute] ?? ""} onChange={event => selectAttribute(attribute, event.target.value)}><option value="" disabled>Chọn {variantLabel(attribute).toLowerCase()}</option>{[...new Set(variants.map(variant => variant.variantAttributes?.[attribute]).filter((value): value is string => !!value))].map(value => <option key={value} value={value}>{value}</option>)}</select></label>)}</div>
            : <div className="variant-list">{variants.map(variant => <label key={variant.asin} className={selected === variant.asin ? "variant selected" : "variant"}><input type="radio" name="variant" value={variant.asin} checked={selected === variant.asin} onChange={() => changeVariant(variant.asin)}/><span>{variant.name} ({variant.asin}) · {variant.priceVnd ? formatVnd(variant.priceVnd) : "Chưa có giá"}</span></label>)}</div>}
          <p className="variant-asin">ASIN đã chọn: {item.asin}</p>
        </fieldset>}
        <div className="quantity-field"><span>Số lượng</span><QuantitySelector value={quantity} onChange={setQuantity}/></div>
        <button className="button button-primary detail-cta" type="button" disabled={!purchasable} onClick={() => { add(item.asin, quantity); setAdded(true); }}><Icon name={added ? "check" : "bag"}/>{added ? `Đã thêm ${quantity} sản phẩm` : "Thêm vào giỏ"}<Icon name="arrow"/></button>
        {added && <p className="cart-added" role="status"><Icon name="check" size={18}/> Đã thêm vào giỏ. <Link href="/gio-hang">Xem giỏ hàng</Link></p>}
        {!canCheckout(item) && <p className="detail-notice">Sản phẩm hiện chưa nhận đặt hàng trực tuyến.</p>}
        <div className="detail-facts"><p><Icon name="truck"/> Phí vận chuyển tính riêng.</p></div>
        <dl className="detail-metadata"><div><dt>Mã sản phẩm</dt><dd>{item.asin}</dd></div></dl>
      </div>
    </section>
    <ProductInformation description={item.description} detail={item.detail} titleExtras={item.titleExtras}
      hasStructuredRatings={Boolean(item.amazon && (item.amazon.averageStars !== null || item.amazon.ratingsCount !== null))}/>
  </>;
}
