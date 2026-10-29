'use client';
import { useState, type FormEvent } from 'react';
import type { Policy } from '@/types/admin';
import { adminWrite } from './actions';
import { money } from './shared';

export function PricingForm({ initial, csrf }: { initial: Policy; csrf: string }) {
  const [saved, setSaved] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [checkPriceExpiry, setCheckPriceExpiry] = useState(initial.checkPriceExpiry);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const form = new FormData(event.currentTarget);
    const next = { checkPriceExpiry, priceExpiryDays: checkPriceExpiry ? Number(form.get('expiryDays')) : saved.priceExpiryDays, fxJpyToVnd: Number(form.get('fx')), serviceFeePercent: Number(form.get('fee')), version: saved.version };
    try {
      const preview = await adminWrite<Policy>('pricing/preview', csrf, next);
      if (!window.confirm(`Kiểm tra giá quá hạn: ${saved.checkPriceExpiry ? `${saved.priceExpiryDays} ngày` : 'Tắt'} → ${next.checkPriceExpiry ? `${next.priceExpiryDays} ngày` : 'Tắt'}\nXác nhận cả hai thông số:\nTỷ giá: ${saved.fxJpyToVnd} → ${next.fxJpyToVnd} VND/JPY\nPhụ phí: ${saved.serviceFeePercent}% → ${next.serviceFeePercent}%\nGiá thử 1.000 JPY: ${money(saved.exampleVnd)} → ${money(preview.exampleVnd)}\nChỉ áp dụng catalog và đơn mới. Đơn cũ giữ nguyên.`)) return;
      const updated = await adminWrite<Policy>('pricing', csrf, next, 'PUT');
      setSaved(updated); setMessage(`Đã lưu đồng thời tỷ giá và phụ phí · phiên bản ${updated.version}.`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="admin-panel admin-pricing"><label>Tỷ giá tính giá bán (VND/JPY)<input name="fx" type="number" min="0.0001" max="10000" step="0.0001" defaultValue={initial.fxJpyToVnd} required/></label><label>Phụ phí dịch vụ (%)<input name="fee" type="number" min="0" max="100" step="0.01" defaultValue={initial.serviceFeePercent} required/></label><label><input name="checkPriceExpiry" type="checkbox" checked={checkPriceExpiry} onChange={event => setCheckPriceExpiry(event.target.checked)}/>Kiểm tra giá quá hạn</label>{checkPriceExpiry && <label>Số ngày quá hạn<input name="expiryDays" type="number" min="1" max="365" step="1" defaultValue={saved.priceExpiryDays} required/></label>}<p>Khi tắt, tuổi giá không chặn đặt hàng. Thời điểm ghi nhận giá vẫn được giữ nguyên.</p><div className="admin-notice"><p>Chính sách đang lưu · phiên bản {saved.version}</p><p>Giá thử: round(1.000 × {saved.fxJpyToVnd} × (1 + {saved.serviceFeePercent}/100) / 1.000) × 1.000 = <strong>{money(saved.exampleVnd)}</strong></p><p>Khi lưu, bạn sẽ xem và xác nhận giá thử mới.</p></div><button className="admin-primary" disabled={busy}>{busy ? 'Đang kiểm tra…' : 'Lưu thay đổi'}</button>{error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}</form>;
}
