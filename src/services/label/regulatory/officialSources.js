// Registry of official regulatory authorities and their domains (§7.2). A fetch
// whose host isn't in `domains` for the target country is never sourceIsOfficial
// and is never stored as authoritative regulatory knowledge — this is the fix
// for G4 ("web-search fallback stores grounding output with no URL/domain check
// and caches it forever as if it were authoritative").
export const AUTHORITIES = {
  EG: { code: "EDA", name: "Egyptian Drug Authority", country: "Egypt", domains: ["edaegypt.gov.eg"] },
  SA: { code: "SFDA", name: "Saudi Food and Drug Authority", country: "Saudi Arabia", domains: ["sfda.gov.sa"] },
  AE: { code: "MOHAP", name: "UAE Ministry of Health and Prevention", country: "United Arab Emirates", domains: ["mohap.gov.ae"] },
};
