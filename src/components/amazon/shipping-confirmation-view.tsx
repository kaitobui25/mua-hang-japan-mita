'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { formatVnd } from '@/lib/format';

type Proposal = { orderId: string; shippingProposedVnd: number | null; shippingFinalVnd: number | null; confirmedAt: string | null };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const tokenPattern = /^[a-f0-9]{64}$/;

async function shippingApi<T>(id: string, action: 'shipping' | 'shipping/confirm', payload: object): Promise<T> {
  const response = await fetch(`/api/amazon/orders/${encodeURIComponent(id)}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), cache: 'no-store'
  });
  if (!response.ok) throw new Error(response.status === 409
    ? 'Mã không đúng, đơn đã hủy hoặc phí đã thay đổi. Hãy liên hệ Mita để kiểm tra.'
    : 'Không thể kiểm tra phí vận chuyển. Vui lòng thử lại.');
  return response.json() as Promise<T>;
}

export function ShippingConfirmationView() {
  const [id, setId] = useState('');
  const [token, setToken] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setProposal(null); setAccepted(false);
    if (!uuid.test(id.trim()) || !tokenPattern.test(token.trim())) { setError('Mã đơn hàng hoặc mã xác nhận không hợp lệ.'); return; }
    setBusy(true);
    try { setProposal(await shippingApi<Proposal>(id.trim(), 'shipping', { token: token.trim() })); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!proposal || proposal.shippingProposedVnd === null || proposal.shippingFinalVnd !== null || !accepted || busy) return;
    setBusy(true); setError('');
    try {
      const result = await shippingApi<{ shippingFinalVnd: number }>(id.trim(), 'shipping/confirm',
        { token: token.trim(), shippingVnd: proposal.shippingProposedVnd });
      setProposal({ ...proposal, shippingFinalVnd: result.shippingFinalVnd, confirmedAt: new Date().toISOString() });
      setAccepted(false);
    } catch (cause) { setError((cause as Error).message); setProposal(null); }
    finally { setBusy(false); }
  }

  return <section className="container shopping-page shipping-confirmation-page">
    <nav className="breadcrumb" aria-label="Đường dẫn"><Link href="/">Trang chủ</Link><span>/</span><span>Xác nhận phí vận chuyển</span></nav>
    <h1>Xác nhận phí vận chuyển về Việt Nam</h1>
    <p>Mita tính phí vận chuyển sau khi tiếp nhận đơn. Bạn chỉ xác nhận sau khi kiểm tra số tiền Mita đề xuất.</p>
    <form className="checkout-form" onSubmit={lookup}>
      <label className="field"><span>Mã đơn hàng</span><input required autoComplete="off" value={id} onChange={e => { setId(e.target.value); setProposal(null); }} placeholder="Mã đơn trên biên nhận"/></label>
      <label className="field"><span>Mã xác nhận phí vận chuyển</span><input required type="password" autoComplete="off" value={token} onChange={e => { setToken(e.target.value); setProposal(null); }} placeholder="Mã riêng nhận khi đặt hàng"/></label>
      <button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Đang kiểm tra…' : 'Kiểm tra phí vận chuyển'}</button>
    </form>
    {error && <p className="inline-alert" role="alert">{error}</p>}
    {proposal && <section className="state-panel" aria-live="polite">
      <h2>Phí vận chuyển của đơn hàng</h2>
      {proposal.shippingFinalVnd !== null ? <p>Đã xác nhận: <strong>{formatVnd(proposal.shippingFinalVnd)}</strong>. Mita sẽ liên hệ về bước thanh toán.</p>
        : proposal.shippingProposedVnd === null ? <p>Mita chưa đề xuất phí vận chuyển. Vui lòng kiểm tra lại sau khi được thông báo.</p>
        : <><p>Phí Mita đề xuất: <strong>{formatVnd(proposal.shippingProposedVnd)}</strong>.</p>
          <p>Đây là phí vận chuyển về Việt Nam, tách biệt với tiền hàng đã chốt. Không tự động thu tiền khi xác nhận.</p>
          <label className="amazon-consent"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)}/> Tôi đồng ý mức phí vận chuyển nêu trên.</label>
          <button type="button" className="button button-primary" disabled={!accepted || busy} onClick={() => void confirm()}>Xác nhận mức phí này</button></>}
    </section>}
  </section>;
}
