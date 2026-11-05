import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CatalogView } from "@/components/catalog/catalog-view";
import { CATEGORIES, categoryName } from "@/lib/format";
import { catalogSearchParams, getServerCatalog } from "@/lib/server-catalog";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: SearchParams }): Promise<Metadata> {
  const { slug } = await params;
  if (!CATEGORIES.some(category => category.slug === slug)) notFound();
  const { page, q, sort } = catalogSearchParams(await searchParams);
  const canonical = !q.trim() && sort === "reviews" && page > 1 ? `/danh-muc/${slug}?page=${page}` : `/danh-muc/${slug}`;
  return { title: categoryName(slug), alternates: { canonical } };
}

export default async function CategoryPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: SearchParams;
}) {
  const { slug } = await params;
  if (!CATEGORIES.some(category => category.slug === slug)) notFound();
  const initialParams = { ...catalogSearchParams(await searchParams), category: slug };
  const initialResult = await getServerCatalog({ ...initialParams, limit: 12 });
  if (initialParams.page > 1 && !initialResult.items.length) notFound();
  return <Suspense fallback={<div className="container shopping-loading">Đang mở danh mục...</div>}><CatalogView category={slug} initialResult={initialResult} initialParams={initialParams}/></Suspense>;
}
