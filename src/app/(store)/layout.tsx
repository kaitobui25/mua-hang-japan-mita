import type { ReactNode } from 'react';
import { CartProvider } from '@/context/cart';
import { Header } from '@/components/layout/header';
import { Footer } from '@/components/layout/footer';
import { BottomNav } from '@/components/layout/bottom-nav';
import { SocialLauncher } from '@/components/layout/social-launcher';
import { contactHref, facebookMessengerHref, DEFAULT_FACEBOOK_PAGE, DEFAULT_ZALO_CONTACT } from '@/lib/contact-links';

export default function StoreLayout({ children }: { children: ReactNode }) {
  const zalo = contactHref(process.env.NEXT_PUBLIC_ZALO_CONTACT_URL ?? DEFAULT_ZALO_CONTACT, 'zalo');
  const messenger = facebookMessengerHref(process.env.NEXT_PUBLIC_FACEBOOK_PAGE_URL ?? DEFAULT_FACEBOOK_PAGE);
  return <CartProvider><a href="#main-content" className="skip-link">Chuyển đến nội dung chính</a><Header/><main id="main-content">{children}</main><Footer/><BottomNav/><SocialLauncher zalo={zalo} messenger={messenger}/></CartProvider>;
}
