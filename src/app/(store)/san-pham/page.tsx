import type { Metadata } from "next";
import { Suspense } from "react";
import { CatalogView } from "@/components/catalog/catalog-view";
import { catalogSearchParams, getServerCatalog } from "@/lib/server-catalog";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Tất cả sản phẩm",
  alternates: { canonical: "/san-pham" },
};

export default async function ProductsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const initialParams = catalogSearchParams(await searchParams);
  const initialResult = await getServerCatalog({ ...initialParams, limit: 12 });
  return <Suspense fallback={<div className="container shopping-loading">Đang mở danh mục sản phẩm...</div>}><CatalogView initialResult={initialResult} initialParams={initialParams}/></Suspense>;
}
