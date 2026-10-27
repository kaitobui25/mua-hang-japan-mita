export type Availability = "in_stock" | "out_of_stock" | "unknown" | "requires_verification";

export type CatalogProduct = {
  asin: string;
  name: string;
  label?: string;
  brand?: string | null;
  categorySlug: string;
  imageUrl?: string | null;
  imageUrls?: string[];
  priceJpy?: number | null;
  priceVnd?: number | null;
  priceObservedAt?: string | null;
  availability?: Availability | string;
  status?: string;
  sourceUrl?: string | null;
  description?: string | null;
  detail?: {
    features: string[];
    ingredients: string[];
    usage: string[];
    specs: Record<string, string>;
    cautions: string[];
    variantAttributes: Record<string, string>;
    sourceObservedAt?: string;
  } | null;
  variantAttributes?: Record<string, string>;
  /** Present only when an identifier was explicitly observed from the source. */
  variantGroup?: { basis: "parent_asin" | "source_product_id"; id: string } | null;
  variants?: CatalogVariant[];
};

export type CatalogVariant = CatalogProduct & { label?: string };

export type CatalogResponse = {
  items: CatalogProduct[];
  total: number;
  page: number;
  lastUpdatedAt?: string | null;
};

export type CartItem = { asin: string; quantity: number };

export type Customer = { name: string; phone: string; email?: string; address: string };

export type CheckoutResponse = {
  orderId: string;
  lines: Array<{ asin: string; quantity: number; [key: string]: unknown }>;
  subtotalVnd: number;
  shippingEstimatedVnd: number;
  payableNowVnd: number;
  status: "simulation_created";
};
