// Source URLs are never rewritten. Identity is used only to prevent duplicate
// images while preserving a previous gallery when a crawl returns partial data.
export function imageIdentity(url) {
  const filename=new URL(url).pathname.split('/').pop() ?? '';
  return filename.replace(/\._[^.]*_\.(?=[a-z]+$)/i,'.').toLowerCase();
}

export function hasExplicitSmallSize(url) {
  // A literal sub-800px source modifier disproves the required short-edge size.
  // Absence of a modifier does NOT prove an image meets the size requirement.
  const filename=new URL(url).pathname.split('/').pop() ?? '';
  const rectangular=filename.match(/(?:^|[_\.])(?:AC_)?SR(\d{1,4}),(\d{1,4})/i);
  if(rectangular && Math.min(Number(rectangular[1]),Number(rectangular[2]))<800)return true;
  const tokens=[...filename.matchAll(/(?:^|[_\.])(?:AC_)?(?:S[XYL]|US|SH|SR)(\d{1,4})(?=\D|$)/gi)];
  return tokens.some(match=>Number(match[1])<800);
}

export function selectGallery(incoming,previous) {
  if(!incoming.length)return {kind:'unchanged',rows:previous};
  const old=Math.max(0,...previous.map(row=>new Date(row.source_observed_at).getTime()));
  // A source gallery can retain old rows while appending one newly observed
  // image. The minimum incoming timestamp would discard that fresh image.
  const fresh=incoming.filter(row=>new Date(row.source_observed_at).getTime()>old);
  if(!fresh.length)return {kind:'stale',rows:previous};
  const usable=incoming.filter(row=>!hasExplicitSmallSize(row.source_url));
  // Replace positions only when *every* row belongs to the newer snapshot.
  // A mixture of old/new observations is partial, even if it has more rows.
  if(fresh.length===incoming.length&&usable.length===incoming.length&&
      usable.length>=previous.length)return {kind:'replaced',rows:incoming};
  // Missing source quality metadata prevents proving that a shorter gallery
  // is complete. Known thumbnails never replace an old source image.
  const chosen=[...previous],known=new Set(chosen.map(row=>imageIdentity(row.source_url)));
  for(const row of fresh.filter(row=>!hasExplicitSmallSize(row.source_url))) {
    const identity=imageIdentity(row.source_url);
    const match=chosen.findIndex(item=>imageIdentity(item.source_url)===identity);
    if(match>=0 && hasExplicitSmallSize(chosen[match].source_url))chosen[match]=row;
    else if(match<0 && chosen.length<5){chosen.push(row);known.add(identity);}
  }
  return {kind:chosen.length===0?'unchanged':'partial',rows:chosen};
}
