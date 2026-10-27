import Link from 'next/link';
import type { ReactNode } from 'react';
import { adminRead, type AdminSession } from '@/lib/admin-server';
import { Logout } from '@/components/admin/actions';
import { AdminNav } from '@/components/admin/nav';

export default async function ProtectedAdmin({ children }: { children: ReactNode }) {
  const session = await adminRead<AdminSession>('session');
  return <div className="admin-shell"><a href="#admin-content" className="skip-link">Chuyển đến nội dung quản trị</a><aside className="admin-sidebar"><Link href="/admin" className="wordmark">mita japan</Link><p>Chủ cửa hàng · Local</p><AdminNav/><Logout csrf={session.csrfToken}/><Link href="/">Xem cửa hàng ↗</Link></aside><main id="admin-content" className="admin-content">{children}</main></div>;
}
