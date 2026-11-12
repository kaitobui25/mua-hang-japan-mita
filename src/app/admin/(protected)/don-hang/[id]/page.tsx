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
  const hasAmazon = order.items.some(item => !!item.quote_snapshot);
  return <>
    <header><Link href="/admin/don-hang">← Đơn hàng</Link><h1>Chi tiết đơn hàng</h1><p className="admin-break">{order.id} · {date(order.created_at)}</p></header>
    <section className="admin-panel">
      <h2>Trạng thái</h2><p>{orderStatus[order.status] ?? order.status} · {paymentStatus[order.payment_status] ?? order.payment_status}</p>
      <h2>Người nhận</h2><dl><dt>Tên</dt><dd>{order.customer_name}</dd><dt>Điện thoại</dt><dd>{order.customer_phone}</dd><dt>Email</dt><dd>{order.customer_email ?? 'Không cung cấp'}</dd><dt>Địa chỉ</dt><dd>{order.customer_address}</dd></dl>
    </section>
    {session.role === 'owner' ? <OrderWorkflow id={order.id} csrf={session.csrfToken} status={order.status} payment={order.payment_status} amazon={hasAmazon} shippingConfirmed={!!order.shipping_confirmed_at}/> : <p className="admin-notice">Tài khoản nhân viên chỉ được xem; liên hệ owner để cập nhật đơn hàng.</p>}
    <section className="admin-panel">
      {order.status === 'purchase_request' ? <>
        <h2>Yêu cầu mua hộ — chưa báo giá</h2>
        <p>Chỉ ghi nhận sản phẩm và thông tin liên hệ. Giá quan sát từ Amazon không phải giá đã chốt. Chưa xác minh người bán, tồn kho, phí vận chuyển hoặc thanh toán.</p>
        <div className="admin-table-scroll"><table><thead><tr><th>Sản phẩm / ASIN</th><th>Số lượng yêu cầu</th><th>Giá Amazon quan sát</th><th>Thời điểm</th></tr></thead>
          <tbody>{order.items.map(item => <tr key={item.asin}><td>{item.name}<small>{item.asin}</small></td><td>{item.quantity}</td>
            <td>{item.price_jpy.toLocaleString('vi-VN')} JPY (chưa xác nhận)</td><td>{date(item.observed_at)}</td></tr>)}</tbody></table></div>
        <p><strong>Giá mua hộ Mita: chưa báo giá.</strong> Không thu tiền hoặc chuyển trạng thái sang mua hàng từ yêu cầu này. Mita cần liên hệ khách để xác nhận giá/phí và lập đơn có báo giá riêng.</p>
      </> : <>
      <h2>Tiền hàng đã chốt</h2>
      <p>Tỷ giá: {order.fx_jpy_to_vnd} VND/JPY · Phụ phí: {order.service_fee_percent}% · Chính sách giá: {order.pricing_policy_version ?? 'cũ'}</p>
      <div className="admin-table-scroll"><table><caption className="sr-only">Chi tiết sản phẩm</caption><thead><tr><th>Sản phẩm / ASIN</th><th>Số lượng</th><th>Giá JPY</th><th>Đơn giá VND</th><th>Thời điểm giá</th></tr></thead><tbody>{order.items.map((i,index) => <tr key={i.quote_snapshot?.id ?? `${i.asin}-${index}`}><td>{i.name}<small>{i.asin}</small>{i.quote_snapshot && <small>Mua hộ Amazon · Người bán: {i.quote_snapshot.seller} · Phân loại: {i.quote_snapshot.variant}</small>}{i.quote_snapshot && <small>Ngày giao Amazon hiển thị: {i.quote_snapshot.amazonDelivery ? `${i.quote_snapshot.amazonDelivery.start} – ${i.quote_snapshot.amazonDelivery.end}` : 'Chưa xác định'}. Dự kiến tại Việt Nam: {i.quote_snapshot.vietnamDelivery ? `${i.quote_snapshot.vietnamDelivery.start} – ${i.quote_snapshot.vietnamDelivery.end}` : 'Chưa xác định'} (cộng {i.quote_snapshot.deliveryDays} ngày).</small>}</td><td>{i.quantity}</td><td>{i.price_jpy.toLocaleString('vi-VN')} JPY</td><td>{money(i.unit_price_vnd)}</td><td>{date(i.observed_at)}</td></tr>)}</tbody></table></div>
      <p><strong>Tiền hàng: {money(order.merchandise_vnd)}</strong></p>
      <p>Phí vận chuyển dự tính: {order.estimated_shipping_vnd == null ? 'Chưa xác định' : money(order.estimated_shipping_vnd)}. {order.shipping_final_vnd == null ? 'Chưa chốt phí cuối cùng.' : `Phí đã chốt: ${money(order.shipping_final_vnd)}.`}</p>
      {hasAmazon && <p>Phí Mita đã đề xuất: {order.shipping_proposed_vnd == null ? 'Chưa có đề xuất' : money(order.shipping_proposed_vnd)}. {order.shipping_confirmed_at ? `Khách xác nhận: ${date(order.shipping_confirmed_at)}.` : 'Đang chờ khách xác nhận; không tự động thu phí.'}</p>}
      </>}
    </section>
  </>;
}
