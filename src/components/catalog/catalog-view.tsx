"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ProductCard } from "@/components/catalog/product-card";
import { Icon } from "@/components/ui/icons";
import { CATEGORIES, categoryName } from "@/lib/format";
import { fetchCatalog } from "@/lib/catalog";
import type { CatalogResponse } from "@/types/catalog";

const PAGE_SIZE = 12;
const SORTS = [{ value: "reviews", label: "Phổ biến nhất" }, { value: "price-asc", label: "Giá thấp đến cao" }, { value: "price-desc", label: "Giá cao đến thấp" }];

type InitialCatalogParams = { category?: string; q: string; sort: string; page: number };

export function CatalogView({ category, initialResult, initialParams }: {
  category?: string;
  initialResult?: CatalogResponse;
  initialParams?: InitialCatalogParams;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const q = searchParams.get("q") || "";
  const sort = searchParams.get("sort") || "reviews";
  const rawPage = Number(searchParams.get("page") || 1);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const matchesInitial = Boolean(initialResult && initialParams && initialParams.category === category &&
    initialParams.q === q && initialParams.sort === sort && initialParams.page === page);
  const [result, setResult] = useState<CatalogResponse | null>(matchesInitial ? initialResult! : null);
  const [loading, setLoading] = useState(!matchesInitial);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [term, setTerm] = useState(q);
  const categoryLabel = category ? categoryName(category) : "Tất cả sản phẩm";

  useEffect(() => { setTerm(q); }, [q]);
  useEffect(() => {
    if (matchesInitial && retry === 0) {
      setResult(initialResult!); setLoading(false); setError("");
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    fetchCatalog({ category, q, page, limit: PAGE_SIZE, sort }).then(data => { if (active) setResult(data); }).catch(cause => { if (active) { setResult(null); setError(cause instanceof Error ? cause.message : "Không thể tải catalog."); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [category, q, sort, page, retry, matchesInitial, initialResult]);

  function update(params: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(params)) value ? next.set(key, value) : next.delete(key);
    router.push(`${pathname}${next.toString() ? `?${next}` : ""}`);
  }

  const totalPages = result ? Math.ceil(result.total / PAGE_SIZE) : 0;
  return <>
    <section className="catalog-intro"><div className="container">
      <nav className="breadcrumb" aria-label="Đường dẫn"><Link href="/">Trang chủ</Link><span>/</span><span>{categoryLabel}</span></nav>
      <div className="catalog-intro-layout"><div><h1>{category ? categoryLabel : "Từ Nhật, cho những điều gần gũi."}</h1><p className="lead">Khám phá các sản phẩm dành cho gia đình bạn.</p></div><span className="catalog-flower" aria-hidden="true"><Icon name="leaf" size={74}/></span></div>
    </div></section>
    <section className="container catalog-section" aria-label="Danh sách sản phẩm">
      <aside className={`catalog-sidebar ${filtersOpen ? "sidebar-open" : ""}`} id="catalog-filters">
        <div className="sidebar-heading"><strong>Danh mục</strong><button type="button" className="icon-button sidebar-close" onClick={() => setFiltersOpen(false)} aria-label="Đóng bộ lọc"><Icon name="x"/></button></div>
        <nav aria-label="Lọc theo danh mục">
          <Link href="/san-pham" onClick={() => setFiltersOpen(false)} className={!category ? "selected" : ""}>Tất cả sản phẩm <Icon name="arrow" size={16}/></Link>
          {CATEGORIES.map(item => <Link key={item.slug} href={`/danh-muc/${item.slug}`} onClick={() => setFiltersOpen(false)} className={category === item.slug ? "selected" : ""}>{item.name}<Icon name="arrow" size={16}/></Link>)}
        </nav>
      </aside>
      <div className="catalog-main">
        <form className="catalog-search" role="search" onSubmit={event => { event.preventDefault(); update({ q: term.trim(), page: null }); }}><label htmlFor="catalog-search" className="visually-hidden">Tìm trong sản phẩm</label><Icon name="search" size={19}/><input id="catalog-search" type="search" placeholder="Tìm whey, thực phẩm cho bé, thương hiệu..." value={term} onChange={event => setTerm(event.target.value)}/><button type="submit" className="text-button">Tìm kiếm <Icon name="arrow" size={17}/></button></form>
        <div className="catalog-toolbar"><div className="toolbar-left"><button type="button" className="filter-button" onClick={() => setFiltersOpen(value => !value)} aria-expanded={filtersOpen} aria-controls="catalog-filters"><Icon name="filter" size={18}/> Danh mục</button><span className="result-count" role="status">{loading ? "Đang tìm sản phẩm..." : `${result?.total ?? 0} sản phẩm`}</span></div><label className="sort-label">Sắp xếp <select value={SORTS.some(item => item.value === sort) ? sort : "reviews"} onChange={event => update({ sort: event.target.value, page: null })}>{SORTS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label></div>
        {sort === "top-reviews" && <p role="status">{result?.popularity?.note ?? "Chỉ hiển thị sản phẩm có bằng chứng bài nhận xét trong năm hiện tại. Chưa có bằng chứng thì danh sách trống."}</p>}
        {q && <div className="search-indicator">Kết quả cho <strong>“{q}”</strong><button type="button" onClick={() => { setTerm(""); update({ q: null, page: null }); }}>Xóa tìm kiếm <Icon name="x" size={14}/></button></div>}
        {loading ? <div className="product-grid" aria-busy="true" aria-label="Đang tải sản phẩm">{Array.from({length: 8}, (_, index) => <div key={index} className="product-skeleton"><div/><span/><span/><span/></div>)}</div>
          : error ? <div className="state-panel" role="alert"><Icon name="clock" size={30}/><h2>Chưa tải được sản phẩm</h2><p>{error}</p><button type="button" className="button button-primary" onClick={() => setRetry(value => value + 1)}>Thử lại <Icon name="arrow"/></button></div>
          : !result?.items.length ? <div className="state-panel"><Icon name="search" size={34}/><h2>Chưa tìm thấy sản phẩm phù hợp</h2><p>Thử tìm với từ khóa khác hoặc mở toàn bộ danh mục.</p><Link href="/san-pham" className="button button-primary">Xem tất cả sản phẩm <Icon name="arrow"/></Link></div>
          : <><div className="product-grid">{result.items.map(item => <ProductCard key={item.asin} product={item}/>)}</div>{totalPages > 1 && <nav className="pagination" aria-label="Phân trang"><button type="button" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>Trang trước</button><span>Trang {page} / {totalPages}</span><button type="button" disabled={page >= totalPages} onClick={() => update({ page: String(page + 1) })}>Trang sau <Icon name="arrow" size={16}/></button></nav>}</>}
      </div>
    </section>
  </>;
}
