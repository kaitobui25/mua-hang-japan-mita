import type { Metadata } from "next";
import { Suspense } from "react";
import { CatalogView } from "@/components/catalog/catalog-view";

export const metadata: Metadata = { title: "Tất cả sản phẩm" };

export default function ProductsPage() {
  return <Suspense fallback={<div className="container shopping-loading">Đang mở danh mục sản phẩm...</div>}><CatalogView/></Suspense>;
}
