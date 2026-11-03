import type { Metadata } from 'next';
import { ShippingConfirmationView } from '@/components/amazon/shipping-confirmation-view';

export const metadata: Metadata = { title: 'Xác nhận phí vận chuyển | Mita Japan', robots: { index: false, follow: false } };

export default function ShippingConfirmationPage() { return <ShippingConfirmationView/>; }
