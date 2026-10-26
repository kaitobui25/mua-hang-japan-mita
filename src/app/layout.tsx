import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CartProvider } from "@/context/cart";
import { Header } from "@/components/layout/header";
import { Footer } from "@/components/layout/footer";
import { BottomNav } from "@/components/layout/bottom-nav";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "mita japan — Chăm chút từng điều nhỏ", template: "%s | mita japan" },
  description: "Khám phá sản phẩm Nhật Bản cho sức khỏe và bữa ăn của bé. Đặt hàng VND qua quy trình mô phỏng trên Mita Japan.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="vi"><body><CartProvider><a href="#main-content" className="skip-link">Chuyển đến nội dung chính</a><Header/><main id="main-content">{children}</main><Footer/><BottomNav/></CartProvider></body></html>;
}
