import type { ReactNode } from 'react';
import { CartProvider } from '@/context/cart';
import { Header } from '@/components/layout/header';
import { Footer } from '@/components/layout/footer';
import { BottomNav } from '@/components/layout/bottom-nav';

export default function StoreLayout({ children }: { children: ReactNode }) {
  return <CartProvider><a href="#main-content" className="skip-link">Chuyển đến nội dung chính</a><Header/><main id="main-content">{children}</main><Footer/><BottomNav/></CartProvider>;
}
