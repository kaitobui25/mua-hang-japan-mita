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
    if (!hideLocalTestOnly && !window.confirm('OFF sẽ cho phép đặt tất cả sản phẩm có trong cơ sở dữ liệu (trừ sản phẩm ẩn riêng) khi có giá hợp lệ. Tiếp tục?')) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await adminWrite<CatalogSettings>('catalog-settings', csrf, { version: saved.version, hideLocalTestOnly }, 'PUT');
      setSaved(next);
      setMessage(hideLocalTestOnly ? 'Đã bật chế độ chỉ bán sản phẩm verified.' : 'Đã cho phép bán tất cả sản phẩm trong database đủ điều kiện vận hành.');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="admin-panel admin-pricing">
    <h2>Chính sách bán sản phẩm</h2>
    <div className="admin-switch-row">
      <div><strong>Chỉ bán sản phẩm verified</strong><p>OFF (mặc định): cho phép đặt mọi sản phẩm trong database khi có giá và còn hàng. ON: chỉ cho phép hiển thị/đặt các sản phẩm verified. Sản phẩm bị Admin ẩn riêng luôn không được bán.</p></div>
      <label className="admin-switch-label" htmlFor="hide-local-test-only">
        <input id="hide-local-test-only" type="checkbox" role="switch" checked={saved.hideLocalTestOnly} disabled={busy} onChange={e => void change(e.target.checked)}/>
        <span>{saved.hideLocalTestOnly ? 'ON' : 'OFF'}</span>
      </label>
    </div>
    <p className="admin-notice">Cấu hình được lưu ngay trong PostgreSQL. Quyền sử dụng nội dung và ảnh là vấn đề riêng, không tự động thay đổi rights_status trong dữ liệu.</p>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
