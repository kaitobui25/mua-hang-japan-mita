"use client";

import { useEffect, useState } from "react";
import { useCart } from "@/context/cart";
import { fetchProduct } from "@/lib/catalog";
import type { CatalogProduct } from "@/types/catalog";

export function useCartProducts() {
  const { items, hydrated } = useCart();
  const [products, setProducts] = useState<Record<string, CatalogProduct>>({});
  const [failed, setFailed] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const ids = items.map(item => item.asin).join("|");
  useEffect(() => {
    if (!hydrated) return;
    if (!ids) { setProducts({}); setFailed([]); setLoading(false); return; }
    let active = true;
    setLoading(true);
    Promise.allSettled(ids.split("|").map(fetchProduct)).then(results => {
      if (!active) return;
      const next: Record<string, CatalogProduct> = {};
      const errors: string[] = [];
      results.forEach((result, index) => { if (result.status === "fulfilled") next[result.value.asin] = result.value; else errors.push(ids.split("|")[index]); });
      setProducts(next); setFailed(errors);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [ids, hydrated, retry]);
  const subtotal = items.reduce((sum, item) => sum + (products[item.asin]?.priceVnd || 0) * item.quantity, 0);
  return { products, failed, loading: !hydrated || loading, subtotal, retry: () => setRetry(value => value + 1) };
}
