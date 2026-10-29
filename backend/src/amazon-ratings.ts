// Parse only the observed Amazon Customer Reviews format. Counts are ratings,
// never evidence of written reviews or current-year Top100 eligibility.
// Use the same SQL for display and ordering, before pagination/variant grouping.
export const specRatingsSql = `(SELECT CASE
  WHEN parts[1] = parts[2] AND parts[1]::numeric BETWEEN 0 AND 5
    AND replace(parts[3], ',', '')::numeric <= 9007199254740991
  THEN jsonb_build_object('averageStars', parts[1]::numeric,
    'ratingsCount', replace(parts[3], ',', '')::bigint)
  ELSE NULL END
  FROM regexp_match(d.specs->>'Customer Reviews',
    '^([0-5][.][0-9]) +([0-5][.][0-9]) out of 5 stars [(]([0-9]{1,16}|[0-9]{1,3}(,[0-9]{3}){1,5})[)]$') AS parts)`;

export const ratingsOrderingSql = `COALESCE(
  (SELECT (am.snapshot->>'ratingsCount')::bigint FROM amazon_product_metrics am WHERE am.asin=products.asin),
  (SELECT (${specRatingsSql}->>'ratingsCount')::bigint FROM product_details d WHERE d.asin=products.asin)
) DESC NULLS LAST`;
