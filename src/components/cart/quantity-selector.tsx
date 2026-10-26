"use client";

import { Icon } from "@/components/ui/icons";

export function QuantitySelector({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return <div className="quantity-selector"><button type="button" disabled={value <= 1} onClick={() => onChange(value - 1)} aria-label="Giảm số lượng"><Icon name="minus" size={17}/></button><output aria-label={`Số lượng ${value}`}>{value}</output><button type="button" disabled={value >= 20} onClick={() => onChange(value + 1)} aria-label="Tăng số lượng"><Icon name="plus" size={17}/></button></div>;
}
