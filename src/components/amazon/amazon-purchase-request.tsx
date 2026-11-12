"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Customer } from "@/types/catalog";
import { AmazonQuoteApiError, submitAmazonPurchaseRequest, type AmazonPurchaseReceipt } from "@/lib/amazon-quotes";
import { Icon } from "@/components/ui/icons";
import { QuantitySelector } from "@/components/cart/quantity-selector";

type Attempt = { checkoutKey: string; customer: Customer; quantity: number };

/** An actual contact request; there is no locked price, charge, or shipping promise. */
export function AmazonPurchaseRequest({ requestId, expiresAt }: { requestId: string; expiresAt: string }) {
  const [open, setOpen] = useState(false);
  const [customer, setCustomer] = useState<Customer>({ name: "", phone: "", email: "", address: "" });
  const [accepted, setAccepted] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<AmazonPurchaseReceipt | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (open) formRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !accepted) return;
    if (!attempt.current && Date.now() >= Date.parse(expiresAt)) {
      setError("Thông tin Amazon đã quá 15 phút. Vui lòng tra lại link để tạo yêu cầu mới.");
      return;
    }
    if (!attempt.current) {
      attempt.current = { checkoutKey: crypto.randomUUID(), quantity, customer: {
        name: customer.name.trim(), phone: customer.phone.trim(),
        email: customer.email?.trim() || undefined, address: customer.address.trim(),
      } };
    }
    setBusy(true);
    setError("");
    try {
      setReceipt(await submitAmazonPurchaseRequest(requestId, attempt.current.checkoutKey, attempt.current.customer, attempt.current.quantity));
      attempt.current = null;
    } catch (cause) {
      if (cause instanceof AmazonQuoteApiError) {
        // Definite server rejection: no order was committed for this attempt.
        if (cause.code !== "request_already_submitted") attempt.current = null;
        setError(cause.message);
      } else {
        // Network failure may happen after commit. Retain original key + data.
        setError("Chưa rõ máy chủ đã lưu yêu cầu chưa. Bấm kiểm tra kết quả để gửi lại cùng mã, không tạo yêu cầu trùng.");
      }
    } finally { setBusy(false); }
  }

  if (receipt) return <section className="amazon-purchase-request-success" role="status">
    <h2>Đã tiếp nhận yêu cầu mua hộ</h2>
    <p>Mã yêu cầu: <strong>{receipt.orderId}</strong></p>
    <p>Mita sẽ liên hệ xác nhận sản phẩm, giá và toàn bộ phí trước khi tiến hành mua. Chưa phát sinh thanh toán hoặc cam kết mua hàng.</p>
  </section>;

  return <div className="amazon-purchase-request">
    <div className="quantity-field"><span>Số lượng</span>
      <QuantitySelector value={quantity} onChange={value => { if (!attempt.current && !busy) setQuantity(value); }}/>
    </div>
    <button type="button" className="button button-primary detail-cta" onClick={() => setOpen(value => !value)}
      aria-expanded={open} aria-controls="amazon-purchase-request-form">
      <Icon name="bag"/>Yêu cầu đặt mua<Icon name="arrow"/>
    </button>
    <p className="detail-notice">Giá hiển thị chỉ tham khảo. Mita xác nhận giá, tồn kho và phí trước khi mua; chưa thu tiền.</p>
    {open && <form ref={formRef} id="amazon-purchase-request-form" className="checkout-form amazon-purchase-request-form" onSubmit={submit}>
      <h2>Thông tin yêu cầu mua hộ</h2>
      <p>Chưa thu tiền. Giá hàng, phí vận chuyển nội địa Nhật và về Việt Nam đều cần Mita xác nhận.</p>
      <div className="form-fields">
        <label className="field"><span>Họ và tên *</span>
          <input name="name" required autoComplete="name" maxLength={120} value={customer.name}
            onChange={event => setCustomer(value => ({ ...value, name: event.target.value }))}/>
        </label>
        <label className="field"><span>Số điện thoại *</span>
          <input name="phone" type="tel" required autoComplete="tel" inputMode="tel" minLength={8} maxLength={20}
            value={customer.phone} onChange={event => setCustomer(value => ({ ...value, phone: event.target.value }))}/>
        </label>
        <label className="field span-full"><span>Email (không bắt buộc)</span>
          <input name="email" type="email" autoComplete="email" maxLength={254} value={customer.email || ""}
            onChange={event => setCustomer(value => ({ ...value, email: event.target.value }))}/>
        </label>
        <label className="field span-full"><span>Địa chỉ nhận tại Việt Nam *</span>
          <textarea name="address" required autoComplete="street-address" rows={3} maxLength={500}
            value={customer.address} onChange={event => setCustomer(value => ({ ...value, address: event.target.value }))}/>
        </label>
      </div>
      <label className="amazon-consent"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)}/>
        <span>Tôi đồng ý gửi yêu cầu để Mita liên hệ báo giá. Tôi hiểu chưa xác minh giá mua, người bán, tồn kho, phí vận chuyển và chưa phát sinh thanh toán.</span>
      </label>
      {error && <p className="inline-alert" role="alert">{error}</p>}
      <button type="submit" className="button button-primary detail-cta" disabled={!accepted || busy}>
        {busy ? "Đang kiểm tra yêu cầu…" : attempt.current ? "Kiểm tra kết quả đã gửi" : "Gửi yêu cầu đặt mua"}
      </button>
    </form>}
  </div>;
}
