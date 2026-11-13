"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useCart } from "@/context/cart";
import { AmazonQuoteApiError, createAmazonQuote, createAmazonBrowserPreview } from "@/lib/amazon-quotes";
import { amazonInputAsin } from "@/lib/amazon-input";
import { AMAZON_CAPTURE_MAX_LENGTH, amazonCaptureBookmarklet, parseAmazonBrowserCapture } from "@/lib/amazon-browser-capture";
import { AmazonProductDetail, AmazonSourceProductDetail } from "@/components/amazon/amazon-product-detail";
import type { AmazonQuote, AmazonSourcePreview } from "@/types/amazon-quote";

export function AmazonQuoteView({ initialInput = "" }: { initialInput?: string }) {
  const { addQuote } = useCart();
  const [input, setInput] = useState(initialInput);
  const [quantity, setQuantity] = useState(1);
  const [quote, setQuote] = useState<AmazonQuote | null>(null);
  const [preview, setPreview] = useState<AmazonSourcePreview | null>(null);
  const [purchaseRequest, setPurchaseRequest] = useState<{ id: string; expiresAt: string } | null>(null);
  const [recognizedAsin, setRecognizedAsin] = useState<string | null>(null);
  const [retryAfterAt, setRetryAfterAt] = useState<string | null>(null);
  const [sourcePaused, setSourcePaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [captureInput, setCaptureInput] = useState("");
  const [captureError, setCaptureError] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [translateToVietnamese, setTranslateToVietnamese] = useState(false);
  const [bookmarkCopied, setBookmarkCopied] = useState(false);
  const bookmarkRef = useRef<HTMLAnchorElement>(null);
  const requestSequence = useRef(0);
  const lastAutomaticInput = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const loadBrowserCapture = useCallback(async (json: string, asin: string, translate: boolean) => {
    const sequence = ++requestSequence.current;
    setRecognizedAsin(asin);
    setInput(`https://www.amazon.co.jp/dp/${asin}`);
    try {
      const captured = parseAmazonBrowserCapture(json, asin);
      setInput(captured.page.url);
      setRecognizedAsin(asin);
      setQuote(null);
      setPreview(null);
      setPurchaseRequest(null);
      setSourcePaused(false);
      setRetryAfterAt(null);
      setCaptureError("");
      setError("");
      setCapturing(true);
      const result = await createAmazonBrowserPreview({ ...captured, translateToVietnamese: translate });
      if (sequence !== requestSequence.current) return;
      setPreview(result.preview);
      setPurchaseRequest(result.purchaseRequest);
      setCaptureInput("");
    } catch (cause) {
      if (sequence === requestSequence.current) setCaptureError(cause instanceof Error ? cause.message : "Không thể nhận dữ liệu sản phẩm.");
    } finally {
      if (sequence === requestSequence.current) setCapturing(false);
    }
  }, []);

  const loadQuote = useCallback(async (value: string, count: number) => {
    if (!value.trim()) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError("");
    setQuote(null);
    setPreview(null);
    setPurchaseRequest(null);
    setRetryAfterAt(null);
    setSourcePaused(false);
    setConfirmed(false);
    setAdded(false);
    setCaptureInput("");
    setCaptureError("");
    setCapturing(false);
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
          if (cause.preview?.asin === asin) {
            setPreview(cause.preview);
            if (cause.requestId && cause.requestExpiresAt) setPurchaseRequest({ id: cause.requestId, expiresAt: cause.requestExpiresAt });
          }
          setRetryAfterAt(cause.retryAfterAt);
          setSourcePaused(["amazon_cooldown", "amazon_blocked", "amazon_rate_limited"].includes(cause.code ?? ""));
        }
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // React rejects javascript: URLs in JSX. This user-invoked bookmark reads
    // only the product page and is intended to be dragged to the bookmarks bar.
    bookmarkRef.current?.setAttribute("href", amazonCaptureBookmarklet(window.location.origin + "/mua-ho-amazon"));
  }, [recognizedAsin, loading, quote]);

  // Product links default to the user's browser. No background request to Amazon.
  useEffect(() => {
    const initial = initialInput.trim();
    if (!initial || initial === lastAutomaticInput.current) return;
    lastAutomaticInput.current = initial;
    setInput(initial);
    setQuantity(1);
    setRecognizedAsin(amazonInputAsin(initial));
  }, [initialInput]);

  // A user-triggered bookmarklet may open this page with a one-time fragment.
  // Fragments are not transmitted to the web server; remove before processing.
  useEffect(() => {
    const prefix = "#browser_capture=";
    if (!window.location.hash.startsWith(prefix)) return;
    const encoded = window.location.hash.slice(prefix.length);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    if (encoded.length > 24000) { setError("Dữ liệu trình duyệt quá dài."); return; }
    try {
      const json = decodeURIComponent(encoded);
      const raw: unknown = JSON.parse(json);
      const page = raw && typeof raw === "object" && "page" in raw ? raw.page : null;
      const asin = page && typeof page === "object" && "url" in page && typeof page.url === "string"
        ? amazonInputAsin(page.url) : null;
      if (!asin) throw new Error("Dữ liệu không có đường dẫn Amazon.co.jp hợp lệ.");
      parseAmazonBrowserCapture(json, asin);
      setRecognizedAsin(asin);
      setInput(`https://www.amazon.co.jp/dp/${asin}`);
      setCaptureInput(json);
      setCaptureError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Dữ liệu trình duyệt không hợp lệ."); }
  }, []);

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
      const asin = amazonInputAsin(input);
      updateInput(input);
      if (asin) setRecognizedAsin(asin);
      else setError("Hãy nhập ASIN 10 ký tự hoặc link HTTPS Amazon.co.jp hợp lệ.");
    }
  }

  function updateInput(value: string) {
    // A new input invalidates any displayed quote or in-flight response for the old ASIN.
    requestSequence.current++;
    setInput(value);
    setQuantity(1);
    setQuote(null);
    setPreview(null);
    setPurchaseRequest(null);
    setRecognizedAsin(null);
    setRetryAfterAt(null);
    setSourcePaused(false);
    setError("");
    setLoading(false);
    setConfirmed(false);
    setAdded(false);
    setCaptureInput("");
    setCaptureError("");
    setCapturing(false);
  }

  const sourceAsin = quote?.asin ?? recognizedAsin;
  const expired = quote ? now >= Date.parse(quote.expiresAt) : false;
  const showingProduct = Boolean(quote || preview);
  const searchForm = <form className="amazon-quote-form" onSubmit={submit} role="search">
    <label htmlFor="amazon-link">Link sản phẩm Amazon.co.jp hoặc ASIN</label>
    <div className="amazon-quote-controls">
      <input ref={inputRef} id="amazon-link" type="search" autoComplete="off" value={input} onChange={event => updateInput(event.target.value)} maxLength={2048}
        placeholder="https://www.amazon.co.jp/dp/B0…" enterKeyHint="search" aria-invalid={Boolean(error && !recognizedAsin)}
        aria-describedby={error && !recognizedAsin ? "amazon-input-error" : undefined} required/>
      <button className="button button-primary" type="submit" disabled={loading}>Tiếp tục bằng trình duyệt của tôi</button>
    </div>
    {error && !recognizedAsin && <p id="amazon-input-error" className="inline-alert amazon-quote-alert" role="alert">{error}</p>}
    {!showingProduct && <p className="amazon-note">Giá VND tham khảo theo chính sách Mita; giá và phí cuối cùng được xác nhận trước khi mua.</p>}
  </form>;
  return <section className="container amazon-quote-page">
    <nav className="breadcrumb detail-breadcrumb" aria-label="Đường dẫn"><Link href="/">Trang chủ</Link><span>/</span><Link href="/mua-ho-amazon">Mua hộ Amazon</Link>{sourceAsin && <><span>/</span><span>{sourceAsin}</span></>}</nav>
    {!showingProduct && <div className="amazon-quote-intro"><h1>Mua hộ Amazon Nhật</h1>
      <p>Dán link Amazon.co.jp hoặc nhập ASIN để tra sản phẩm.</p></div>}
    {searchForm}
    <div ref={resultRef} className="amazon-quote-feedback" tabIndex={-1}>
    {preview && <AmazonSourceProductDetail preview={preview} purchaseRequest={purchaseRequest}/>}
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
    {recognizedAsin && !quote && !loading && <section className="amazon-source-preview" aria-labelledby="amazon-browser-title">
      <h2 id="amazon-browser-title">Lấy thông tin bằng trình duyệt của bạn</h2>
      <p>Mở sản phẩm bằng trình duyệt của bạn, sau đó bấm dấu trang Mita để chuyển thông tin sản phẩm đang hiển thị về Mita. Không cần máy chủ Mita truy cập Amazon. Giá hiển thị chỉ là tạm tính, chưa khóa giá mua hàng.</p>
      <ol>
        <li>Kéo <a ref={bookmarkRef} onClick={event => event.preventDefault()}>Lấy thông tin cho Mita</a> lên thanh dấu trang của trình duyệt (chỉ cần làm một lần). Hoặc bấm <button type="button" className="inline-link" onClick={async () => {
          try {
            await navigator.clipboard.writeText(amazonCaptureBookmarklet(window.location.origin + "/mua-ho-amazon"));
            setBookmarkCopied(true);
            setCaptureError("");
          } catch { setCaptureError("Không thể sao chép mã tự động. Hãy kéo liên kết lên thanh dấu trang."); }
        }}>{bookmarkCopied ? "Đã sao chép mã dấu trang" : "Sao chép mã dấu trang"}</button> rồi dán mã vào URL của một dấu trang mới.</li>
        <li><a href={`https://www.amazon.co.jp/dp/${recognizedAsin}`} target="_blank" rel="noopener noreferrer">Mở sản phẩm trên Amazon ↗</a>, rồi bấm dấu trang vừa lưu khi trang sản phẩm đã tải. Nếu Amazon yêu cầu xác minh hoặc chặn truy cập, hãy dừng thao tác.</li>
        <li>Mita mở tab mới với dữ liệu sản phẩm đã chuẩn bị. Chọn có dịch hay không rồi bấm Hiển thị sản phẩm. Nếu trình duyệt chặn tab mới, dán dữ liệu đã sao chép vào ô bên dưới.</li>
      </ol>
      <form aria-busy={capturing} onSubmit={event => {
        event.preventDefault();
        if (capturing) return;
        void loadBrowserCapture(captureInput, recognizedAsin, translateToVietnamese);
      }}>
        <label htmlFor="amazon-browser-data">Dữ liệu sản phẩm từ Amazon</label>
        <textarea id="amazon-browser-data" value={captureInput} disabled={capturing} onChange={event => { setCaptureInput(event.target.value); setCaptureError(""); }}
          maxLength={AMAZON_CAPTURE_MAX_LENGTH} rows={5} required aria-invalid={Boolean(captureError)} style={{ width: "100%" }}
          aria-describedby="amazon-browser-note amazon-browser-error"/>
        <p id="amazon-browser-note">Chỉ dán dữ liệu từ dấu trang Mita. Không dán mật khẩu, cookie hoặc thông tin tài khoản.</p>
        <label className="amazon-consent"><input type="checkbox" checked={translateToVietnamese}
          onChange={event => setTranslateToVietnamese(event.target.checked)} disabled={capturing}/>
          <span>Tôi đồng ý gửi tên và mô tả sản phẩm đã chọn tới dịch vụ Google Translate để dịch sang tiếng Việt. Không bao gồm cookie, mật khẩu hay thông tin tài khoản. Nếu không chọn, Mita giữ nội dung gốc.</span>
        </label>
        <p id="amazon-browser-error" role="alert">{captureError}</p>
        <button type="submit" className="button button-outline" disabled={capturing || !captureInput.trim()}>{capturing ? "Đang tạo bản xem trước…" : translateToVietnamese ? "Hiển thị và dịch tiếng Việt" : "Hiển thị sản phẩm (không dịch)"}</button>
        {capturing && <p role="status">Đang xử lý dữ liệu bạn đã dán. Mita không truy cập Amazon trong thao tác này.</p>}
      </form>
    </section>}
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
    {!showingProduct && <section className="amazon-service-info" aria-labelledby="amazon-service-title">
      <h2 id="amazon-service-title">Cách mua hộ từ Amazon.co.jp</h2>
      <ol>
        <li><strong>Nhập link hoặc mã ASIN.</strong> Dán đường dẫn sản phẩm Amazon.co.jp hoặc nhập mã ASIN gồm 10 ký tự.</li>
        <li><strong>Xem thông tin và báo giá.</strong> Kiểm tra đúng sản phẩm, giá và ngày giao dự kiến nếu có. Báo giá có hiệu lực 15 phút từ lúc tạo; hết hạn cần tra lại.</li>
        <li><strong>Xác nhận yêu cầu mua.</strong> Kiểm tra điều kiện mua trước khi thêm vào giỏ và gửi đơn. Mita xác nhận đơn; giá đặt mua và phí vận chuyển về Việt Nam được báo riêng.</li>
      </ol>
      <p>Thông tin Amazon có thể thay đổi hoặc chưa xác minh được tại thời điểm tra cứu. Mita không tự chuyển sang ASIN hoặc lựa chọn hàng khác khi bạn nhập link mua hộ.</p>
      <Link href="/cach-mua-hang" className="inline-link">Xem hướng dẫn mua hàng</Link>
    </section>}
  </section>;
}
