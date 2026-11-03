"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useCart } from "@/context/cart";
import { createAmazonQuote } from "@/lib/amazon-quotes";
import { AmazonProductDetail } from "@/components/amazon/amazon-product-detail";
import type { AmazonQuote } from "@/types/amazon-quote";

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
  const requestSequence = useRef(0);
  const lastAutomaticInput = useRef("");

  const loadQuote = useCallback(async (value: string, count: number) => {
    if (!value.trim()) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError("");
    setQuote(null);
    setConfirmed(false);
    setAdded(false);
    try {
      const next = await createAmazonQuote(value.trim(), count);
      if (sequence !== requestSequence.current) return;
      setNow(Date.now());
      setQuote(next);
    } catch (cause) {
      if (sequence === requestSequence.current) setError(cause instanceof Error ? cause.message : "Không thể báo giá.");
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);

  // A link pasted into the homepage search starts the quote automatically.
  // StrictMode's extra effect pass must not send two Amazon requests.
  useEffect(() => {
    const initial = initialInput.trim();
    if (!initial || initial === lastAutomaticInput.current) return;
    lastAutomaticInput.current = initial;
    setInput(initial);
    setQuantity(1);
    void loadQuote(initial, 1);
  }, [initialInput, loadQuote]);

  useEffect(() => {
    if (!quote) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [quote]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loading) void loadQuote(input, quantity);
  }

  const expired = quote ? now >= Date.parse(quote.expiresAt) : false;
  return <section className="container amazon-quote-page">
    <nav className="breadcrumb detail-breadcrumb" aria-label="Đường dẫn"><Link href="/">Trang chủ</Link><span>/</span><span>Mua hộ Amazon</span>{quote && <><span>/</span><span>{quote.asin}</span></>}</nav>
    <div className="amazon-quote-intro">
      {!quote && <h1>Mua hộ Amazon Nhật</h1>}
      {quote && <p className="amazon-source">Mua hộ Amazon Nhật</p>}
      <p>Dán link Amazon.co.jp hoặc nhập ASIN để xem thông tin, giá bán và ngày giao dự kiến.</p>
    </div>
    <form className="amazon-quote-form" onSubmit={submit} role="search">
      <label htmlFor="amazon-link">Link sản phẩm Amazon.co.jp hoặc ASIN</label>
      <div className="amazon-quote-controls">
        <input id="amazon-link" type="search" autoComplete="off" value={input} onChange={event => setInput(event.target.value)} maxLength={2048} placeholder="https://www.amazon.co.jp/dp/B0…" enterKeyHint="search" required/>
        <button className="button button-primary" type="submit" disabled={loading}>{loading ? "Đang tra thông tin…" : "Xem thông tin sản phẩm"}</button>
      </div>
      <p className="amazon-note">Chỉ nhận mua một lần, giao thường miễn phí tại Nhật, không Prime. Phí vận chuyển về Việt Nam tính riêng sau.</p>
    </form>
    {error && <div className="inline-alert amazon-quote-alert" role="alert">{error} <button type="button" onClick={() => setError("")}>Đóng</button></div>}
    {loading && <div className="detail-loading amazon-detail-loading" role="status" aria-label="Đang tra thông tin sản phẩm"><div className="product-skeleton large"><div/><span/><span/><span/></div><div className="product-skeleton large"><div/><span/><span/><span/></div></div>}
    {quote && <AmazonProductDetail key={quote.quoteId} quote={quote} quantity={quantity} onQuantityChange={value => { setQuantity(value); setConfirmed(false); }}
      onRefresh={() => { setInput(quote.asin); void loadQuote(quote.asin, quantity); }} refreshing={loading} expired={expired}
      confirmed={confirmed} onConfirm={setConfirmed} added={added} onAdd={() => {
        const current = Date.now();
        if (current >= Date.parse(quote.expiresAt)) { setNow(current); return; }
        addQuote(quote);
        setAdded(true);
      }}/>}
  </section>;
}
