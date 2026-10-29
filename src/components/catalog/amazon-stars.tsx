import type { CatalogProduct } from "@/types/catalog";

export function AmazonStars({ product }: { product: CatalogProduct }) {
  const metric = product.amazon;
  if (!metric) return null;
  const stars = metric.averageStars;
  const validStars = typeof stars === "number" && Number.isFinite(stars) && stars >= 0 && stars <= 5;
  return <div style={{ fontSize: "0.8rem", marginBlock: "0.4rem" }}>
    {validStars && <span aria-label={`${stars} trên 5 sao`} style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
      <span>{stars.toLocaleString("vi-VN")}</span>
      <span aria-hidden="true" style={{ position: "relative", display: "inline-block", color: "#b8b8b8", lineHeight: 1, whiteSpace: "nowrap" }}>
        ★★★★★<span style={{ position: "absolute", inset: 0, width: `${stars / 5 * 100}%`, overflow: "hidden", color: "#b76a00" }}>★★★★★</span>
      </span>
    </span>}
    {metric.ratingsCount !== null && <span> ({metric.ratingsCount.toLocaleString("vi-VN")} lượt đánh giá sao)</span>}
    {metric.writtenReviewCount !== null && <span> ({metric.writtenReviewCount.toLocaleString("vi-VN")} bài nhận xét)</span>}
    <small style={{ display: "block" }}>Amazon · {metric.stale ? "Dữ liệu cũ · " : ""}Quan sát: {new Date(metric.observedAt).toLocaleDateString("vi-VN", { timeZone: "Asia/Tokyo" })}</small>
  </div>;
}
