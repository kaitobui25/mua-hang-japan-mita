"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useCart } from "@/context/cart";
import { useCartProducts } from "@/components/cart/use-cart-products";
import { Icon } from "@/components/ui/icons";
import { ProductImage } from "@/components/ui/product-image";
import { canCheckout, formatVnd } from "@/lib/format";
import { submitCheckout } from "@/lib/catalog";
import type { CheckoutResponse, Customer } from "@/types/catalog";

export function CheckoutView() {
  const { items, count, clear } = useCart();
  const { products, failed, loading, subtotal, retry } = useCartProducts();
  const [customer, setCustomer] = useState<Customer>({ name: "", phone: "", email: "", address: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<CheckoutResponse | null>(null);
  const blocked = items.some(item => !products[item.asin] || !canCheckout(products[item.asin]));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || blocked || !items.length) return;
    setSubmitting(true);
    setError("");
    try {
      const result = await submitCheckout(items.map(({ asin, quantity }) => ({ asin, quantity })), {
        name: customer.name.trim(),
        phone: customer.phone.trim(),
        ...(customer.email?.trim() ? { email: customer.email.trim() } : {}),
        address: customer.address.trim(),
      });
      setReceipt(result);
      clear();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể gửi đơn hàng. Vui lòng thử lại.");
    } finally {
      setSubmitting(false);
    }
  }

  if (receipt) {
    return <section className="container receipt-page" aria-live="polite">
      <div className="receipt-icon"><Icon name="check" size={36}/></div>
      <h1>Đã tiếp nhận đơn hàng</h1>
      <p className="lead">Mita Japan sẽ kiểm tra và liên hệ xác nhận trước khi bạn thanh toán.</p>
      <div className="receipt-summary">
        <div><span>Mã đơn hàng</span><strong className="receipt-order-id">{receipt.orderId}</strong></div>
        <div><span>Tiền hàng đã chốt</span><strong>{formatVnd(receipt.subtotalVnd)}</strong></div>
        <div><span>Phí vận chuyển dự tính (tính riêng)</span><strong>{formatVnd(receipt.shippingEstimatedVnd)}</strong></div>
        <div className="receipt-total"><span>Thanh toán ngay</span><strong>{formatVnd(receipt.payableNowVnd)}</strong></div>
        <p>Chưa thu tiền. Vui lòng chờ nhân viên xác nhận đơn và hướng dẫn thanh toán.</p>
      </div>
      <Link href="/san-pham" className="button button-primary">Tiếp tục mua sắm <Icon name="arrow"/></Link>
    </section>;
  }

  return <section className="container shopping-page checkout-page">
    <nav className="breadcrumb" aria-label="Đường dẫn"><Link href="/">Trang chủ</Link><span>/</span><Link href="/gio-hang">Giỏ hàng</Link><span>/</span><span>Đặt hàng</span></nav>
    <div className="shopping-heading"><div><h1>Thông tin đặt hàng</h1></div></div>
    {loading ? <div className="shopping-loading">Đang kiểm tra giỏ hàng...</div>
      : !items.length ? <div className="state-panel empty-cart"><h2>Giỏ hàng đang trống</h2><Link href="/san-pham" className="button button-primary">Xem sản phẩm <Icon name="arrow"/></Link></div>
      : <div className="shopping-grid">
        <form id="checkout-form" className="checkout-form" onSubmit={submit}>
          <div className="form-title"><div><h2>Thông tin người nhận</h2><p>Vui lòng điền thông tin để cửa hàng liên hệ xác nhận.</p></div></div>
          <div className="form-fields">
            <label className="field"><span>Họ và tên *</span>
              <input required name="name" autoComplete="name" maxLength={120} value={customer.name} onChange={event => setCustomer(value => ({ ...value, name: event.target.value }))}/>
            </label>
            <label className="field"><span>Số điện thoại *</span>
              <input required name="phone" type="tel" inputMode="tel" autoComplete="tel" minLength={8} maxLength={20} pattern={String.raw`\+?[0-9.\(\)\s\-]{8,20}`} value={customer.phone} onChange={event => setCustomer(value => ({ ...value, phone: event.target.value }))}/>
            </label>
            <label className="field span-full"><span>Email (không bắt buộc)</span>
              <input name="email" type="email" autoComplete="email" maxLength={254} value={customer.email} onChange={event => setCustomer(value => ({ ...value, email: event.target.value }))}/>
            </label>
            <label className="field span-full"><span>Địa chỉ nhận hàng tại Việt Nam *</span>
              <textarea required name="address" autoComplete="street-address" rows={4} maxLength={500} value={customer.address} onChange={event => setCustomer(value => ({ ...value, address: event.target.value }))}/>
            </label>
          </div>
          <div className="checkout-flow-note"><h2>Xác nhận đơn hàng</h2><p>Giá tiền hàng được chốt khi gửi đơn. Phí vận chuyển được tính riêng. Cửa hàng liên hệ xác nhận trước khi thanh toán.</p></div>
          {error && <div className="inline-alert" role="alert">{error}</div>}
          {blocked && <div className="inline-alert" role="alert">
            {failed.length ? "Không thể kiểm tra một số sản phẩm." : "Có sản phẩm chưa đủ điều kiện đặt hàng."}{" "}
            <button type="button" onClick={retry}>Kiểm tra lại</button>
          </div>}
          <button type="submit" className="button button-primary checkout-submit" disabled={blocked || submitting}>
            {submitting ? "Đang gửi đơn..." : "Đặt hàng"} <Icon name="arrow"/>
          </button>
          <p className="form-assurance">Không cần thanh toán ngay. Nhân viên sẽ liên hệ để xác nhận đơn.</p>
        </form>
        <aside className="order-summary checkout-summary">
          <h2>Đơn hàng của bạn</h2><span className="summary-count">{count} sản phẩm</span>
          <div className="checkout-lines">{items.map(item => {
            const product = products[item.asin];
            return <div key={item.asin} className="checkout-line">
              <ProductImage src={product?.imageUrl} name={product?.name || item.asin}/>
              <div><strong>{product?.name || item.asin}</strong><span>Số lượng: {item.quantity}</span><span>{product?.priceVnd ? formatVnd(product.priceVnd * item.quantity) : "Chưa có giá"}</span></div>
            </div>;
          })}</div>
          <div className="summary-row"><span>Tiền hàng</span><strong>{formatVnd(subtotal)}</strong></div>
          <div className="summary-row"><span>Phí vận chuyển</span><span>Tính riêng</span></div>
          <div className="summary-total"><span>Tiền hàng dự kiến</span><strong>{formatVnd(subtotal)}</strong></div>
          <p>Giá tiền hàng sẽ được chốt tại thời điểm gửi đơn.</p>
          <Link href="/gio-hang" className="inline-link"><Icon name="arrow-left" size={16}/> Sửa giỏ hàng</Link>
        </aside>
      </div>}
  </section>;
}
