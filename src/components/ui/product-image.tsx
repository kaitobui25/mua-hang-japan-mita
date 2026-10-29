"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/icons";

export function ProductImage({ src, name, className = "", priority = false }: { src?: string | null; name: string; className?: string; priority?: boolean }) {
  const [error, setError] = useState(false);
  let validImage = false;
  try { validImage = Boolean(src && /^https?:$/.test(new URL(src).protocol)); } catch { /* Empty or invalid source. */ }
  return <div className={`product-image ${className}`}>
    {validImage && !error ? <img src={src!} alt={name} loading={priority ? "eager" : "lazy"} fetchPriority={priority ? "high" : "auto"} onError={() => setError(true)} />
      : <div className="image-placeholder" role="img" aria-label={`Chưa có ảnh cho ${name}`}><Icon name="leaf" size={32} /><span>mita japan</span></div>}
  </div>;
}
