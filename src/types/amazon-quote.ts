/** Public, server-issued purchase estimate. Never treat a client copy as checkout authority. */
export type AmazonQuoteDisplay = {
  provenance: { asin: string; sourceUrl: string; observedAt: string; permissionReference: string };
  images?: string[];
  brand?: string;
  description?: string;
  features?: string[];
  ingredients?: string;
  usage?: string;
  warnings?: string;
  specifications?: { name: string; value: string }[];
  rating?: number;
  reviewCount?: number;
  reviews?: { title?: string; body: string; rating?: number }[];
};

/** Facts observed on the requested product page for local source browsing only.
 * No checkout authority or claim of Amazon republication licensing. */
export type AmazonObservedDetails = Omit<AmazonQuoteDisplay, 'provenance'>;
export type AmazonVietnameseText = AmazonObservedDetails & { title?: string };

/** Source-backed identity for a product that did not qualify for a purchase quote. */
export type AmazonSourcePreview = {
  asin: string;
  title: string;
  sourceUrl: string;
  observedAt: string;
  priceJpy?: number;
  /** Approximate VND conversion at the current Mita policy; not a checkout quote. */
  estimatedPriceVnd?: number;
  /** Amazon's advertised date, may be a first-order promotional condition. */
  advertisedJapanDeliveryDate?: string;
  advertisedDeliveryConditional?: true;
  translated?: AmazonVietnameseText;
  observedDetails?: AmazonObservedDetails;
  deliveryText?: string;
  freeDelivery?: true;
  /** Only fields specifically permitted by the trusted Amazon source display gate. */
  display?: AmazonQuoteDisplay;
};

export type AmazonQuote = {
  quoteId: string;
  asin: string;
  name: string;
  seller: string;
  variant?: string;
  offerId?: string;
  shippingEvidence: string;
  shippingType: 'standard';
  sourceUrl: string;
  imageUrl?: string | null;
  /** Optional source-backed content; unavailable without verified display permission. */
  display?: AmazonQuoteDisplay;
  translated?: AmazonVietnameseText;
  quantity: number;
  priceJpy: number;
  priceVnd: number;
  observedAt: string;
  expiresAt: string;
  amazonDeliveryDate?: string | null;
  vietnamDeliveryDate?: string | null;
  amazonDeliveryEnd?: string | null;
  vietnamDeliveryEnd?: string | null;
  deliveryBufferDays: number;
  freeShipping: boolean;
  canOrder: boolean;
  warning?: string | null;
  fingerprint: string;
};
