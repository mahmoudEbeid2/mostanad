// What may reach the person: the answer with every internal marker removed, and
// never a claim of an action this turn did not prepare.
//
// QA (2026-11-23): the model learned to imitate the tools note replayed with its
// earlier answers and wrote "[tools used in this answer: start_draft(…) → waiting for
// your OK …]" — and "تم تجهيز بطاقة…" — when no tool had been called and no card
// existed. The note is no longer part of any model-visible answer text (history.js);
// this file is the always-on safety net in code.

const isArabic = (s) => /[؀-ۿ]/.test(String(s || ""));

// internal markers: our own context/check/action notes, raw tool calls, JSON args
const BRACKET_NOTES = /\[(?:tools used[^\]]*|context\][^\n]*|system check\][^\n]*|action [a-z]+\][^\n]*|earlier tool calls[^\]]*|attached: [0-9a-f-]{36}[^\]]*|open drafts:[^\]]*)\]?/gi;
const LINE_DROP = [
  /^\s*(?:functionCall|functionResponse|untrusted_data|tool_code|print\()/i,
  /^\s*```(?:json|tool_code|python)?\s*$/i,
  /^\s*[{[]\s*"(?:name|args|tool|draftId|values|field|untrusted_data|functionCall)"\s*:/i,
  /^\s*(?:start_draft|update_draft|list_drafts|load_tools)\s*\(/i,
  /Rows are not repeated here/i,
  /^\s*\[earlier tool calls/i,
];
const TRUNCATION = /…\s*\(\d+ more (?:characters|chars)\)|\s*…\s*\d+ more not shown/g;
// an entity id the model wrote outside a link: "entity:product/uuid" → dropped
const BARE_ENTITY = /(?<!\]\()\bentity:[a-z_]+\/[0-9a-fA-F-]{36}\b/g;
// a raw uuid in prose is an internal id, never something to show the person
const BARE_UUID = /(?<![(/\w-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\w-])/gi;

/** → { text, removed: [kinds] } — never throws, never adds content. */
export function sanitizeOutput(text) {
  const removed = new Set();
  let t = String(text || "");
  t = t.replace(BRACKET_NOTES, () => (removed.add("note"), ""));
  t = t
    .split("\n")
    .filter((line) => {
      const drop = LINE_DROP.some((re) => re.test(line));
      if (drop) removed.add("internal_line");
      return !drop;
    })
    .join("\n");
  t = t.replace(TRUNCATION, () => (removed.add("truncation"), "…"));
  t = t.replace(BARE_ENTITY, () => (removed.add("entity_id"), ""));
  t = t.replace(BARE_UUID, () => (removed.add("uuid"), ""));
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: t, removed: [...removed] };
}

// "I prepared / created / uploaded…", "تم تجهيز بطاقة…": a claim that something was done or a card exists
const CLAIMS = [
  /(?:تم|تمت|قمت ب|قمنا ب)\s*(?:ال)?(?:تجهيز|إعداد|اعداد|إنشاء|انشاء|رفع|تحديث|تعديل|مطابقة|مطابقه|ربط|حفظ|نسخ|تأكيد|تاكيد|إضافة|اضافة|توليد|تغيير)/,
  /(?:^|[\s،,.])(?:جهزت|جهّزت|أنشأت|انشأت|عملت|رفعت|حدّثت|حدثت|عدّلت|عدلت|غيرت|غيّرت|طابقت|ربطت|نسخت|أكدت|اكدت|أضفت|اضفت)(?:\s|$|[،,.])/,
  /(?:بطاقة|بطاقه|كارت)\s*(?:تأكيد|تاكيد|لإنشاء|لانشاء|لتحديث|لمطابقة|لرفع|جاهز|جاهزة|جاهزه)/,
  /\bI(?:'ve| have)?\s+(?:prepared|created|uploaded|updated|changed|matched|linked|copied|confirmed|made|set up|added|generated|started)\b/i,
  /\b(?:has|have|was|were)\s+been\s+(?:prepared|created|uploaded|updated|changed|matched|copied|confirmed|added|generated)\b/i,
  /\b(?:a|the|your)\s+(?:confirmation\s+)?card\b[^.\n]{0,40}\b(?:ready|prepared|shown|waiting|below|above)\b/i,
];

/** Does the answer say an action was done or a card was prepared? */
export const claimsAction = (text) => CLAIMS.some((re) => re.test(String(text || "")));

export const NO_ACTION_RETRY =
  "[system check] Your answer says an operation was prepared or done, but you called no tool that prepares it in this message — no card exists. " +
  "Call the operation's tool now (start_draft or the tool itself), or tell the person plainly that you could not do it and why. Never describe a card that does not exist.";

export const honestNoAction = (userText) =>
  isArabic(userText)
    ? "لم أُجهّز أي عملية أو بطاقة تأكيد في هذه الرسالة، فلم يتغيّر شيء. اكتب لي ما تريد تنفيذه بالتحديد وسأبدأ العملية."
    : "I didn't prepare any operation or confirmation card in this message, so nothing has changed. Tell me exactly what you want done and I'll start it.";

/** Did this turn actually prepare or run a change? (a draft step, a card, or a write's result) */
export const preparedSomething = (toolCalls, proposedCount = 0) =>
  proposedCount > 0 || (toolCalls || []).some((c) => c.ok && (c.draftId || c.status === "needs_confirmation" || c.status === "draft"));
