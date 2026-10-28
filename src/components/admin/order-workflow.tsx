'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { adminWrite } from './actions';
import { orderStatus, paymentStatus } from './shared';

const next: Record<string, string[]> = {
  pending_confirmation: ['confirmed', 'cancelled'],
  confirmed: ['purchasing', 'cancelled'],
  purchasing: ['purchased', 'cancelled'],
  purchased: ['shipping'],
  shipping: ['completed'],
};

export function OrderWorkflow({ id, csrf, status, payment }: { id: string; csrf: string; status: string; payment: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shippingVnd, setShippingVnd] = useState('');
  async function change(body: { status?: string; paymentStatus?: string; shippingFinalVnd?: number }) {
    const label = body.status ? orderStatus[body.status] : body.paymentStatus ? paymentStatus[body.paymentStatus] : `Phí vận chuyển ${body.shippingFinalVnd?.toLocaleString('vi-VN')} VND`;
    if (!window.confirm(`Xác nhận cập nhật: ${label}?`)) return;
    setBusy(true); setError('');
    try { await adminWrite(`orders/${id}`, csrf, body, 'PATCH'); router.refresh(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  if (status === 'simulation_created') return <p className="admin-notice">Đơn mô phỏng cũ, chỉ lưu để tham khảo.</p>;
  return <section className="admin-panel">
    <h2>Xử lý đơn hàng</h2>
    <p>Trạng thái: <strong>{orderStatus[status] ?? status}</strong> · Thanh toán: <strong>{paymentStatus[payment] ?? payment}</strong></p>
    <div className="admin-form-row">
      {(next[status] ?? []).map(value => <button key={value} type="button" disabled={busy} onClick={() => void change({ status: value })}>{orderStatus[value]}</button>)}
      {payment === 'unpaid' && !['pending_confirmation','cancelled'].includes(status) && <button type="button" disabled={busy} onClick={() => void change({ paymentStatus: 'paid' })}>Xác nhận đã nhận tiền</button>}
      {payment === 'paid' && <button type="button" disabled={busy} onClick={() => void change({ paymentStatus: 'refunded' })}>Ghi nhận đã hoàn tiền</button>}
    </div>
    {status !== 'cancelled' && <div className="admin-form-row"><label>Phí vận chuyển cuối cùng (VND)
      <input type="number" min="0" max="1000000000" step="1" value={shippingVnd} onChange={event => setShippingVnd(event.target.value)} placeholder="Ví dụ: 50000"/>
    </label><button type="button" disabled={busy || shippingVnd === '' || !Number.isSafeInteger(Number(shippingVnd)) || Number(shippingVnd) < 0} onClick={() => void change({ shippingFinalVnd: Number(shippingVnd) })}>Lưu phí vận chuyển</button></div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
