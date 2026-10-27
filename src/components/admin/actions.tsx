'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { categories, importState } from './shared';
import type { ImportRequest } from '@/types/admin';

export async function adminWrite<T>(path: string, csrf: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api/admin/${path}`, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.status === 401) { window.location.assign('/admin/login'); throw new Error('Phiên đã hết hạn.'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Thao tác thất bại. Vui lòng thử lại.');
  return result as T;
}
export function Logout({ csrf }: { csrf: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <div><button disabled={busy} onClick={async () => {
    setBusy(true); setError('');
    try { await adminWrite('logout', csrf); window.location.assign('/admin/login'); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }}>Đăng xuất</button>{error && <p role="alert">{error}</p>}</div>;
}
export function VisibilityButton({ asin, hidden, csrf }: { asin: string; hidden: boolean; csrf: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <><button disabled={busy} aria-label={`${hidden ? 'Hiện lại' : 'Ẩn'} ${asin}`} onClick={async () => {
    if (!hidden && !window.confirm(`Ẩn ${asin} khỏi cửa hàng? Lịch sử giá và đơn vẫn được giữ.`)) return;
    setBusy(true); setError('');
    try { await adminWrite(`products/${asin}/visibility`, csrf, { hidden: !hidden }, 'PATCH'); router.refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }}>{busy ? 'Đang lưu…' : hidden ? 'Hiện lại' : 'Ẩn'}</button>{error && <p role="alert">{error}</p>}</>;
}
export function ImportForm({ csrf }: { csrf: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setMessage(''); setError('');
    const form = new FormData(e.currentTarget);
    try {
      const result = await adminWrite<{ existingProduct?: { asin: string; admin_hidden_at: string | null }; request?: ImportRequest; duplicate?: boolean }>('imports', csrf, { input: form.get('input'), category: form.get('category') });
      if (result.existingProduct) {
        setMessage(`ASIN ${result.existingProduct.asin} đã có${result.existingProduct.admin_hidden_at ? ' và đang ẩn' : ''}. Không tạo yêu cầu mới.`);
        router.push(`/admin/san-pham?q=${result.existingProduct.asin}`);
      } else setMessage(result.duplicate ? `Yêu cầu đang có: ${importState[result.request!.state]}.` : 'Đã tiếp nhận yêu cầu. Chỉ được nhập sau khi worker xác minh thành công.');
      router.refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="admin-panel"><h2>Thêm sản phẩm từ Amazon Japan</h2><p>Nhập ASIN hoặc link sản phẩm. Yêu cầu có thể đang chờ nếu worker chưa bật.</p><form onSubmit={submit} className="admin-form-row"><label>ASIN hoặc URL HTTPS<input name="input" required maxLength={2048} placeholder="B0… hoặc https://www.amazon.co.jp/dp/…"/></label><label>Danh mục<select name="category">{categories.map(c => <option key={c.slug} value={c.slug}>{c.name}</option>)}</select></label><button disabled={busy} className="admin-primary">{busy ? 'Đang gửi…' : 'Thêm'}</button></form>{message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}</section>;
}
export function RefreshButton() {
  const router = useRouter();
  return <button onClick={() => router.refresh()}>Làm mới kết quả</button>;
}
