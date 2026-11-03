"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Icon } from "@/components/ui/icons";

export function SearchForm({ initial = "", className = "" }: { initial?: string; className?: string }) {
  const router = useRouter();
  const [term, setTerm] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = term.trim();
    if (/^[A-Z0-9]{10}$/i.test(value) || /^(?:https?:\/\/)?(?:www\.)?amazon\.co\.jp\//i.test(value)) {
      router.push(`/mua-ho-amazon?input=${encodeURIComponent(value)}`);
    } else if (/^https?:\/\//i.test(value)) {
      router.push(`/mua-ho-amazon?input=${encodeURIComponent(value)}`);
    } else {
      router.push(value ? `/san-pham?q=${encodeURIComponent(value)}` : "/san-pham");
    }
  };
  return <form className={`search-form ${className}`} role="search" onSubmit={submit}>
    <label className="visually-hidden" htmlFor={`search-${className || "main"}`}>Tìm sản phẩm</label>
    <Icon name="search" size={19} />
    <input id={`search-${className || "main"}`} type="search" value={term} onChange={event => setTerm(event.target.value)} placeholder="Dán link Amazon JP, mã ASIN hoặc tìm sản phẩm Mita" enterKeyHint="search" maxLength={2048}/>
    <button type="submit" aria-label="Tìm kiếm hoặc tra giá Amazon">{className.includes("prominent") ? "Tra cứu" : <Icon name="arrow" size={19} />}</button>
  </form>;
}
