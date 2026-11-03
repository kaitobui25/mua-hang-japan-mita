import { adminRead, type AdminSession } from '@/lib/admin-server';
import type { CatalogSettings, Policy, TranslationSettings } from '@/types/admin';
import { PricingForm } from '@/components/admin/pricing-form';
import { CatalogVisibilitySwitch } from '@/components/admin/catalog-visibility-switch';
import { TranslationPolicySwitch } from '@/components/admin/translation-policy-switch';
import { AmazonDeliverySettings } from '@/components/admin/amazon-delivery-settings';

export default async function PricingPage() {
  const [policy, settings, translation, session] = await Promise.all([adminRead<Policy>('pricing'), adminRead<CatalogSettings>('catalog-settings'), adminRead<TranslationSettings>('translation-settings'), adminRead<AdminSession>('session')]);
  const delivery = session.role === 'owner' ? await adminRead<{version:number;deliveryDays:number}>('amazon-quote-settings').catch(() => null) : null;
  return <><header><h1>Cấu hình</h1><p>Quản lý hiển thị sản phẩm, bản dịch và chính sách giá của cửa hàng.</p></header><CatalogVisibilitySwitch initial={settings} csrf={session.csrfToken}/><TranslationPolicySwitch initial={translation} csrf={session.csrfToken}/><h2>Cấu hình giá bán</h2><p>Tỷ giá và phụ phí áp dụng đồng thời cho catalog và đơn mới. Đơn đã tạo giữ nguyên snapshot.</p><PricingForm initial={policy} csrf={session.csrfToken}/>{delivery && <AmazonDeliverySettings initial={delivery} csrf={session.csrfToken}/ >}{session.role === 'owner' && !delivery && <p className="admin-notice">Cấu hình mua hộ Amazon chưa khả dụng. Cần kiểm tra migration database trước khi kích hoạt.</p>}<p>Phụ phí dịch vụ khác phí vận chuyển ước tính thu sau.</p></>;
}
