"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { useCart } from "@/context/cart";
import { useCartProducts } from "@/components/cart/use-cart-products";
import { Icon } from "@/components/ui/icons";
import { ProductImage } from "@/components/ui/product-image";
import { canCheckout, formatVnd } from "@/lib/format";
import { CheckoutApiError, submitCheckout } from "@/lib/catalog";
import { parseAmazonQuote, refreshAmazonQuote } from "@/lib/amazon-quotes";
import type { AmazonQuote } from "@/types/amazon-quote";
import type { CartItem, CheckoutResponse, Customer } from "@/types/catalog";

type CheckoutAttempt = { id: string; items: CartItem[]; customer: Customer };
type PendingQuoteChange = { old: AmazonQuote; quote: AmazonQuote };
const displayDateRange = (start?: string | null, end?: string | null) => start ? `${start}${end && end !== start ? ` – ${end}` : ""}` : "Chưa xác định";
const yen = (value: number) => `${new Intl.NumberFormat('ja-JP').format(value)} JPY`;

function QuoteTermsReview({ change }: { change: PendingQuoteChange }) {
  const { old, quote } = change;
  const details: { label: string; oldValue: string; newValue: string }[] = [
    { label: 'ASIN', oldValue: old.asin, newValue: quote.asin },
    { label: 'Sản phẩm', oldValue: old.name, newValue: quote.name },
    { label: 'Phân loại', oldValue: old.variant || 'Không ghi rõ', newValue: quote.variant || 'Không ghi rõ' },
    { label: 'Người bán', oldValue: old.seller, newValue: quote.seller },
    { label: 'Mã chào bán', oldValue: old.offerId || 'Không ghi rõ', newValue: quote.offerId || 'Không ghi rõ' },
    { label: 'Số lượng', oldValue: String(old.quantity), newValue: String(quote.quantity) },
    { label: 'Giá Amazon', oldValue: yen(old.priceJpy), newValue: yen(quote.priceJpy) },
    { label: 'Tiền hàng Mita', oldValue: formatVnd(old.priceVnd * old.quantity), newValue: formatVnd(quote.priceVnd * quote.quantity) },
    { label: 'Phí vận chuyển nội địa Nhật', oldValue: old.freeShipping ? 'Miễn phí đã xác minh' : 'Chưa xác minh, tính riêng', newValue: quote.freeShipping ? 'Miễn phí đã xác minh' : 'Chưa xác minh, tính riêng' },
    { label: 'Giao tại Nhật', oldValue: old.shippingEvidence || 'Chưa xác minh', newValue: quote.shippingEvidence || 'Chưa xác minh' },
    { label: 'Ngày giao Amazon hiển thị', oldValue: displayDateRange(old.amazonDeliveryDate, old.amazonDeliveryEnd), newValue: displayDateRange(quote.amazonDeliveryDate, quote.amazonDeliveryEnd) },
    { label: 'Dự kiến giao tại Việt Nam', oldValue: displayDateRange(old.vietnamDeliveryDate, old.vietnamDeliveryEnd), newValue: displayDateRange(quote.vietnamDeliveryDate, quote.vietnamDeliveryEnd) },
    { label: 'Cộng thêm ngày lịch', oldValue: String(old.deliveryBufferDays), newValue: String(quote.deliveryBufferDays) },
  ];
  return <div className="amazon-refresh-review"><h3>Đối chiếu báo giá trước và sau</h3>
    <p>Chỉ đặt hàng sau khi bạn kiểm tra lại đầy đủ người bán, phân loại, giá và ngày giao. {quote.freeShipping ? 'Giao thường tại Nhật đã xác minh miễn phí.' : 'Phí vận chuyển nội địa Nhật chưa xác minh và phải được xác nhận riêng.'} Phí vận chuyển về Việt Nam cũng tính và xác nhận riêng.</p>
    <p className="amazon-refresh-scroll-hint">Vuốt ngang để xem đầy đủ các cột báo giá.</p>
    <div className="admin-table-scroll" role="region" tabIndex={0} aria-label="Bảng đối chiếu báo giá"><table><thead><tr><th>Điều khoản</th><th>Báo giá cũ</th><th>Báo giá mới</th></tr></thead><tbody>
      {details.map(detail => <tr key={detail.label}><th scope="row">{detail.label}</th><td>{detail.oldValue}</td><td><strong>{detail.newValue}</strong>{detail.oldValue !== detail.newValue ? ' (đã thay đổi)' : ''}</td></tr>)}
    </tbody></table></div>
  </div>;
}

export function CheckoutView() {
  const { items, count, clear, updateQuote } = useCart();
  const { products, failed, loading, subtotal, retry } = useCartProducts();
  const [customer, setCustomer] = useState<Customer>({ name: "", phone: "", email: "", address: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<CheckoutResponse | null>(null);
  const [pendingChange, setPendingChange] = useState<PendingQuoteChange | null>(null);
  const [notice, setNotice] = useState("");
  // Preserve the exact original payload and key until the server tells us definitively
  // whether it was committed. Never refresh quotes before replaying an uncertain submit.
  const pendingAttempt = useRef<CheckoutAttempt | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const blocked = items.some(item => item.kind === "amazon_quote" ? !item.quote?.canOrder : !products[item.asin] || !canCheckout(products[item.asin]));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || (!pendingAttempt.current && (blocked || !items.length))) return;
    setSubmitting(true);
    setError("");
    try {
      if (!pendingAttempt.current) {
        for (const item of items) {
          if (item.kind !== "amazon_quote" || !item.quote) continue;
          if (Date.now() < Date.parse(item.quote.expiresAt)) continue;
          const fresh = await refreshAmazonQuote(item.quote.quoteId, item.quantity);
          if (!fresh.canOrder) { setError("Sản phẩm Amazon hiện không đủ điều kiện mua hộ. Vui lòng kiểm tra giỏ hàng."); return; }
          if (fresh.fingerprint !== item.quote.fingerprint) {
            setPendingChange({ old: item.quote, quote: fresh });
            setNotice("Điều khoản Amazon đã thay đổi. Hãy so sánh báo giá trước khi xác nhận.");
            return;
          }
          updateQuote(item.quote.quoteId, fresh);
          setNotice("Báo giá đã được gia hạn. Vui lòng kiểm tra và bấm Đặt hàng lần nữa.");
          return;
        }
        pendingAttempt.current = {
          id: crypto.randomUUID(),
          items: items.map(item => ({ ...item, ...(item.quote ? { quote: { ...item.quote } } : {}) })),
          customer: {
            name: customer.name.trim(), phone: customer.phone.trim(),
            ...(customer.email?.trim() ? { email: customer.email.trim() } : {}),
            address: customer.address.trim(),
          },
        };
      }
      const attempt = pendingAttempt.current;
      const result = await submitCheckout(attempt.items, attempt.customer, attempt.id);
      setReceipt(result);
      pendingAttempt.current = null;
      setUncertain(false);
      clear();
    } catch (cause) {
      if (cause instanceof CheckoutApiError && cause.code === 'quote_refresh_required') {
        // A 409 is a definite non-commit. Only now may the original key be abandoned.
        const original = pendingAttempt.current;
        pendingAttempt.current = null;
        setUncertain(false);
        const details = cause.details as { quote?: unknown; previousQuoteId?: unknown } | undefined;
        try {
          const fresh = parseAmazonQuote(details?.quote);
          const stale = items.filter(item => item.kind === 'amazon_quote' && item.quote &&
            item.quote.quoteId === details?.previousQuoteId &&
            original?.items.some(line => line.quote?.quoteId === item.quote?.quoteId));
          if (stale.length === 1 && stale[0].quote) {
            setPendingChange({ old: stale[0].quote, quote: fresh });
            setNotice('Báo giá đã thay đổi trong lúc gửi đơn. Bạn phải xác nhận lại trước khi đặt hàng.');
            return;
          }
        } catch { /* Keep the cart unchanged if the replacement is invalid. */ }
      }
      if (cause instanceof CheckoutApiError) {
        // Structured server rejection cannot have committed an order, except for an
        // unexpected key conflict which requires manual reconciliation.
        if (cause.code !== 'checkout_key_conflict') { pendingAttempt.current = null; setUncertain(false); }
        setError(cause.message);
      } else if (pendingAttempt.current) {
        setUncertain(true);
        setError('Chưa rõ máy chủ đã nhận đơn hay chưa. Hãy bấm "Kiểm tra kết quả đơn đã gửi" để gửi lại cùng mã giao dịch; không tạo đơn mới.');
      } else setError(cause instanceof Error ? cause.message : "Không thể gửi đơn hàng. Vui lòng thử lại.");
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
        <div><span>Phí vận chuyển (tính riêng, xác nhận sau)</span><strong>{receipt.shippingEstimatedVnd == null ? "Chưa xác định" : formatVnd(receipt.shippingEstimatedVnd)}</strong></div>
        <div className="receipt-total"><span>Thanh toán ngay</span><strong>{formatVnd(receipt.payableNowVnd)}</strong></div>
        <p>Chưa thu tiền. Vui lòng chờ nhân viên xác nhận đơn và hướng dẫn thanh toán.</p>
        {receipt.shippingConfirmationToken && <div className="shipping-code"><p><strong>Mã xác nhận phí vận chuyển (lưu riêng, không chia sẻ công khai)</strong></p><code>{receipt.shippingConfirmationToken}</code><p>Khi Mita thông báo phí vận chuyển, dùng mã đơn và mã này để kiểm tra rồi xác nhận. Nếu mất mã, vui lòng liên hệ Mita.</p><Link className="inline-link" href="/xac-nhan-phi-van-chuyen">Kiểm tra và xác nhận phí vận chuyển</Link></div>}
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
          {notice && <div className="inline-alert" role="status">{notice}</div>}
          {pendingChange && <div className="inline-alert" role="alert"><QuoteTermsReview change={pendingChange}/>
            <button type="button" disabled={!pendingChange.quote.canOrder || Date.now() >= Date.parse(pendingChange.quote.expiresAt)} onClick={()=>{
              if (!items.some(item => item.quote?.quoteId === pendingChange.old.quoteId)) { setPendingChange(null); setError('Giỏ hàng đã thay đổi. Vui lòng tra lại báo giá.'); return; }
              updateQuote(pendingChange.old.quoteId, pendingChange.quote);
              setPendingChange(null); setNotice("Đã xác nhận điều khoản mới. Vui lòng kiểm tra rồi gửi đơn.");
              pendingAttempt.current = null; setUncertain(false);
            }}>Tôi đồng ý báo giá mới</button>{' '}
            <button type="button" onClick={() => { setPendingChange(null); setNotice('Chưa chấp nhận báo giá mới. Không đặt hàng với báo giá đã hết hạn.'); }}>Hủy xác nhận</button>
          </div>}
          {blocked && <div className="inline-alert" role="alert">
            {failed.length ? "Không thể kiểm tra một số sản phẩm." : "Có sản phẩm chưa đủ điều kiện đặt hàng."}{" "}
            <button type="button" onClick={retry}>Kiểm tra lại</button>
          </div>}
          <button type="submit" className="button button-primary checkout-submit" disabled={(!uncertain && blocked) || submitting || !!pendingChange}>
            {submitting ? "Đang gửi đơn..." : uncertain ? 'Kiểm tra kết quả đơn đã gửi' : "Đặt hàng"} <Icon name="arrow"/>
          </button>
          <p className="form-assurance">Không cần thanh toán ngay. Nhân viên sẽ liên hệ để xác nhận đơn.</p>
        </form>
        <aside className="order-summary checkout-summary">
          <h2>Đơn hàng của bạn</h2><span className="summary-count">{count} sản phẩm</span>
          <div className="checkout-lines">{items.map(item => {
            const product = products[item.asin]; const quote = item.kind === "amazon_quote" ? item.quote : undefined;
            return <div key={quote?.quoteId || item.asin} className="checkout-line">
              <ProductImage src={quote?.imageUrl || product?.imageUrl} name={quote?.name || product?.name || item.asin}/>
              <div><strong>{quote?.name || product?.name || item.asin}</strong><span>Số lượng: {item.quantity}</span><span>{quote?.priceVnd ? formatVnd(quote.priceVnd * item.quantity) : product?.priceVnd ? formatVnd(product.priceVnd * item.quantity) : "Chưa có giá"}</span>{quote && <span>{quote.amazonDeliveryDate ? `Amazon dự kiến: ${quote.amazonDeliveryDate}` : "Chưa xác định ngày giao"}</span>}</div>
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
