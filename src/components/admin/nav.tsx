'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const links = [['/admin', 'Tổng quan'], ['/admin/thong-bao', 'Thông báo'], ['/admin/san-pham', 'Sản phẩm'], ['/admin/don-hang', 'Đơn hàng'], ['/admin/nhat-ky-loi', 'Nhật ký lỗi'], ['/admin/cau-hinh', 'Cấu hình']];
export function AdminNav() {
  const pathname = usePathname();
  return <nav aria-label="Quản trị">{links.map(([href, label]) => <Link key={href} href={href} aria-current={(pathname === href || (href !== '/admin' && pathname.startsWith(href + '/'))) ? 'page' : undefined}>{label}</Link>)}</nav>;
}
