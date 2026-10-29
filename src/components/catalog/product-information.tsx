import { Icon } from "@/components/ui/icons";
import type { CatalogProduct } from "@/types/catalog";

type ProductDetailData = NonNullable<CatalogProduct["detail"]>;
type SectionIcon = "check" | "leaf" | "clock" | "shield";

const SECTIONS: ReadonlyArray<{
  field: "features" | "ingredients" | "usage" | "cautions";
  heading: string;
  icon: SectionIcon;
}> = [
  { field: "features", heading: "Đặc điểm nổi bật", icon: "check" },
  { field: "ingredients", heading: "Thành phần", icon: "leaf" },
  { field: "usage", heading: "Cách sử dụng", icon: "clock" },
  { field: "cautions", heading: "Lưu ý", icon: "shield" },
];

/** Only explicit source labels (e.g. "Khối lượng: ...") are emphasized. */
function SourceText({ value }: { value: string }) {
  const label = /^([^\r\n:：]{1,48})([:：])(?=\s)([\s\S]*)$/.exec(value);
  if (!label) return <>{value}</>;
  return <><strong>{label[1]}</strong>{label[2]}{label[3]}</>;
}

function BulletList({ items }: { items: string[] }) {
  return <ul className="detail-info-list">
    {items.map((text, index) => <li key={index}><SourceText value={text}/></li>)}
  </ul>;
}

function DetailTextSection({
  field, heading, icon, items,
}: { field: string; heading: string; icon: SectionIcon; items: string[] }) {
  if (!items.length) return null;

  // Keep cautions visible regardless of length. Every other source string remains
  // available in the DOM through an accessible native disclosure when long.
  const lengthy = field !== "cautions" && (items.length > 4 || items.some(text => text.length > 480) || items.join("").length > 850);
  const previewCount = lengthy && items[0]?.length <= 480 ? Math.min(2, items.length - 1) : lengthy ? 0 : items.length;
  const hiddenCount = items.length - previewCount;

  return <section className={`detail-info-card${field === "cautions" ? " detail-info-cautions" : ""}`} aria-labelledby={`detail-${field}-title`}>
    <div className="detail-info-heading">
      <span className="detail-info-icon"><Icon name={icon} size={18}/></span>
      <h3 id={`detail-${field}-title`}>{heading}</h3>
    </div>
    {previewCount > 0 && <BulletList items={items.slice(0, previewCount)}/>}
    {lengthy && <details className="detail-info-disclosure">
      <summary>
        <span>{previewCount ? `Xem thêm ${hiddenCount} mục` : "Xem nội dung đầy đủ"}</span>
        <Icon name="chevron" size={18}/>
      </summary>
      <BulletList items={items.slice(previewCount)}/>
    </details>}
  </section>;
}

function Description({ value }: { value: string }) {
  // A blank line is a paragraph break; no source words, numbers or punctuation
  // are changed. Single line breaks remain visible through white-space: pre-wrap.
  const paragraphs = value.split(/\r?\n[ \t]*\r?\n/);
  const long = value.length > 850;
  const content = <div className="detail-info-paragraphs">
    {paragraphs.map((text, index) => <p key={index}><SourceText value={text}/></p>)}
  </div>;

  return <section className="detail-info-card detail-info-intro" aria-labelledby="detail-description-title">
    <div className="detail-info-heading"><h3 id="detail-description-title">Mô tả</h3></div>
    {long ? <details className="detail-info-disclosure">
      <summary><span>Xem mô tả đầy đủ</span><Icon name="chevron" size={18}/></summary>
      {content}
    </details> : content}
  </section>;
}

export function ProductInformation({
  description, detail, titleExtras,
}: { description?: string | null; detail?: ProductDetailData | null; titleExtras?: string[] }) {
  const sections = SECTIONS.map(section => ({ ...section, items: detail?.[section.field] ?? [] }))
    .filter(section => section.items.length > 0);
  const specifications = Object.entries(detail?.specs ?? {});
  if (!description && sections.length === 0 && specifications.length === 0 && !titleExtras?.length) return null;

  return <section className="container detail-description" aria-labelledby="detail-information-title">
    <div className="detail-description-title"><h2 id="detail-information-title">Thông tin sản phẩm</h2></div>
    <div className="detail-sections">
      {description && <Description value={description}/>}
      {sections.map(({ field, heading, icon, items }) => <DetailTextSection
        key={field} field={field} heading={heading} icon={icon} items={items}
      />)}
      {specifications.length > 0 && <section className="detail-info-card" aria-labelledby="detail-specs-title">
        <div className="detail-info-heading">
          <span className="detail-info-icon"><Icon name="grid" size={18}/></span>
          <h3 id="detail-specs-title">Thông số</h3>
        </div>
        <dl className="detail-specifications">
          {specifications.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
        </dl>
      </section>}
      {!!titleExtras?.length && <section className="detail-info-card detail-title-extras" aria-labelledby="title-extra-heading">
        <div className="detail-info-heading"><h3 id="title-extra-heading">Thông tin bổ sung từ tên gốc</h3></div>
        <ul>{titleExtras.map((fact, index) => <li key={index}>{fact}</li>)}</ul>
      </section>}
    </div>
  </section>;
}
