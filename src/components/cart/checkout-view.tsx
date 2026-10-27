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
    setSubmitting(true); setError("");
    try {
      const result = await submitCheckout(items.map(({ asin, quantity }) => ({ asin, quantity })), {
        name: customer.name.trim(), phone: customer.phone.trim(),
        ...(customer.email?.trim() ? { email: customer.email.trim() } : {}), address: customer.address.trim(),
      });
      setReceipt(result);
      clear();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Không thể tạo đơn. Vui lòng thử lại."); }
    finally { setSubmitting(false); }
  }

  if (receipt) return <section className="container receipt-page" aria-live="polite"><div className="receipt-icon"><Icon name="check" size={36}/></div><h1>Cảm ơn bạn đã thử đặt hàng.</h1><p className="lead">Máy chủ đã lưu yêu cầu mô phỏng của bạn. Chưa có giao dịch thanh toán hay đơn mua hàng thật.</p><div className="receipt-summary"><div><span>Mã đơn mô phỏng</span><strong className="receipt-order-id">{receipt.orderId}</strong></div><div><span>Tiền hàng</span><strong>{formatVnd(receipt.subtotalVnd)}</strong></div><div><span>Phí vận chuyển dự tính (thu sau)</span><strong>{formatVnd(receipt.shippingEstimatedVnd)}</strong></div><div className="receipt-total"><span>Số tiền hàng mô phỏng lúc tạo đơn</span><strong>{formatVnd(receipt.payableNowVnd)}</strong></div><p>Trạng thái: Đã tạo đơn mô phỏng. Đây không phải xác nhận đã thanh toán.</p></div><Link href="/san-pham" className="button button-primary">Tiếp tục khám phá <Icon name="arrow"/></Link></section>;

  return <section className="container shopping-page checkout-page"><nav className="breadcrumb" aria-label="Đường dẫn"><Link href="/">Trang chủ</Link><span>/</span><Link href="/gio-hang">Giỏ hàng</Link><span>/</span><span>Thanh toán</span></nav><div className="shopping-heading"><div><h1>Thanh toán mô phỏng.</h1></div></div>
    <div className="simulation-banner"><Icon name="shield" size={22}/><div><strong>Phiên bản thử nghiệm</strong><p>Việc tạo đơn bên dưới chỉ ghi nhận dữ liệu mô phỏng. Không thu tiền thật, không mua hàng trên Amazon.</p></div></div>
    {loading ? <div className="shopping-loading">Đang kiểm tra thông tin sản phẩm và giá...</div> : !items.length ? <div className="state-panel empty-cart"><h2>Chưa có sản phẩm để thanh toán</h2><p>Bạn cần thêm sản phẩm vào giỏ trước khi tiếp tục.</p><Link href="/san-pham" className="button button-primary">Xem sản phẩm <Icon name="arrow"/></Link></div> : <div className="shopping-grid"><form id="checkout-form" className="checkout-form" onSubmit={submit}>
      <div className="form-title"><span className="form-step">01</span><div><h2>Thông tin người nhận</h2><p>Không cần tạo tài khoản. Các trường có dấu * là bắt buộc.</p></div></div>
      <div className="form-fields"><label className="field"><span>Họ và tên *</span><input required name="name" autoComplete="name" maxLength={120} placeholder="Nguyễn Văn A" value={customer.name} onChange={event => setCustomer(value => ({ ...value, name: event.target.value }))}/></label><label className="field"><span>Số điện thoại *</span><input required name="phone" type="tel" inputMode="tel" autoComplete="tel" minLength={8} maxLength={20} pattern={String.raw`\+?[0-9.\(\)\s\-]{8,20}`} title="Nhập 8–20 ký tự: chữ số, dấu cách, dấu + ở đầu, dấu chấm, ngoặc hoặc gạch nối" placeholder="Ví dụ: 0912345678" value={customer.phone} onChange={event => setCustomer(value => ({ ...value, phone: event.target.value }))}/><small>8–20 ký tự, chỉ gồm số và ký hiệu điện thoại thông dụng.</small></label><label className="field span-full"><span>Email (không bắt buộc)</span><input name="email" type="email" autoComplete="email" maxLength={254} placeholder="email@example.com" value={customer.email} onChange={event => setCustomer(value => ({ ...value, email: event.target.value }))}/></label><label className="field span-full"><span>Địa chỉ nhận hàng tại Việt Nam *</span><textarea required name="address" autoComplete="street-address" rows={4} maxLength={500} placeholder="Số nhà, đường, phường/xã, quận/huyện, tỉnh/thành phố" value={customer.address} onChange={event => setCustomer(value => ({ ...value, address: event.target.value }))}/></label></div>
      <div className="checkout-flow-note"><div><span className="form-step">02</span><h2>Kiểm tra và tạo đơn</h2></div><p>Tiền hàng được tính lại theo dữ liệu mới nhất. Vận chuyển từ Nhật đến Việt Nam được dự tính trước và tính phí cuối cùng ở giai đoạn sau. Đây chỉ là quy trình mô phỏng.</p></div>
      {error && <div className="inline-alert" role="alert">{error}</div>}
      {blocked && <div className="inline-alert" role="alert">{failed.length ? `Không thể kiểm tra ${failed.length} sản phẩm.` : "Một số sản phẩm chưa đủ điều kiện thanh toán hoặc giá đã quá 24 giờ."} <button type="button" onClick={retry}>Kiểm tra lại</button> hoặc <Link href="/gio-hang">sửa giỏ hàng</Link>.</div>}
      <button type="submit" className="button button-primary checkout-submit" disabled={blocked || submitting}>{submitting ? "Đang tạo đơn..." : "Tạo đơn mô phỏng"}<Icon name="arrow"/></button><p className="form-assurance">Bạn chưa bị tính phí. Chỉ khi máy chủ trả mã đơn, giao diện mới ghi nhận tạo đơn mô phỏng thành công.</p>
    </form><aside className="order-summary checkout-summary"><h2>Đơn hàng của bạn</h2><span className="summary-count">{count} sản phẩm</span><div className="checkout-lines">{items.map(item => { const product = products[item.asin]; return <div key={item.asin} className="checkout-line"><ProductImage src={product?.imageUrl} name={product?.name || item.asin}/><div><strong>{product?.name || item.asin}</strong><span>Số lượng: {item.quantity}</span><span>{product?.priceVnd ? formatVnd(product.priceVnd * item.quantity) : "Chưa có giá"}</span></div></div>; })}</div><div className="summary-row"><span>Tiền hàng dự kiến</span><strong>{formatVnd(subtotal)}</strong></div><div className="summary-row"><span>Phí vận chuyển</span><span>Thu sau</span></div><div className="summary-total"><span>Dự kiến mô phỏng</span><strong>{formatVnd(subtotal)}</strong></div><p>Máy chủ chốt số tiền mô phỏng khi tạo đơn. Không có thanh toán thực.</p><Link href="/gio-hang" className="inline-link"><Icon name="arrow-left" size={16}/> Sửa giỏ hàng</Link></aside></div>}
  </section>;
}
