"use client";

import { AmazonStars } from "./amazon-stars";

import Link from "next/link";
import { useState } from "react";
import { useCart } from "@/context/cart";
import { formatVnd, productStatus } from "@/lib/format";
import { Icon } from "@/components/ui/icons";
import { ProductImage } from "@/components/ui/product-image";
import type { CatalogProduct } from "@/types/catalog";

export function ProductCard({ product }: { product: CatalogProduct }) {
  const { add } = useCart();
  const [added, setAdded] = useState(false);
  const href = `/san-pham/${encodeURIComponent(product.asin)}`;
  const characters = Array.from(product.name);
  const shortName = characters.length > 28 ? `${characters.slice(0, 28).join("")}…` : product.name;
  const canAdd = product.status === "ready" && product.availability !== "out_of_stock" && product.availability !== "requires_verification";
  return <article className="product-card">
    <Link className="product-card-image-link" href={href} aria-label={`Xem ${product.name}`}><ProductImage src={product.imageUrl} name={product.name}/></Link>
    <div className="product-card-body">
      <span className="product-brand">{product.brand || "Sản phẩm Nhật"}</span>
      <h3><Link href={href} aria-label={product.name} title={product.name}>{shortName}</Link></h3>
      <AmazonStars product={product}/>
      <div className="product-price">{typeof product.priceVnd === "number" && product.priceVnd > 0 ? formatVnd(product.priceVnd) : "Giá đang cập nhật"}</div>
      {productStatus(product) && <div className="product-status">{productStatus(product)}</div>}
      <button className="product-add" type="button" disabled={!canAdd} onClick={() => { add(product.asin); setAdded(true); window.setTimeout(() => setAdded(false), 1900); }} aria-label={`Thêm ${product.name} vào giỏ`}><Icon name={added ? "check" : "plus"} size={17}/><span>{added ? "Đã thêm" : "Thêm vào giỏ"}</span></button>
    </div>
  </article>;
}
