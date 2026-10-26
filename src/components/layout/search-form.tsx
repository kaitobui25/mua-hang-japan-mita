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
    router.push(value ? `/san-pham?q=${encodeURIComponent(value)}` : "/san-pham");
  };
  return <form className={`search-form ${className}`} role="search" onSubmit={submit}>
    <label className="visually-hidden" htmlFor={`search-${className || "main"}`}>Tìm sản phẩm</label>
    <Icon name="search" size={19} />
    <input id={`search-${className || "main"}`} type="search" value={term} onChange={event => setTerm(event.target.value)} placeholder="Tìm sản phẩm, thương hiệu, ASIN..." enterKeyHint="search" />
    <button type="submit" aria-label="Tìm kiếm"><Icon name="arrow" size={19} /></button>
  </form>;
}
