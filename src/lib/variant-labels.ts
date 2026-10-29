/** Labels only. The source variant keys and values are never altered. */
export function variantLabel(key: string): string {
  const normalized = key.normalize("NFKC").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const labels: Record<string, string> = {
    size: "Kích cỡ", size_name: "Kích cỡ", sizes: "Kích cỡ",
    flavor: "Hương vị", flavour: "Hương vị", flavor_name: "Hương vị",
    flavour_name: "Hương vị", flavo_name: "Hương vị",
    color: "Màu sắc", color_name: "Màu sắc", colour_name: "Màu sắc",
    style: "Kiểu dáng", style_name: "Kiểu dáng",
    quantity: "Số lượng", quantity_name: "Số lượng",
    volume: "Dung tích", volume_name: "Dung tích",
    weight: "Khối lượng", weight_name: "Khối lượng",
    package_quantity: "Quy cách đóng gói", pattern_name: "Mẫu mã"
  };
  return labels[normalized] ?? key.replaceAll("_", " ").trim();
}
