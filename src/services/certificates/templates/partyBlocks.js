// A design's party blocks (28 Nov): "EXPORTER | CONSIGNEE" (shipper / buyer / importer…) and the lines
// under each. Nothing in them is ever printed from the sample — ADDVET's HC printed its sample's
// consignee "MADHOOB TRADING GROUP" on every certificate:
//   exporter  → the company record (producer name, address, phone, email, country)
//   consignee → the shipment's invoice (customer name, address, phone, country) — asked once when no
//               invoice of the drop covers the shipment (batchAnswer), never the sample's
// An address the sample spreads over several lines is one value wrapped over those lines (wrapPiece).
// A line nothing here recognises is a blank (manual), never the sample's text.
// Pure: version lines → field rows as fieldsForAreas returns them.

const EXPORTER = /\b(?:EXPORTER|SHIPPER|SELLER|CONSIGNOR)\b/i;
const CONSIGNEE = /\b(?:CONSIGNEE|BUYER|IMPORTER|CONSIGNED\s+TO|SHIP\s+TO|BILL\s+TO|RECEIVER)\b/i;
const PHONE = /^((?:Tel|Phone|Mob(?:ile)?|T)\.?\s*[:.]?\s*)?(\+?\d[\d\s()\-]{5,}\d)\s*$/i;
const EMAIL = /(E-?mail\s*[:.]?\s*)([\w.+-]+@[\w-]+\.[\w.]+)/i;
const COUNTRY_FILLER = /\b(?:sultanate|sultante|kingdom|republic|state|states|emirates?|of|the|united|arab|islamic|people'?s|democratic|federal|hashemite)\b|[,.()]/gi;

const SOURCES = {
  exporter: { kind: "company", name: "profile.producerName", address: "address", phone: "phone", email: "profile.email", country: "profile.country" },
  consignee: { kind: "invoice", name: "customerName", address: "customerAddress", phone: "customerPhone", email: null, country: "customerCountry" },
};
const LABEL = { exporter: "Exporter", consignee: "Consignee" };

let countries = null;
/** English country names (Intl), longest first */
function countryNames() {
  if (countries) return countries;
  const dn = new Intl.DisplayNames(["en"], { type: "region" });
  const out = new Set();
  for (let a = 65; a <= 90; a++)
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = dn.of(code);
      if (name && name !== code && name.length >= 4) out.add(name);
    }
  countries = [...out].sort((x, y) => y.length - x.length);
  return countries;
}
/** a line that is only a country ("Sultante Of Oman", "Pakistan") — not an address naming one */
export function isCountryLine(text) {
  const t = String(text || "").trim();
  const hit = countryNames().find((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t));
  if (!hit) return false;
  return !t.replace(new RegExp(hit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ").replace(COUNTRY_FILLER, " ").trim();
}

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
const sameRow = (a, b) => Math.abs(a.box.y - b.box.y) <= Math.max(3, Math.min(a.box.h, b.box.h) * 0.6);

/** Where a line crossing into the next column splits: after the company's own name when it starts it, else the nearest word start */
function splitAt(line, boundaryX, companyNames) {
  const t = line.text;
  for (const n of companyNames.filter(Boolean)) {
    if (norm(t).startsWith(`${norm(n)} `)) {
      // the same characters in the printed text: count the name's letters/digits through the line
      const want = norm(n).replace(/ /g, "").length;
      let seen = 0;
      for (let i = 0; i < t.length; i++) {
        if (/[A-Za-z0-9]/.test(t[i])) seen++;
        if (seen === want) return i + 1 + (/[.,]/.test(t[i + 1] || "") ? 1 : 0);
      }
    }
  }
  const est = Math.round((boundaryX - line.box.x) / (line.box.w / Math.max(1, t.length)));
  const starts = [...t.matchAll(/(?<=\s)\S/g)].map((m) => m.index);
  if (!starts.length) return null;
  return starts.reduce((a, b) => (Math.abs(b - est) < Math.abs(a - est) ? b : a));
}

/** lines: a version's lines; ctx: { companyNames } → field rows */
export function partyFields(lines = [], ctx = {}) {
  const companyNames = (ctx.companyNames || []).filter((n) => String(n || "").trim().length >= 3);
  const usable = lines.filter((l) => l.box && l.text?.trim());
  const headers = usable.filter((l) => (EXPORTER.test(l.text) || CONSIGNEE.test(l.text)) && l.text.trim().split(/\s+/).length <= 6 && !/:\s*\S/.test(l.text));
  const fields = [];
  const used = new Set();
  const claimed = new Set();
  for (const h of headers) {
    if (claimed.has(h.id)) continue;
    const row = headers.filter((x) => x.page === h.page && sameRow(x, h)).sort((a, b) => a.box.x - b.box.x);
    row.forEach((x) => claimed.add(x.id));
    // the roles, left to right
    const roles = [];
    for (const x of row) {
      const found = [
        [EXPORTER.exec(x.text), "exporter"],
        [CONSIGNEE.exec(x.text), "consignee"],
      ]
        .filter(([m]) => m)
        .sort((a, b) => a[0].index - b[0].index);
      for (const [, role] of found) if (!roles.some((r) => r.role === role)) roles.push({ role, x: found.length === 1 ? x.box.x : null });
    }
    if (!roles.length) continue;
    // the block: the rows under the header until a wide gap (the next section)
    const hgt = h.box.h || 12;
    const below = usable.filter((l) => l.page === h.page && l.box.y > h.box.y + hgt * 0.5 && !claimed.has(l.id)).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const block = [];
    let lastY = h.box.y;
    let rows = 0;
    for (const l of below) {
      if (l.box.y - lastY > Math.max(hgt, l.box.h) * 2.6) break;
      if (EXPORTER.test(l.text) || CONSIGNEE.test(l.text)) break;
      if (l.box.y - lastY > 2) rows++;
      if (rows > 10) break;
      block.push(l);
      lastY = l.box.y;
    }
    if (!block.length) continue;
    // the columns' x: the headers' own when they are separate lines, else where the block's lines start
    let xs = roles.map((r) => r.x);
    if (xs.some((x) => x === null)) {
      const clusters = [];
      for (const l of block) {
        const c = clusters.find((k) => Math.abs(k.x - l.box.x) <= 8);
        if (c) c.n++;
        else clusters.push({ x: l.box.x, n: 1 });
      }
      const top = clusters.sort((a, b) => b.n - a.n).slice(0, roles.length).sort((a, b) => a.x - b.x);
      if (top.length !== roles.length) continue;
      xs = top.map((c) => c.x);
    }
    const colOf = (x) => xs.reduce((best, cx, i) => (x >= cx - 8 ? i : best), 0);
    // each column's pieces, top to bottom (a line crossing into the next column is split there)
    const pieces = roles.map(() => []);
    for (const l of block) {
      const ci = colOf(l.box.x);
      const next = xs[ci + 1];
      if (next !== undefined && l.box.x + l.box.w > next + 8) {
        const at = splitAt(l, next, companyNames);
        if (at && at > 0 && at < l.text.length) {
          pieces[ci].push({ line: l, s: 0, e: at });
          pieces[ci + 1].push({ line: l, s: at, e: l.text.length });
          continue;
        }
      }
      pieces[ci].push({ line: l, s: 0, e: l.text.length });
    }
    roles.forEach(({ role }, ci) => {
      const src = SOURCES[role];
      const key = (base) => {
        let k = `${role}_${base}`;
        for (let n = 2; used.has(k); n++) k = `${role}_${base}_${n}`;
        used.add(k);
        return k;
      };
      const out = [];
      const add = (p, s, e, label, base, source, required = false) => {
        const text = p.line.text.slice(s, e);
        const t = text.trim();
        if (!t) return;
        const lead = text.length - text.trimStart().length;
        out.push({ key: key(base), label: `${LABEL[role]} ${label}`, lineId: p.line.id, page: p.line.page, charStart: s + lead, charEnd: s + lead + t.length, sampleValue: t, source, required, role: `party_${role}` });
      };
      const address = [];
      pieces[ci].forEach((p, i) => {
        const text = p.line.text.slice(p.s, p.e);
        if (i === 0) return add(p, p.s, p.e, "name", "name", { kind: src.kind, path: src.name }, true);
        const ph = text.trim().match(PHONE);
        if (ph) {
          const at = p.s + text.indexOf(ph[2]);
          return add(p, at, at + ph[2].length, "phone", "phone", { kind: src.kind, path: src.phone });
        }
        const em = EMAIL.exec(text);
        if (em) {
          const at = p.s + em.index + em[1].length;
          add(p, at, at + em[2].length, "email", "email", src.email ? { kind: src.kind, path: src.email } : { kind: "manual" });
          // what's before it ("2-Building No:12 | Email: …") is the address's next line
          const before = text.slice(0, em.index).replace(/[\s|,;/–—-]+$/, "");
          if (before.trim()) address.push({ p, s: p.s, e: p.s + before.length });
          return;
        }
        if (isCountryLine(text)) return add(p, p.s, p.e, "country", "country", { kind: src.kind, path: src.country });
        address.push({ p, s: p.s, e: p.e });
      });
      const widths = address.map((a) => Math.max(4, a.p.line.text.slice(a.s, a.e).trim().length));
      address.forEach((a, index) => add(a.p, a.s, a.e, `address (line ${index + 1})`, `address_${index + 1}`, { kind: src.kind, path: src.address, ...(address.length > 1 ? { wrap: { index, widths } } : {}) }));
      fields.push(...out);
    });
  }
  return fields;
}
