"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useCart } from "@/context/cart";
import { Icon } from "@/components/ui/icons";
import { SearchForm } from "@/components/layout/search-form";

const NAV = [
  { href: "/danh-muc/thuc-pham-bo-sung", label: "Thực phẩm bổ sung" },
  { href: "/danh-muc/thuc-pham-cho-be", label: "Thực phẩm cho bé" },
  { href: "/san-pham", label: "Tất cả sản phẩm" },
  { href: "/danh-gia", label: "Đánh giá khách hàng" },
];

export function Header() {
  const { count, hydrated } = useCart();
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => { if (searchOpen) document.querySelector<HTMLInputElement>("#desktop-search input")?.focus(); }, [searchOpen]);
  return <>
    <header className="site-header">
      <div className="container header-main">
        <button type="button" className="icon-button mobile-menu-toggle" aria-label={open ? "Đóng menu" : "Mở menu"} aria-expanded={open} aria-controls="mobile-menu" onClick={() => setOpen(value => !value)}><Icon name={open ? "x" : "menu"} size={24}/></button>
        <Link href="/" className="wordmark" aria-label="Mita Japan, về trang chủ" onClick={() => setOpen(false)}>mita<span>japan</span><span className="wordmark-mark">.</span></Link>
        <nav className="desktop-nav" aria-label="Điều hướng chính">{NAV.map(item => <Link key={item.href} href={item.href} className={pathname === item.href ? "nav-current" : ""}>{item.label}</Link>)}</nav>
        <div className="header-actions"><button className="icon-button desktop-search-toggle" type="button" aria-label={searchOpen ? "Đóng tìm kiếm" : "Mở tìm kiếm"} aria-expanded={searchOpen} aria-controls="desktop-search" onClick={() => setSearchOpen(value => !value)}><Icon name={searchOpen ? "x" : "search"} size={20}/></button><Link className="header-cart" href="/gio-hang"><Icon name="bag" size={20}/><span className="header-cart-label">Giỏ hàng</span><span className="cart-count" suppressHydrationWarning>{hydrated ? count : 0}</span></Link></div>
      </div>
      <div id="desktop-search" className={searchOpen ? "container header-search desktop-search-expanded" : "container header-search"} onKeyDown={event => { if (event.key === "Escape") setSearchOpen(false); }}><SearchForm className="global" /></div>
      {open && <nav id="mobile-menu" className="mobile-menu" aria-label="Điều hướng trên điện thoại">{NAV.map(item => <Link key={item.href} href={item.href} onClick={() => setOpen(false)}>{item.label}<Icon name="arrow" size={17}/></Link>)}</nav>}
    </header>
  </>;
}
