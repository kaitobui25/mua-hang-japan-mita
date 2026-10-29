import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ProductDetail } from "@/components/catalog/product-detail";
import { getServerProduct } from "@/lib/server-catalog";
import { preferredVariantAsin } from "@/lib/preferred-variant";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const product = await getServerProduct(id.toUpperCase());
  if (!product) notFound();
  const description = (product.description || product.detail?.features?.join(" ") ||
    `${product.name}${product.brand ? ` — ${product.brand}` : ""}. Xem thông tin sản phẩm tại Mita Japan.`)
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  return {
    title: product.name,
    description,
    alternates: { canonical: `/san-pham/${product.asin}` },
  };
}

export default async function ProductPage({ params }: Props) {
  const { id } = await params;
  const product = await getServerProduct(id.toUpperCase());
  if (!product) notFound();
  const preferred = preferredVariantAsin(product);
  if (preferred !== product.asin) redirect(`/san-pham/${preferred}`);
  return <ProductDetail key={product.asin} asin={product.asin} initialProduct={product}/>;
}
