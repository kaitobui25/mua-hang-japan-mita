/** Public, server-issued purchase estimate. Never treat a client copy as checkout authority. */
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
