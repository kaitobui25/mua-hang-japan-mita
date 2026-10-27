import type { ReactNode } from 'react';
import './admin.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Quản trị Mita Japan', robots: { index: false, follow: false } };
export default function AdminLayout({ children }: { children: ReactNode }) { return <div className="admin-root">{children}</div>; }
