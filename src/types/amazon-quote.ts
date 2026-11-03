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
