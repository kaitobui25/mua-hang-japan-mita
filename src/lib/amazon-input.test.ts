import assert from "node:assert/strict";
import { test } from "node:test";
import { amazonInputAsin } from "./amazon-input";

const asin = "B0FR4GT3R7";
const longUrl = "https://www.amazon.co.jp/Double-Sided-Generator-Phosphate-Disaster-Prevention/dp/B0FR4GT3R7?ref=dlx_21617_dg_dcl_B0FR4GT3R7_dt_mese18_8a_pi&pf_rd_r=HB06B5ZPFY6H4ZPX70NM&pf_rd_p=57d8339a-4607-4c64-ad68-003dc8df7b8a&sbo=RZvfv%2F%2FHxDF%2BO5021pAnSA%3D%3D";

test("long Amazon Japan product URL normalizes to one ASIN without tracking", () => {
  for (const input of [asin, asin.toLowerCase(), `https://www.amazon.co.jp/dp/${asin}`,
    `https://amazon.co.jp/gp/product/${asin}`, longUrl]) {
    assert.equal(amazonInputAsin(input), asin);
  }
  assert.equal(`https://www.amazon.co.jp/dp/${amazonInputAsin(longUrl)}`,
    `https://www.amazon.co.jp/dp/${asin}`);
});

test("unapproved links and ambiguous product paths are rejected", () => {
  for (const input of ["", "not an ASIN", `http://amazon.co.jp/dp/${asin}`,
    `https://amazon.co.jp.evil.test/dp/${asin}`, `https://evil@amazon.co.jp/dp/${asin}`,
    `https://amazon.co.jp:444/dp/${asin}`, "https://amzn.to/example",
    "https://amzn.asia/example", `https://amazon.co.jp/s?k=${asin}`,
    `https://amazon.co.jp/dp/${asin}extra`, "https://amazon.co.jp/",
    "a".repeat(2049)]) assert.equal(amazonInputAsin(input), null, input);
});
