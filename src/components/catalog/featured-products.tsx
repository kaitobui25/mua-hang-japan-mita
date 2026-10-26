"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchCatalog } from "@/lib/catalog";
import { ProductCard } from "@/components/catalog/product-card";
import { Icon } from "@/components/ui/icons";
import type { CatalogProduct } from "@/types/catalog";

export function FeaturedProducts() {
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setStatus("loading");
    fetchCatalog({ limit: 4, page: 1, sort: "newest" }).then(result => { if (active) { setProducts(result.items); setStatus("ready"); } }).catch(() => { if (active) setStatus("error"); });
    return () => { active = false; };
  }, [retry]);
  return <section className="featured-section section-space"><div className="container">
    <div className="section-title-row"><div><h2>Chọn lựa cho mỗi ngày.</h2></div><Link href="/san-pham" className="inline-link">Xem tất cả <Icon name="arrow"/></Link></div>
    {status === "loading" && <div className="product-grid" aria-busy="true">{[1,2,3,4].map(index => <div key={index} className="product-skeleton"><div/><span/><span/><span/></div>)}</div>}
    {status === "error" && <div className="inline-state" role="alert">Catalog đang tạm gián đoạn. <button type="button" onClick={() => setRetry(value => value + 1)}>Tải lại <Icon name="arrow" size={15}/></button></div>}
    {status === "ready" && (products.length ? <div className="product-grid">{products.map(product => <ProductCard key={product.asin} product={product}/>)}</div> : <div className="inline-state">Chưa có sản phẩm được cập nhật. <Link href="/san-pham">Đến trang sản phẩm <Icon name="arrow" size={15}/></Link></div>)}
  </div></section>;
}
