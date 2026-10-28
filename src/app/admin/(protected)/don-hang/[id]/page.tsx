import Link from 'next/link';
import { notFound } from 'next/navigation';
import { adminRead, type AdminSession } from '@/lib/admin-server';
import type { OrderDetail } from '@/types/admin';
import { date, money, orderStatus, paymentStatus } from '@/components/admin/shared';
import { OrderWorkflow } from '@/components/admin/order-workflow';

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9-]{36}$/i.test(id)) notFound();
  const [order, session] = await Promise.all([
    adminRead<OrderDetail>(`orders/${id}`), adminRead<AdminSession>('session')
  ]);
  return <>
    <header><Link href="/admin/don-hang">← Đơn hàng</Link><h1>Chi tiết đơn hàng</h1><p className="admin-break">{order.id} · {date(order.created_at)}</p></header>
    <section className="admin-panel">
      <h2>Trạng thái</h2><p>{orderStatus[order.status] ?? order.status} · {paymentStatus[order.payment_status] ?? order.payment_status}</p>
      <h2>Người nhận</h2><dl><dt>Tên</dt><dd>{order.customer_name}</dd><dt>Điện thoại</dt><dd>{order.customer_phone}</dd><dt>Email</dt><dd>{order.customer_email ?? 'Không cung cấp'}</dd><dt>Địa chỉ</dt><dd>{order.customer_address}</dd></dl>
    </section>
    <OrderWorkflow id={order.id} csrf={session.csrfToken} status={order.status} payment={order.payment_status}/>
    <section className="admin-panel">
      <h2>Tiền hàng đã chốt</h2>
      <p>Tỷ giá: {order.fx_jpy_to_vnd} VND/JPY · Phụ phí: {order.service_fee_percent}% · Chính sách giá: {order.pricing_policy_version ?? 'cũ'}</p>
      <div className="admin-table-scroll"><table><caption className="sr-only">Chi tiết sản phẩm</caption><thead><tr><th>Sản phẩm / ASIN</th><th>Số lượng</th><th>Giá JPY</th><th>Đơn giá VND</th><th>Thời điểm giá</th></tr></thead><tbody>{order.items.map(i => <tr key={i.asin}><td>{i.name}<small>{i.asin}</small></td><td>{i.quantity}</td><td>{i.price_jpy.toLocaleString('vi-VN')} JPY</td><td>{money(i.unit_price_vnd)}</td><td>{date(i.observed_at)}</td></tr>)}</tbody></table></div>
      <p><strong>Tiền hàng: {money(order.merchandise_vnd)}</strong></p>
      <p>Phí vận chuyển dự tính: {money(order.estimated_shipping_vnd)}. {order.shipping_final_vnd == null ? 'Chưa chốt phí cuối cùng.' : `Phí đã chốt: ${money(order.shipping_final_vnd)}.`}</p>
    </section>
  </>;
}
