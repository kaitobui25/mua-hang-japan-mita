"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useCart } from "@/context/cart";
import { formatVnd } from "@/lib/format";
import { createAmazonQuote } from "@/lib/amazon-quotes";
import type { AmazonQuote } from "@/types/amazon-quote";

const jpy = (n: number) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(n);
const date = (value: string) => {
  const d = new Date(value.length === 10 ? `${value}T12:00:00+09:00` : value);
  return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Tokyo" }).format(d);
};
const quoteDeadline = (value: string) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Tokyo'
  }).format(d) + ' JST';
};

export function AmazonQuoteView({ initialInput = "" }: { initialInput?: string }) {
  const { addQuote } = useCart();
  const [input, setInput] = useState(initialInput);
  const [quantity, setQuantity] = useState(1);
  const [quote, setQuote] = useState<AmazonQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!quote) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [quote]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading || !input.trim()) return;
    setLoading(true); setError(""); setQuote(null); setAdded(false); setConfirmed(false);
    try { const next = await createAmazonQuote(input.trim(), quantity); setNow(Date.now()); setQuote(next); }
    catch (e) { setError(e instanceof Error ? e.message : "Không thể báo giá."); }
    finally { setLoading(false); }
  }

  const expired = quote ? now >= Date.parse(quote.expiresAt) : false;
  return <section className="container amazon-quote-page">
    <nav className="breadcrumb" aria-label="Đường dẫn"><Link href="/">Trang chủ</Link><span>/</span><span>Mua hộ Amazon</span></nav>
    <div className="amazon-quote-intro"><h1>Mua hộ Amazon Nhật</h1><p>Dán link sản phẩm hoặc nhập ASIN để xem giá và ngày giao thường Amazon hiển thị.</p></div>
    <form className="amazon-quote-form" onSubmit={submit}>
      <label htmlFor="amazon-link">Link Amazon.co.jp hoặc ASIN</label>
      <div className="amazon-quote-controls"><input id="amazon-link" type="text" autoComplete="off" value={input} onChange={e => setInput(e.target.value)} maxLength={2048} placeholder="https://www.amazon.co.jp/dp/B0…" required/>
        <label htmlFor="amazon-quantity">Số lượng</label><input id="amazon-quantity" type="number" min={1} max={20} step={1} value={quantity} onChange={e=>setQuantity(Math.max(1,Math.min(20,Number(e.target.value)||1)))}/>
        <button className="button button-primary" type="submit" disabled={loading}>{loading ? "Đang tra…" : "Xem giá & ngày giao"}</button>
      </div>
      <p className="amazon-note">Chỉ hỗ trợ đơn mua một lần có giao thường miễn phí tại Nhật, không dùng Prime. Phí về Việt Nam tính riêng.</p>
    </form>
    {error && <div className="inline-alert amazon-quote-alert" role="alert">{error} <button type="button" onClick={()=>setError("")}>Đóng</button></div>}
    {quote && <article className="amazon-quote-result" aria-live="polite">
      <div className="amazon-quote-product">
        <div><span className="amazon-source">Amazon Japan</span><h2>{quote.name}</h2><p>ASIN: {quote.asin}</p>{quote.variant && <p>Phân loại: {quote.variant}</p>}<p>Người bán: {quote.seller || "Chưa xác định"}</p><a className="inline-link" href={quote.sourceUrl} target="_blank" rel="noopener noreferrer">Xem trên Amazon</a></div>
      </div>
      <dl className="amazon-quote-facts">
        <div><dt>Giá Amazon</dt><dd>{jpy(quote.priceJpy)}</dd></div>
        <div><dt>Giá Mita đã gồm phụ phí ({quote.quantity} sản phẩm)</dt><dd className="amazon-price-vnd">{formatVnd(quote.priceVnd * quote.quantity)}</dd></div>
        <div><dt>Ngày giao Amazon hiển thị</dt><dd>{quote.amazonDeliveryDate ? date(quote.amazonDeliveryDate)+(quote.amazonDeliveryEnd && quote.amazonDeliveryEnd !== quote.amazonDeliveryDate ? ` – ${date(quote.amazonDeliveryEnd)}` : "") : "Chưa xác định"}</dd></div>
        <div><dt>Dự kiến đến nhà tại Việt Nam</dt><dd>{quote.vietnamDeliveryDate ? date(quote.vietnamDeliveryDate)+(quote.vietnamDeliveryEnd && quote.vietnamDeliveryEnd !== quote.vietnamDeliveryDate ? ` – ${date(quote.vietnamDeliveryEnd)}` : "") : "Chưa xác định"}</dd></div>
        <div><dt>Cộng thêm theo cấu hình Mita</dt><dd>{quote.deliveryBufferDays} ngày lịch</dd></div>
        <div><dt>Phí vận chuyển về Việt Nam</dt><dd>Tính riêng sau, khách xác nhận trước khi thu</dd></div>
      </dl>
      <p className="amazon-note">Báo giá có hiệu lực đến {quoteDeadline(quote.expiresAt)} (thời hạn 15 phút). Ngày giao chỉ là dự kiến; không xác nhận địa điểm nhận tại Nhật.</p>
      {quote.warning && <p className="inline-alert" role="status">{quote.warning}</p>}
      {expired && <p className="inline-alert" role="alert">Báo giá đã hết hạn. Vui lòng tra lại trước khi đặt hàng.</p>}
      {quote.canOrder && !expired ? <div className="amazon-quote-actions">
        <label className="amazon-consent"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> Tôi xác nhận đúng sản phẩm, người bán, số lượng và hiểu rằng phí vận chuyển tính sau.{!quote.amazonDeliveryDate ? " Ngày giao hiện chưa xác định." : ""}</label>
        <button type="button" className="button button-primary" disabled={!confirmed || added} onClick={()=>{ addQuote(quote); setAdded(true); }}>{added ? "Đã thêm vào giỏ" : "Thêm vào giỏ hàng"}</button>
        {added && <Link href="/gio-hang" className="inline-link">Xem giỏ hàng</Link>}
      </div> : <p className="amazon-note">Chưa đủ điều kiện đặt mua. Vui lòng kiểm tra lại dữ liệu nguồn hoặc thử lại.</p>}
    </article>}
  </section>;
}
