import Link from 'next/link';
import type { AdminOrder } from '@/types/admin';

export const categories = [
  { slug: 'thuc-pham-bo-sung', name: 'Thực phẩm bổ sung · Whey protein' },
  { slug: 'thuc-pham-cho-be', name: 'Thực phẩm cho bé' },
];
export const categoryName = (slug: string) => categories.find(c => c.slug === slug)?.name ?? slug;
export const money = (value: number | string | null) => value === null ? 'Chưa có giá' : `${Number(value).toLocaleString('vi-VN')} VND`;
export const date = (value: string | null) => value ? new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Tokyo', hour12: false }) + ' JST' : 'Chưa hoàn tất';
export const importState = { pending: 'Đang chờ worker', running: 'Đang xác minh', succeeded: 'Đã nhập', failed: 'Thất bại' };

export function OrderTable({ items }: { items: AdminOrder[] }) {
  return <div className="admin-table-scroll"><table><caption className="sr-only">Đơn mô phỏng</caption><thead><tr><th>Mã đơn</th><th>Thời gian</th><th>Người nhận</th><th>Mặt hàng</th><th>Tiền hàng mô phỏng</th><th>Trạng thái</th></tr></thead><tbody>{items.map(o => <tr key={o.id}><td><Link href={`/admin/don-hang/${o.id}`}>{o.id.slice(0, 8)}</Link></td><td>{date(o.created_at)}</td><td>{o.customer_name}</td><td>{o.item_count}</td><td>{money(o.merchandise_vnd)}</td><td>simulation_created</td></tr>)}</tbody></table>{!items.length && <p className="admin-empty">Chưa có đơn mô phỏng phù hợp.</p>}</div>;
}
export function Pagination({ path, page, total, limit, filters = {} }: { path: string; page: number; total: number; limit: number; filters?: Record<string, string> }) {
  const url = (p: number) => `${path}?${new URLSearchParams({ ...filters, page: String(p) })}`;
  return <nav className="admin-pagination" aria-label="Phân trang">{page > 1 && <Link href={url(page - 1)}>← Trang trước</Link>}<span>Trang {page} · {total} kết quả</span>{page * limit < total && <Link href={url(page + 1)}>Trang sau →</Link>}</nav>;
}
