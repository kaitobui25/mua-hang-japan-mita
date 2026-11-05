import type { Metadata } from "next";
import { AmazonQuoteView } from "@/components/amazon/amazon-quote-view";

export const metadata: Metadata = { title: "Mua hộ Amazon Nhật", description: "Tra thông tin sản phẩm Amazon.co.jp, xem báo giá có thời hạn và gửi yêu cầu mua hộ qua Mita Japan.", alternates: { canonical: "/mua-ho-amazon" } };

export default async function AmazonPage({ searchParams }: { searchParams: Promise<{ input?: string }> }) {
  const params = await searchParams;
  return <AmazonQuoteView initialInput={(params.input ?? "").slice(0,2048)}/>;
}
