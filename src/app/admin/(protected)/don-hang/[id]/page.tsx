import Link from 'next/link';
import { notFound } from 'next/navigation';
import { adminRead } from '@/lib/admin-server';
import type { OrderDetail } from '@/types/admin';
import { date, money } from '@/components/admin/shared';

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9-]{36}$/i.test(id)) notFound();
  const order = await adminRead<OrderDetail>(`orders/${id}`);
  return <><header><Link href="/admin/don-hang">← Đơn hàng</Link><h1>Chi tiết đơn mô phỏng</h1><p className="admin-break">{order.id} · {date(order.created_at)}</p></header><section className="admin-panel"><p className="admin-notice">simulation_created · Chưa thanh toán, chưa mua trên Amazon.</p><h2>Người nhận</h2><dl><dt>Tên</dt><dd>{order.customer_name}</dd><dt>Điện thoại</dt><dd>{order.customer_phone}</dd><dt>Email</dt><dd>{order.customer_email ?? 'Không cung cấp'}</dd><dt>Địa chỉ</dt><dd>{order.customer_address}</dd></dl></section><section className="admin-panel"><h2>Snapshot lúc tạo đơn</h2><p>Tỷ giá {order.fx_jpy_to_vnd} VND/JPY · Phụ phí {order.service_fee_percent}% · Chính sách {order.pricing_policy_version ?? 'cũ (env)'}</p><div className="admin-table-scroll"><table><caption className="sr-only">Mặt hàng mô phỏng</caption><thead><tr><th>Sản phẩm / ASIN</th><th>Số lượng</th><th>Giá JPY</th><th>Đơn giá VND</th><th>Giá quan sát lúc</th></tr></thead><tbody>{order.items.map(i => <tr key={i.asin}><td>{i.name}<small>{i.asin}</small></td><td>{i.quantity}</td><td>{i.price_jpy.toLocaleString('vi-VN')} JPY</td><td>{money(i.unit_price_vnd)}</td><td>{date(i.observed_at)}</td></tr>)}</tbody></table></div><p><strong>Tiền hàng mô phỏng: {money(order.merchandise_vnd)}</strong></p><p>Phí vận chuyển ước tính thu sau: {money(order.estimated_shipping_vnd)}. Chưa phải phí cuối cùng.</p></section></>;
}
