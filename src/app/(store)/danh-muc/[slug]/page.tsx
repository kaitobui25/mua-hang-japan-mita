import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CatalogView } from "@/components/catalog/catalog-view";
import { CATEGORIES, categoryName } from "@/lib/format";
import { catalogSearchParams, getServerCatalog } from "@/lib/server-catalog";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  if (!CATEGORIES.some(category => category.slug === slug)) notFound();
  return { title: categoryName(slug), alternates: { canonical: `/danh-muc/${slug}` } };
}

export default async function CategoryPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  if (!CATEGORIES.some(category => category.slug === slug)) notFound();
  const initialParams = { ...catalogSearchParams(await searchParams), category: slug };
  const initialResult = await getServerCatalog({ ...initialParams, limit: 12 });
  return <Suspense fallback={<div className="container shopping-loading">Đang mở danh mục...</div>}><CatalogView category={slug} initialResult={initialResult} initialParams={initialParams}/></Suspense>;
}
