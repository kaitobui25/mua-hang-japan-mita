'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminWrite } from './actions';

type Notice = {
  id: string;
  source?: 'local' | 'vps';
  orderId: string;
  eventType: 'order_placed';
  orderStatus: string;
  createdAt: string;
  acknowledgedAt: string | null;
};
type Notices = { items: Notice[]; unreadCount: number; externalPush: 'not_configured'; relayStatus?: 'disabled' | 'connected' | 'unavailable' };

export function OrderNotifications({ csrf }: { csrf: string }) {
  const [state, setState] = useState<Notices | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [desktopAllowed, setDesktopAllowed] = useState(false);
  const [canRequestDesktop, setCanRequestDesktop] = useState(false);
  const lastSeen = useRef<Record<string, bigint>>({});

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/notifications?unread=1&limit=30', {
        cache: 'no-store', credentials: 'same-origin'
      });
      if (response.status === 401) { window.location.assign('/admin/login'); return; }
      if (!response.ok) throw new Error('Không tải được thông báo đơn hàng.');
      const data = await response.json() as Notices;
      // Keep independent high-water marks: local and VPS event sequences differ.
      const arrivals = data.items.filter(item => {
        const source = item.source ?? 'local';
        const value = BigInt(source === 'vps' ? item.id.slice(4) : item.id);
        const previous = lastSeen.current[source];
        if (previous === undefined || value > previous) lastSeen.current[source] = value;
        return previous !== undefined && value > previous;
      });
      const latest = arrivals[0];
      if (latest && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('Mita Japan: Có đơn đặt hàng mới', {
          body: `Mã đơn ${latest.orderId.slice(0, 8)} · ${latest.source === 'vps' ? 'VPS' : 'local'}`
        });
      }
      setState(data);
      setError('');
    } catch {
      setError('Không tải được thông báo. Dữ liệu đơn hàng vẫn được lưu trên máy chủ.');
    }
  }, []);

  useEffect(() => {
    setCanRequestDesktop(typeof Notification !== 'undefined' && Notification.permission === 'default');
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function acknowledge(id: string) {
    setBusyId(id); setError('');
    try {
      await adminWrite(`notifications/${id}/ack`, csrf, {});
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Không xác nhận được thông báo.'); }
    finally { setBusyId(null); }
  }

  async function enableDesktopNotice() {
    if (typeof Notification === 'undefined') return;
    if (await Notification.requestPermission() === 'granted') {
      setDesktopAllowed(true);
      setCanRequestDesktop(false);
    }
  }

  return <section className="admin-panel" aria-labelledby="order-notifications-heading">
    <div className="admin-title-row">
      <h2 id="order-notifications-heading">Thông báo đơn đặt hàng mới</h2>
      <button type="button" onClick={() => void refresh()}>Làm mới</button>
    </div>
    <p role="status">
      <strong>{state?.unreadCount ?? '…'} đơn chưa xem{state?.relayStatus === 'unavailable' ? ' (chưa gồm VPS)' : ''}.</strong> Phát khi khách đặt hàng thành công;
      trạng thái thanh toán được quản lý riêng.
    </p>
    {state?.relayStatus === 'unavailable' && <p role="alert">Không kết nối được nguồn thông báo VPS. Thử tải lại hoặc kiểm tra cấu hình relay.</p>}
    {state?.relayStatus === 'disabled' && <p>Thông báo VPS chưa được cấu hình trên máy này.</p>}
    {state?.relayStatus === 'connected' && <p>Đang nhận thông báo đơn public VPS qua kết nối xác thực.</p>}
    <p>Thông báo Zalo/Facebook tự động chưa kết nối; khách vẫn nhắn trực tiếp qua các liên kết trên cửa hàng.</p>
    {canRequestDesktop && !desktopAllowed &&
      <button type="button" onClick={() => void enableDesktopNotice()}>Bật thông báo trên máy này</button>}
    {error && <p role="alert">{error}</p>}
    <ul>
      {(state?.items ?? []).map(notice => <li key={notice.id}>
        {notice.source === 'vps'
          ? <span>Đơn {notice.orderId.slice(0, 8)} (VPS · xem chi tiết qua Admin VPS SSH)</span>
          : <Link href={`/admin/don-hang/${notice.orderId}`}>Đơn {notice.orderId.slice(0, 8)}</Link>}
        {' · '}{new Date(notice.createdAt).toLocaleString('vi-VN', { timeZone: 'Asia/Tokyo' })} JST
        {' · '}<button type="button" disabled={busyId === notice.id} onClick={() => void acknowledge(notice.id)}>
          {busyId === notice.id ? 'Đang lưu…' : 'Đã xem'}
        </button>
      </li>)}
    </ul>
    {state && state.items.length === 0 && <p>Không có đơn mới chưa xem.</p>}
  </section>;
}
