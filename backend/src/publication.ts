// Strict publication uses only licensed exact-ASIN review evidence from the metrics view.
const allProductsEnabledSql = '(SELECT NOT hide_local_test_only FROM catalog_settings WHERE id=1)';
export const groupKeySql = (alias: string) => `jsonb_build_array(${alias}.category_slug,
  CASE WHEN ${alias}.variant_group_basis IN ('parent_asin','source_product_id') AND NULLIF(${alias}.variant_group_id,'') IS NOT NULL
    THEN ${alias}.variant_group_basis ELSE 'asin' END,
  CASE WHEN ${alias}.variant_group_basis IN ('parent_asin','source_product_id') AND NULLIF(${alias}.variant_group_id,'') IS NOT NULL
    THEN ${alias}.variant_group_id ELSE ${alias}.asin END)`;

// One membership relation for every public access path. Search/sort/pagination
// are deliberately applied only after category-wide group selection.
export const publicMembershipCtes = `sellable AS (
  SELECT p.*, ${groupKeySql('p')} AS publication_group
  FROM products p JOIN categories sell_category ON sell_category.slug=p.category_slug
  CROSS JOIN pricing_policy policy
  WHERE policy.id=1 AND p.admin_hidden_at IS NULL
    AND (p.rights_status='verified' OR ${allProductsEnabledSql})
    AND p.category_slug IN ('thuc-pham-bo-sung','thuc-pham-cho-be')
    AND p.sale_status='ready' AND p.availability='in_stock' AND p.price_jpy BETWEEN 1 AND 9007199254740991
    AND sell_category.shipping_estimate_vnd >= 0
    AND round(p.price_jpy * policy.fx_jpy_to_vnd * (1 + policy.service_fee_percent / 100) / 1000) * 1000
      BETWEEN 1 AND 9007199254740991
    AND (NOT policy.check_price_expiry OR (p.price_observed_at <= statement_timestamp()
      AND p.price_observed_at >= statement_timestamp() - policy.price_expiry_days * interval '1 day'))
), qualified_groups AS (
  SELECT s.category_slug, s.publication_group,
    max((am.snapshot->>'ratingsCount')::numeric) AS rating_rank_count
  FROM sellable s JOIN amazon_product_metrics am ON am.asin=s.asin
  WHERE am.qualification IN ('verified','ordinary')
    AND jsonb_typeof(am.snapshot->'ratingsCount')='number'
    AND (am.snapshot->>'ratingsCount') ~ '^[0-9]+$'
    AND (am.snapshot->>'ratingsCount')::numeric > 0
  GROUP BY s.category_slug,s.publication_group
), ranked_groups AS (
  SELECT *, row_number() OVER (PARTITION BY category_slug
    ORDER BY rating_rank_count DESC, publication_group ASC) AS publication_rank
  FROM qualified_groups
), published AS (
  SELECT s.*, g.rating_rank_count, g.publication_rank FROM sellable s
  JOIN ranked_groups g ON g.category_slug=s.category_slug AND g.publication_group=s.publication_group
  WHERE g.publication_rank <= 100
)`;
export const publicMembershipSql = (alias: string) => `${alias}.asin IN (WITH ${publicMembershipCtes} SELECT asin FROM published)`;
