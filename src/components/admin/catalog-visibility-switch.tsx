'use client';
import { useState } from 'react';
import type { CatalogSettings } from '@/types/admin';
import { adminWrite } from './actions';

export function CatalogVisibilitySwitch({ initial, csrf }: { initial: CatalogSettings; csrf: string }) {
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function change(hideLocalTestOnly: boolean) {
    if (!hideLocalTestOnly && !window.confirm('OFF sẽ đưa sản phẩm local_test_only lên website công khai, kể cả sản phẩm Amazon chưa xác minh quyền ảnh và nội dung. Tiếp tục?')) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await adminWrite<CatalogSettings>('catalog-settings', csrf, { version: saved.version, hideLocalTestOnly }, 'PUT');
      setSaved(next);
      setMessage(hideLocalTestOnly ? 'Đã ẩn sản phẩm local_test_only khỏi website.' : 'Đã cho phép hiển thị sản phẩm local_test_only trên website.');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="admin-panel admin-pricing">
    <h2>Hiển thị sản phẩm Amazon</h2>
    <div className="admin-switch-row">
      <div><strong>Ẩn sản phẩm local_test_only</strong><p>OFF (mặc định): hiện sản phẩm Amazon đã quét trên website VPS. ON: chỉ hiện sản phẩm verified. Sản phẩm bị ẩn riêng bởi Admin vẫn không xuất hiện.</p></div>
      <label className="admin-switch-label" htmlFor="hide-local-test-only">
        <input id="hide-local-test-only" type="checkbox" role="switch" checked={saved.hideLocalTestOnly} disabled={busy} onChange={e => void change(e.target.checked)}/>
        <span>{saved.hideLocalTestOnly ? 'ON' : 'OFF'}</span>
      </label>
    </div>
    <p className="admin-notice">Thiết lập được lưu ngay vào PostgreSQL VPS; không cần deploy lại khi đổi switch. OFF không xác nhận quyền sử dụng hình ảnh/nội dung Amazon. Admin và thanh toán public vẫn đóng.</p>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
