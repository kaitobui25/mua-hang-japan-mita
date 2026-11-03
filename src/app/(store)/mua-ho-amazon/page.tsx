import type { Metadata } from "next";
import { AmazonQuoteView } from "@/components/amazon/amazon-quote-view";

export const metadata: Metadata = { title: "Mua hộ Amazon Nhật", description: "Tra giá sản phẩm Amazon.co.jp và ngày giao thường dự kiến qua Mita Japan." };

export default async function AmazonPage({ searchParams }: { searchParams: Promise<{ input?: string }> }) {
  const params = await searchParams;
  return <AmazonQuoteView initialInput={(params.input ?? "").slice(0,2048)}/>;
}
