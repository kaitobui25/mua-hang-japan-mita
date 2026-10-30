'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const links = [['/admin', 'Tổng quan'], ['/admin/thong-bao', 'Thông báo'], ['/admin/san-pham', 'Sản phẩm'], ['/admin/don-hang', 'Đơn hàng'], ['/admin/nhat-ky-loi', 'Nhật ký lỗi'], ['/admin/cau-hinh', 'Cấu hình']];
export function AdminNav({ role }: { role: 'owner' | 'staff' }) {
  const pathname = usePathname();
  const [unread, setUnread] = useState<number | null>(null);
  const [relayWarning, setRelayWarning] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch('/api/admin/notifications?unread=1&limit=1', { cache: 'no-store' });
        if (!response.ok) throw new Error('unavailable');
        const data = await response.json() as { unreadCount: number; relayStatus: string };
        if (active) { setUnread(data.unreadCount); setRelayWarning(data.relayStatus === 'unavailable'); }
      } catch { if (active) { setUnread(null); setRelayWarning(true); } }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, [pathname]);
  return <nav aria-label="Quản trị">{links.filter(([href]) => role === 'owner' || href === '/admin' || href === '/admin/thong-bao' || href === '/admin/don-hang').map(([href, label]) => <Link key={href} href={href} aria-current={(pathname === href || (href !== '/admin' && pathname.startsWith(href + '/'))) ? 'page' : undefined}>{label}{href === '/admin/thong-bao' && unread !== null && unread > 0 ? ` (${unread})` : ''}{href === '/admin/thong-bao' && relayWarning ? ' — mất kết nối VPS' : ''}</Link>)}</nav>;
}
