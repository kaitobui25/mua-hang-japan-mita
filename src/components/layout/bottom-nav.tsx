"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/icons";
import { useCart } from "@/context/cart";

const LINKS = [
  { href: "/", label: "Trang chủ", icon: "home" },
  { href: "/san-pham", label: "Tìm kiếm", icon: "search" },
  { href: "/danh-muc/thuc-pham-cho-be", label: "Danh mục", icon: "grid" },
  { href: "/gio-hang", label: "Giỏ hàng", icon: "bag" },
] as const;

export function BottomNav() {
  const pathname = usePathname();
  const { count } = useCart();
  return <nav className="bottom-nav" aria-label="Điều hướng nhanh">{LINKS.map(link => <Link key={link.href} href={link.href} aria-current={pathname === link.href ? "page" : undefined}><span className="bottom-icon"><Icon name={link.icon} size={21}/>{link.href === "/gio-hang" && count > 0 && <span className="bottom-count">{count}</span>}</span><span>{link.label}</span></Link>)}</nav>;
}
