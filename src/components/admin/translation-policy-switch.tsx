'use client';
import { useState } from 'react';
import Link from 'next/link';
import type { TranslationSettings } from '@/types/admin';
import { adminWrite } from './actions';

export function TranslationPolicySwitch({ initial, csrf }: { initial: TranslationSettings; csrf: string }) {
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function change(validateTranslationSemantics: boolean) {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const next = await adminWrite<TranslationSettings>('translation-settings', csrf, {
        version: saved.version, validateTranslationSemantics
      }, 'PUT');
      setSaved(next);
      setMessage(validateTranslationSemantics ? 'Đã bật kiểm tra ngữ nghĩa bản dịch mới.' : 'Đã tắt chặn lỗi ngữ nghĩa; bản dịch dùng được vẫn hiển thị kèm log cảnh báo.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="admin-panel admin-pricing">
    <h2>Chính sách bản dịch</h2>
    <div className="admin-switch-row">
      <div><strong>Kiểm tra ngữ nghĩa bản dịch</strong>
        <p>OFF (mặc định): bản dịch còn lỗi số lượng, mã hoặc thương hiệu vẫn được hiển thị khi văn bản dùng được; lỗi được lưu vào nhật ký riêng. ON: chặn bản dịch mới có lỗi ngữ nghĩa. Nội dung không hợp lệ về cấu trúc luôn bị từ chối.</p>
        <p>Lưu ý: khi OFF, bản dịch có thể chứa liều lượng không chính xác. Cần đối chiếu nguồn tại nhật ký quản trị.</p>
        <p><Link href="/admin/nhat-ky-loi">Xem nhật ký cảnh báo bản dịch</Link></p>
      </div>
      <label className="admin-switch-label" htmlFor="validate-translation-semantics">
        <input id="validate-translation-semantics" type="checkbox" role="switch" disabled={busy}
          checked={saved.validateTranslationSemantics} onChange={event => void change(event.target.checked)}/>
        <span>{saved.validateTranslationSemantics ? 'ON' : 'OFF'}</span>
      </label>
    </div>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
