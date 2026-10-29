import { adminRead, type AdminSession } from '@/lib/admin-server';
import { OrderNotifications } from '@/components/admin/order-notifications';

export default async function NotificationsPage() {
  const session = await adminRead<AdminSession>('session');
  return <>
    <header><p className="overline">Quản trị cửa hàng</p><h1>Thông báo đơn hàng</h1></header>
    <OrderNotifications csrf={session.csrfToken}/>
  </>;
}
