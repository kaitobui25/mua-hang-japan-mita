import { adminRead, type AdminSession } from '@/lib/admin-server';
import type { Policy } from '@/types/admin';
import { PricingForm } from '@/components/admin/pricing-form';

export default async function PricingPage() {
  const [policy, session] = await Promise.all([adminRead<Policy>('pricing'), adminRead<AdminSession>('session')]);
  return <><header><h1>Cấu hình giá bán</h1><p>Tỷ giá và phụ phí áp dụng đồng thời cho catalog và đơn mới. Đơn đã tạo giữ nguyên snapshot.</p></header><PricingForm initial={policy} csrf={session.csrfToken}/><p>Phụ phí dịch vụ khác phí vận chuyển ước tính thu sau. Giá nguồn quá 24 giờ vẫn bị khóa checkout.</p></>;
}
