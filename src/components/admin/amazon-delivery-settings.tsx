'use client';
import { useState, type FormEvent } from 'react';
import { adminWrite } from './actions';

type DeliverySettings = { version: number; deliveryDays: number };

export function AmazonDeliverySettings({ initial, csrf }: { initial: DeliverySettings; csrf: string }) {
  const [saved, setSaved] = useState(initial);
  const [days, setDays] = useState(initial.deliveryDays);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!Number.isInteger(days) || days < 0 || days > 90) { setError('Số ngày phải từ 0 đến 90.'); return; }
    if (!window.confirm(`Đổi thời gian giao dự kiến từ ${saved.deliveryDays} thành ${days} ngày lịch? Đơn đã gửi sẽ giữ nguyên mốc thời gian cũ.`)) return;
    setBusy(true); setMessage(''); setError('');
    try {
      const next = await adminWrite<DeliverySettings>('amazon-quote-settings', csrf, { version: saved.version, deliveryDays: days }, 'PUT');
      setSaved(next); setDays(next.deliveryDays); setMessage('Đã lưu. Báo giá Amazon mới sẽ dùng số ngày này.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Không thể lưu.'); }
    finally { setBusy(false); }
  }
  return <form className="admin-panel" onSubmit={submit}>
    <h2>Dự kiến giao hàng mua hộ Amazon</h2>
    <p>Số ngày lịch cộng với ngày giao thường Amazon hiển thị để ước tính đến tận nhà khách Việt Nam. Một giá trị chung cho mọi tỉnh/thành, không đổi đơn đã đặt.</p>
    <label>Số ngày cộng thêm
      <input type="number" min={0} max={90} step={1} required value={days} onChange={e=>setDays(Number(e.target.value))}/>
    </label>
    <p>Đang lưu: {saved.deliveryDays} ngày (phiên bản {saved.version}).</p>
    <button className="admin-primary" type="submit" disabled={busy || days === saved.deliveryDays}>{busy ? 'Đang lưu…' : 'Lưu số ngày vận chuyển'}</button>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </form>;
}
