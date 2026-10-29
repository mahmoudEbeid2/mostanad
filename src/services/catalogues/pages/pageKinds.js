import { headingsOf, toLines } from "../segmenter.js";

// What a catalogue page is, from its text layer alone (C1 "choose pages"). No AI.
// The kind only decides the default selection — a person can keep or skip any page.
//   unknown        no text layer at all and something is drawn (a scanned page): can't be read by code
//   blank          (almost) no text and nothing else on it
//   product        the segmenter found a product block on it, or the page prints a
//                  product-like name with ≥ 2 composition / dosage / specification words
//                  or a specification table
//   contents       a contents / index page (many lines ending in a page number)
//   registrations  registration numbers / certificates, no product headings
//   contact        addresses, phone numbers, e-mail
//   about          welcome / about us / mission / history
//   cover · back   the first / last page when none of the above fits
//   other          text that fits nothing above

export const KINDS = ["cover", "contents", "about", "product", "blank", "registrations", "contact", "back", "other", "unknown"];
/** Kept by default: product pages, and scanned pages code can't judge. */
export const KEPT_BY_DEFAULT = new Set(["product", "unknown"]);

export const BLANK_CHARS = 25;
const PRODUCT_WORDS = /\b(COMPOSITION|DOSAGE|DOSE|INGREDIENTS?|SPECIFICATIONS?|ASSAY|INDICATIONS?|WITHDRAWAL|ADMINISTRATION|HOW TO USE|DIRECTIONS FOR USE|GUARANTEED ANALYSIS|EACH \d|PER (?:KG|LITRE|LITER|ML|G)\b|CONTAINS PER)/gi;
const AMOUNT = /\d[\d.,\s]*\s?(mg|g|kg|ml|mL|l|L|I\.?U\.?|%|ppm|µg|mcg)\b/g;
const CONTENTS = /\b(contents|table of contents|index|product index)\b/i;
const ABOUT = /\b(about us|welcome|who we are|our (mission|vision|values|story|history|company)|company profile|since \d{4}|founded)\b/i;
const REGISTRATION = /\b(registration|registered|reg\.? ?no|licen[cs]e|certificat(e|ion)|GMP|ISO ?\d{3,5}|HACCP|approved by)\b/gi;
const CONTACT = /(@[a-z0-9-]+\.[a-z]{2,}|\b(tel|phone|fax|mobile|whatsapp)\b\.?:?|\+\d[\d\s-]{6,}|\b(contact us|address|head office|p\.?o\.? box)\b)/gi;

const count = (re, text) => (text.match(re) || []).length;

/**
 * page: { n, items } from readPdfLayout · productBlocks: product blocks the segmenter found on it
 * opts: { last, drawn } — `drawn` = the page renders something besides white (only asked for a page without text)
 * → { kind, textLength, reason }
 */
export function classifyPage(page, { productBlocks = 0, last = false, drawn = true } = {}) {
  const text = page.items.map((i) => i.s).join(" ").replace(/\s+/g, " ").trim();
  const textLength = text.length;
  if (!page.items.length) {
    return drawn ? { kind: "unknown", textLength: 0, reason: "No text — can't auto-detect (a scanned page?)" } : { kind: "blank", textLength: 0, reason: "Blank page — nothing printed" };
  }
  if (textLength < BLANK_CHARS) return { kind: "blank", textLength, reason: `Almost no text (${textLength} characters)` };

  const lines = toLines(page.items);
  const headings = [...new Set(lines.flatMap((l) => headingsOf(l.t)))];
  const words = [...new Set((text.match(PRODUCT_WORDS) || []).map((w) => w.toUpperCase().replace(/\s+\d.*/, "")))];
  const amounts = count(AMOUNT, text);
  if (productBlocks) return { kind: "product", textLength, reason: `Product page — ${productBlocks > 1 ? `${productBlocks} products, ` : ""}${listOf(headings.length ? headings : words)} found in the text` };
  // a spec table: ≥ 4 rows that end in an amount or a ≤/≥ value
  const specRows = lines.filter((l) => l.t.includes("\t") && /([≤≥<>]\s*\d|\d\s*(%|mg|g|ppm|I\.?U\.?)\s*$)/.test(l.t)).length;
  if (words.length >= 2 && amounts >= 2) return { kind: "product", textLength, reason: `Product page — ${listOf(words)} and ${amounts} amounts found in the text` };
  if (specRows >= 4) return { kind: "product", textLength, reason: `Product page — a specification table (${specRows} rows)` };

  const pageRefs = lines.filter((l) => /(\.{3,}|\t|\s)\d{1,3}$/.test(l.t.trim())).length;
  if (CONTENTS.test(text) && pageRefs >= 3) return { kind: "contents", textLength, reason: `Contents — ${pageRefs} lines ending in a page number` };
  const regs = count(REGISTRATION, text);
  if (regs >= 3) return { kind: "registrations", textLength, reason: `Registrations / certificates — no product headings` };
  const contacts = count(CONTACT, text);
  if (last) return { kind: "back", textLength, reason: contacts ? "Back cover — contact details, no products" : "Back cover — no products" };
  if (page.n === 1) return { kind: "cover", textLength, reason: "Cover — no product headings" };
  if (contacts >= 3) return { kind: "contact", textLength, reason: "Contact page — addresses, phone numbers, e-mail" };
  if (ABOUT.test(text)) return { kind: "about", textLength, reason: "About the company — no product headings" };
  return { kind: "other", textLength, reason: "No product headings or amounts found" };
}

function listOf(words) {
  const w = words.slice(0, 3).map((x) => x.charAt(0) + x.slice(1).toLowerCase());
  if (!w.length) return "product headings";
  return w.length === 1 ? w[0] : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
}

/** The default selection for a set of classified pages: the pages kept by default (never empty while there are pages). */
export const autoSelection = (pages) => {
  const kept = pages.filter((p) => KEPT_BY_DEFAULT.has(p.kind)).map((p) => p.number);
  return kept.length ? kept : pages.map((p) => p.number);
};
