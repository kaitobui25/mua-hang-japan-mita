import type { Metadata } from "next";
import { CheckoutView } from "@/components/cart/checkout-view";

export const metadata: Metadata = { title: "Thanh toán mô phỏng" };

export default function CheckoutPage() {
  if (process.env.NEXT_PUBLIC_READ_ONLY === '1') {
    return <section className="container shopping-page"><div className="state-panel empty-cart"><h1>Chưa nhận đơn hàng.</h1><p>Website đang mở để tham khảo sản phẩm. Chức năng tạo đơn chưa hoạt động.</p></div></section>;
  }
  return <CheckoutView/>;
}
