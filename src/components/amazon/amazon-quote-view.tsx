"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useCart } from "@/context/cart";
import { AmazonQuoteApiError, createAmazonQuote } from "@/lib/amazon-quotes";
import { amazonInputAsin } from "@/lib/amazon-input";
import { AmazonProductDetail, AmazonSourceProductDetail } from "@/components/amazon/amazon-product-detail";
import type { AmazonQuote, AmazonSourcePreview } from "@/types/amazon-quote";

export function AmazonQuoteView({ initialInput = "" }: { initialInput?: string }) {
  const { addQuote } = useCart();
  const [input, setInput] = useState(initialInput);
  const [quantity, setQuantity] = useState(1);
  const [quote, setQuote] = useState<AmazonQuote | null>(null);
  const [preview, setPreview] = useState<AmazonSourcePreview | null>(null);
  const [recognizedAsin, setRecognizedAsin] = useState<string | null>(null);
  const [retryAfterAt, setRetryAfterAt] = useState<string | null>(null);
  const [sourcePaused, setSourcePaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const requestSequence = useRef(0);
  const lastAutomaticInput = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const loadQuote = useCallback(async (value: string, count: number) => {
    if (!value.trim()) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError("");
    setQuote(null);
    setPreview(null);
    setRetryAfterAt(null);
    setSourcePaused(false);
    setConfirmed(false);
    setAdded(false);
    const asin = amazonInputAsin(value);
    setRecognizedAsin(asin);
    if (!asin) {
      setError("Hãy nhập ASIN 10 ký tự hoặc link HTTPS sản phẩm Amazon.co.jp hợp lệ. Chưa hỗ trợ link rút gọn.");
      setLoading(false);
      return;
    }
    try {
      const next = await createAmazonQuote(asin, count);
      if (sequence !== requestSequence.current) return;

      setNow(Date.now());
      setQuote(next);
    } catch (cause) {
      if (sequence === requestSequence.current) {
        setError(cause instanceof Error ? cause.message : "Không thể báo giá.");
        if (cause instanceof AmazonQuoteApiError) {
          if (cause.preview?.asin === asin) setPreview(cause.preview);
          setRetryAfterAt(cause.retryAfterAt);
          setSourcePaused(["amazon_cooldown", "amazon_blocked", "amazon_rate_limited"].includes(cause.code ?? ""));
        }
      }
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

  useEffect(() => {
    if (loading || (!quote && !preview && !recognizedAsin) || !window.matchMedia("(max-width: 760px)").matches) return;
    // Results follow the form and otherwise fall below the mobile viewport.
    resultRef.current?.focus({ preventScroll: true });
    resultRef.current?.scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [loading, quote, preview, recognizedAsin]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loading) {
      if (window.matchMedia("(max-width: 760px)").matches) inputRef.current?.blur();
      setQuantity(1);
      void loadQuote(input, 1);
    }
  }

  function updateInput(value: string) {
    // A new input invalidates any displayed quote or in-flight response for the old ASIN.
    requestSequence.current++;
    setInput(value);
    setQuantity(1);
    setQuote(null);
    setPreview(null);
    setRecognizedAsin(null);
    setRetryAfterAt(null);
    setSourcePaused(false);
    setError("");
    setLoading(false);
    setConfirmed(false);
    setAdded(false);
  }

  const sourceAsin = quote?.asin ?? recognizedAsin;
  const expired = quote ? now >= Date.parse(quote.expiresAt) : false;
  return <section className="container amazon-quote-page">
    <nav className="breadcrumb detail-breadcrumb" aria-label="Đường dẫn"><Link href="/">Trang chủ</Link><span>/</span><span>Mua hộ Amazon</span>{sourceAsin && <><span>/</span><span>{sourceAsin}</span></>}</nav>
    <div className={quote || preview ? "amazon-quote-intro amazon-quote-intro--result" : "amazon-quote-intro"}>
      {!quote && !preview && <h1>Mua hộ Amazon Nhật</h1>}
      {(quote || preview) && <p className="amazon-source">Mua hộ Amazon Nhật</p>}
      {!quote && !preview && <p>Dán link Amazon.co.jp hoặc nhập ASIN để xem thông tin, giá bán và ngày giao dự kiến.</p>}
    </div>
    <form className={preview ? "amazon-quote-form amazon-quote-form--result" : "amazon-quote-form"} onSubmit={submit} role="search">
      <label htmlFor="amazon-link">Link sản phẩm Amazon.co.jp hoặc ASIN</label>
      <div className="amazon-quote-controls">
        <input ref={inputRef} id="amazon-link" type="search" autoComplete="off" value={input} onChange={event => updateInput(event.target.value)} maxLength={2048} placeholder="https://www.amazon.co.jp/dp/B0…" enterKeyHint="search" aria-invalid={Boolean(error && !recognizedAsin)} aria-describedby={error && !recognizedAsin ? "amazon-input-error" : undefined} required/>
        <button className="button button-primary" type="submit" disabled={loading}>{loading ? "Đang tra thông tin…" : "Xem thông tin sản phẩm"}</button>
      </div>
      {error && !recognizedAsin && <p id="amazon-input-error" className="inline-alert amazon-quote-alert" role="alert">{error}</p>}
      {!preview && <p className="amazon-note">Thông tin hiển thị theo trang Amazon tại thời điểm tra cứu. Giá đặt mua qua Mita và phí vận chuyển về Việt Nam được báo riêng.</p>}
    </form>
    <div ref={resultRef} className="amazon-quote-feedback" tabIndex={-1}>
    {preview && <AmazonSourceProductDetail preview={preview}/>}
    {recognizedAsin && !quote && !preview && !loading && <section className="amazon-source-preview" role="status" aria-label="Đã nhận diện ASIN, chưa xác minh sản phẩm">
      <p className="amazon-source">Đã nhận diện ASIN</p>
      <h2>ASIN: {recognizedAsin}</h2>
      {error && <p role="alert">{error}</p>}
      <p>Chưa xác minh được thông tin sản phẩm và điều kiện mua từ Amazon. Chưa thể thêm vào giỏ.</p>
      <a href={`https://www.amazon.co.jp/dp/${recognizedAsin}`} target="_blank" rel="noopener noreferrer" className="button button-outline">Xem sản phẩm gốc trên Amazon</a>
    </section>}
    {sourcePaused && recognizedAsin && <p className="amazon-retry-note" role="status">
      {retryAfterAt ? <>Mốc sớm nhất được phép xét lại: <time dateTime={retryAfterAt}>{new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(new Date(retryAfterAt))} JST</time>.</> : "Mốc được phép xét lại: chưa xác định."}
      {" "}Mốc này không bảo đảm khôi phục truy cập Amazon. Mita không tự động tra lại khi đến giờ.
    </p>}
    {loading && <div className="detail-loading amazon-detail-loading" role="status" aria-label="Đang tra thông tin sản phẩm"><div className="product-skeleton large" aria-hidden="true"><div/><span/><span/><span/></div><div className="product-skeleton large" aria-hidden="true"><div/><span/><span/><span/></div><p>Đang lấy thông tin sản phẩm từ Amazon.</p></div>}
    {quote && <AmazonProductDetail key={quote.quoteId} quote={quote} quantity={quantity} onQuantityChange={value => { setQuantity(value); setConfirmed(false); setAdded(false); }}
      onRefresh={() => { setInput(quote.asin); void loadQuote(quote.asin, quantity); }} refreshing={loading} expired={expired}
      confirmed={confirmed} onConfirm={setConfirmed} added={added} onAdd={() => {
        const current = Date.now();
        if (!confirmed || !quote.canOrder || quantity !== quote.quantity || current >= Date.parse(quote.expiresAt)) { setNow(current); return; }
        addQuote(quote);
        setAdded(true);
      }}/>}
    </div>
    <section className="amazon-service-info" aria-labelledby="amazon-service-title">
      <h2 id="amazon-service-title">Cách mua hộ từ Amazon.co.jp</h2>
      <ol>
        <li><strong>Nhập link hoặc mã ASIN.</strong> Dán đường dẫn sản phẩm Amazon.co.jp hoặc nhập mã ASIN gồm 10 ký tự.</li>
        <li><strong>Xem thông tin và báo giá.</strong> Kiểm tra đúng sản phẩm, giá và ngày giao dự kiến nếu có. Báo giá có hiệu lực 15 phút từ lúc tạo; hết hạn cần tra lại.</li>
        <li><strong>Xác nhận yêu cầu mua.</strong> Kiểm tra điều kiện mua trước khi thêm vào giỏ và gửi đơn. Mita xác nhận đơn; giá đặt mua và phí vận chuyển về Việt Nam được báo riêng.</li>
      </ol>
      <p>Thông tin Amazon có thể thay đổi hoặc chưa xác minh được tại thời điểm tra cứu. Mita không tự chuyển sang ASIN hoặc lựa chọn hàng khác khi bạn nhập link mua hộ.</p>
      <Link href="/cach-mua-hang" className="inline-link">Xem hướng dẫn mua hàng</Link>
    </section>
  </section>;
}
