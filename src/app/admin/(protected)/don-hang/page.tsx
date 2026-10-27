import { adminRead } from '@/lib/admin-server';
import type { AdminOrder, PageResult } from '@/types/admin';
import { OrderTable, Pagination } from '@/components/admin/shared';

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q : '';
  const page = typeof params.page === 'string' ? params.page : '1';
  const data = await adminRead<PageResult<AdminOrder>>(`orders?${new URLSearchParams({ q, page })}`);
  return <><header><h1>Đơn hàng mô phỏng</h1><p>Chỉ xem. Chưa thu tiền, chưa mua hàng trên Amazon.</p></header><section className="admin-panel"><form method="get" className="admin-form-row"><label>Mã đơn hoặc số điện thoại<input name="q" defaultValue={q} maxLength={200}/></label><button>Tìm đơn</button></form><OrderTable items={data.items}/><Pagination path="/admin/don-hang" {...data} filters={{ q }}/></section></>;
}
