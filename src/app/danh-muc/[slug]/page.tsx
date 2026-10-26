import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CatalogView } from "@/components/catalog/catalog-view";
import { CATEGORIES, categoryName } from "@/lib/format";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: categoryName(slug) };
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!CATEGORIES.some(category => category.slug === slug)) notFound();
  return <Suspense fallback={<div className="container shopping-loading">Đang mở danh mục...</div>}><CatalogView category={slug}/></Suspense>;
}
