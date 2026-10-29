import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SITE_URL } from "@/lib/server-catalog";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "mita japan — Chăm chút từng điều nhỏ", template: "%s | mita japan" },
  description: "Sản phẩm Nhật Bản cho sức khỏe và bữa ăn của bé. Đặt hàng tại Mita Japan bằng VND.",
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="vi"><body>{children}</body></html>;
}
