"use client";

import Link from "next/link";
import { useCart } from "@/context/cart";
import { useCartProducts } from "@/components/cart/use-cart-products";
import { QuantitySelector } from "@/components/cart/quantity-selector";
import { ProductImage } from "@/components/ui/product-image";
import { Icon } from "@/components/ui/icons";
import { canCheckout, formatVnd, productStatus } from "@/lib/format";

export function CartView() {
  const { items, count, remove, setQuantity } = useCart();
  const { products, failed, loading, subtotal, retry } = useCartProducts();
  const blocked = items.some(item => !products[item.asin] || !canCheckout(products[item.asin]));
  const readOnly = process.env.NEXT_PUBLIC_READ_ONLY === '1';

  return <section className="container shopping-page">
    <nav className="breadcrumb" aria-label="Đường dẫn"><Link href="/">Trang chủ</Link><span>/</span><span>Giỏ hàng</span></nav>
    <div className="shopping-heading"><div><h1>Giỏ hàng.</h1></div>{count > 0 && <span className="cart-heading-count">{count} sản phẩm</span>}</div>
    {loading ? <div className="shopping-loading" aria-live="polite">Đang kiểm tra giá và tình trạng sản phẩm...</div>
      : !items.length ? <div className="state-panel empty-cart"><Icon name="bag" size={40}/><h2>Giỏ hàng đang trống</h2><p>Khám phá những sản phẩm phù hợp với gia đình bạn.</p><Link href="/san-pham" className="button button-primary">Khám phá sản phẩm <Icon name="arrow"/></Link></div>
      : <div className="shopping-grid"><div className="cart-items"><div className="cart-section-heading"><h2>Sản phẩm đã chọn</h2><button type="button" className="text-button" onClick={retry}>Cập nhật thông tin <Icon name="arrow" size={16}/></button></div>
          {items.map(item => { const product = products[item.asin]; return <article className="cart-row" key={item.asin}>
            <Link href={`/san-pham/${item.asin}`} className="cart-item-image" aria-label={`Xem sản phẩm ${item.asin}`}><ProductImage src={product?.imageUrl} name={product?.name || item.asin}/></Link>
            <div className="cart-item-info"><span className="product-brand">{product?.brand || "Sản phẩm Nhật"}</span><h3><Link href={`/san-pham/${item.asin}`}>{product?.name || `ASIN ${item.asin}`}</Link></h3><span className="cart-item-asin">{item.asin}</span>
              {product ? <p className={canCheckout(product) ? "status-good" : "status-warning"}>{productStatus(product)}</p> : <p className="status-warning">Chưa tải được dữ liệu sản phẩm.</p>}
              <div className="cart-item-controls"><QuantitySelector value={item.quantity} onChange={value => setQuantity(item.asin, value)}/><button type="button" className="remove-button" onClick={() => remove(item.asin)}>Xóa</button></div></div>
            <div className="cart-line-price">{product?.priceVnd ? formatVnd(product.priceVnd * item.quantity) : "Chờ giá"}</div>
          </article>; })}
          {failed.length > 0 && <div className="inline-alert" role="alert">Không tải được {failed.length} sản phẩm. <button type="button" onClick={retry}>Thử lại</button></div>}
          <Link href="/san-pham" className="back-to-shopping"><Icon name="arrow-left" size={17}/> Tiếp tục khám phá</Link>
        </div>
        <aside className="order-summary"><h2>Tóm tắt giỏ hàng</h2><div className="summary-row"><span>Tiền hàng tham khảo ({count})</span><strong>{formatVnd(subtotal)}</strong></div><div className="summary-row"><span>Vận chuyển từ Nhật về Việt Nam</span><span>Thu sau</span></div><div className="summary-total"><span>Tiền hàng dự kiến</span><strong>{formatVnd(subtotal)}</strong></div><p>Giá sẽ được kiểm tra và tính lại trên máy chủ khi tạo đơn. Phí vận chuyển hiển thị riêng ở bước sau.</p>
          {blocked && <div className="inline-alert" role="status">Có sản phẩm chưa đủ điều kiện thanh toán hoặc giá đã quá 24 giờ. Hãy thử cập nhật lại sau.</div>}
          {readOnly ? <p className="inline-alert" role="status">Website hiện chỉ để xem sản phẩm. Chưa nhận đơn hàng.</p> : blocked ? <button className="button button-primary checkout-button" disabled>Chưa thể thanh toán <Icon name="arrow"/></button> : <Link className="button button-primary checkout-button" href="/thanh-toan">Tiếp tục thanh toán <Icon name="arrow"/></Link>}
          <span className="simulation-caption">{readOnly ? 'Chưa nhận thanh toán hoặc thông tin giao hàng.' : 'Thanh toán chỉ là mô phỏng, không thu tiền thật.'}</span>
        </aside>
      </div>}
  </section>;
}
