// ADDVET HC (prod, 28 Nov): the converted lines of its page 1 party block and page 2 "ATTACHED LIST"
const L = (id, page, x, y, w, text, h = 13) => ({ id, page, text, box: { x, y, w, h } });
export const HC_PAGE1 = [
  L("p1-l45", 1, 48, 177, 201, "CERTIFICATE NO:   PL231562", 12),
  L("p1-l1", 1, 54, 248, 428, "EXPORTER CONSIGNEE"),
  L("p1-l2", 1, 54, 271, 539, "AFAQ ADDITIVES FEED CO. MADHOOB TRADING GROUP"),
  L("p1-l3", 1, 54, 287, 289, "Jordan-Amman -Ghardenz St. Yousef Center "),
  L("p1-l4", 1, 54, 303, 260, "2-Building No:12 | Email: info@addvet.net"),
  L("p1-l5", 1, 54, 319, 144, "Tel: 009647561746315"),
  L("p1-l6", 1, 402, 285, 154, "Mawaleh South, Muscat."),
  L("p1-l7", 1, 402, 301, 114, "Sultante Of Oman"),
  L("p1-l8", 1, 402, 317, 79, "P.O Box 437"),
  L("p1-l9", 1, 402, 333, 130, "Tel: +968268904412"),
  L("p1-l10", 1, 54, 381, 97, "DECLARATION"),
  L("p1-l11", 1, 54, 403, 195, "The undersigned certifies that:"),
];
const NAMES = ["ADDMECTIN 1%", "SULFARIM*", "OLIGOVET", "ADDOXY 200-LA", "ADD-E120", "AMINOVITA", "H-DURIN", "H-RESPI", "CURCUMARIN", "ADDHEPA"];
const DESC = ["INJECTABLE", "ANTIBIOTIC", "INJECTION", "INJECTABLE", "SUPPLEMENT", "SUPPLEMENT", "SUPPLEMENT", "SUPPLEMENT", "SUPPLEMENT", "SUPPLEMENT"];
// the converted boxes as on prod: the description and packing columns are centred
const DESC_BOX = { INJECTABLE: [434, 81], ANTIBIOTIC: [437, 75], INJECTION: [439, 71], SUPPLEMENT: [430, 89] };
export const HC_PAGE2 = [
  L("p2-l1", 2, 54, 248, 105, "ATTACHED LIST"),
  L("p2-l2", 2, 54, 270, 661, "PRODUCT NAME BRAND DESCRIPTION PACKING SIZE FORM"),
  ...NAMES.flatMap((n, i) => {
    const y = 292 + Math.round(i * 21.7);
    return [L(`p2-l${3 + i}`, 2, 54, y, 9 * n.length, n), L(`p2-l${13 + i}`, 2, 337, y, 57, "ADDVET"), L(`p2-l${23 + i}`, 2, DESC_BOX[DESC[i]][0], y, DESC_BOX[DESC[i]][1], DESC[i]), L(`p2-l${33 + i}`, 2, i < 4 ? 568 : 583, y, i < 4 ? 46 : 16, i < 4 ? "100 ML" : "1 L"), L(`p2-l${43 + i}`, 2, 673, y, 45, "LIQUID")];
  }),
];
export const HC_PRODUCT_NAMES = NAMES.map((n) => n.replace("*", ""));
