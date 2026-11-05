import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CatalogView } from "@/components/catalog/catalog-view";
import { catalogSearchParams, getServerCatalog } from "@/lib/server-catalog";

export const dynamic = "force-dynamic";
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const { page, q, sort } = catalogSearchParams(await searchParams);
  const canonical = !q.trim() && sort === "reviews" && page > 1 ? `/san-pham?page=${page}` : "/san-pham";
  return { title: "Tất cả sản phẩm", alternates: { canonical } };
}

export default async function ProductsPage({ searchParams }: {
  searchParams: SearchParams;
}) {
  const initialParams = catalogSearchParams(await searchParams);
  const initialResult = await getServerCatalog({ ...initialParams, limit: 12 });
  if (initialParams.page > 1 && !initialResult.items.length) notFound();
  return <Suspense fallback={<div className="container shopping-loading">Đang mở danh mục sản phẩm...</div>}><CatalogView initialResult={initialResult} initialParams={initialParams}/></Suspense>;
}
