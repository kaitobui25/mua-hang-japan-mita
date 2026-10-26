"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { CartItem } from "@/types/catalog";

const STORAGE_KEY = "mita-japan-cart-v1";

type CartContextValue = {
  items: CartItem[];
  hydrated: boolean;
  count: number;
  add: (asin: string, quantity?: number) => void;
  setQuantity: (asin: string, quantity: number) => void;
  remove: (asin: string) => void;
  clear: () => void;
};

const CartContext = createContext<CartContextValue | null>(null);

function sanitizedItems(value: unknown): CartItem[] {
  if (!Array.isArray(value)) return [];
  const merged = new Map<string, number>();
  for (const item of value) {
    if (typeof item !== "object" || !item || typeof item.asin !== "string" || !/^[A-Z0-9]{10}$/i.test(item.asin)) continue;
    if (!Number.isInteger(item.quantity) || item.quantity < 1) continue;
    merged.set(item.asin.toUpperCase(), Math.min(20, (merged.get(item.asin.toUpperCase()) || 0) + item.quantity));
  }
  return [...merged].map(([asin, quantity]) => ({ asin, quantity }));
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try { setItems(sanitizedItems(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"))); } catch { /* Corrupt local storage starts with an empty cart. */ }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch { /* Private mode may block storage. */ }
    }
  }, [items, hydrated]);

  const add = (asin: string, quantity = 1) => setItems(current => {
    const next = [...current];
    const index = next.findIndex(item => item.asin === asin);
    if (index < 0) next.push({ asin, quantity: Math.max(1, Math.min(20, quantity)) });
    else next[index] = { ...next[index], quantity: Math.min(20, next[index].quantity + quantity) };
    return next;
  });
  const setQuantity = (asin: string, quantity: number) => setItems(current => current.map(item => item.asin === asin ? { ...item, quantity: Math.min(20, Math.max(1, Math.floor(quantity))) } : item));
  const remove = (asin: string) => setItems(current => current.filter(item => item.asin !== asin));
  const clear = () => setItems([]);
  return <CartContext.Provider value={{ items, hydrated, count: items.reduce((sum, item) => sum + item.quantity, 0), add, setQuantity, remove, clear }}>{children}</CartContext.Provider>;
}

export function useCart() {
  const context = useContext(CartContext);
  if (!context) throw new Error("useCart must be used within CartProvider");
  return context;
}
