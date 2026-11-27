import { fold } from "./grounding.js";
import { codesIn } from "./answerGuard.js";

// QA 27 Nov (re-test): files + "شهادات ADDVET" went to "Make certificate templates from files"
// and asked what type the MO and the invoice are, while "طلّعلي كل الشهادات من الملفات دي" went
// to Express. The route of a drop no longer depends on the model's reading of the wording: files
// with a short message (or none) go to Express by code, unless the person asks for templates or
// names another job for the files (a label to check or resize, a catalogue, a regulation, "file
// them only"). A long message with no such words still reaches the model, which is then not
// offered the template tools (see templateToolsAllowed).

const TEMPLATE_WORDS = /قالب|قوالب|template/i;
const OTHER_JOB = [
  "ليبل", "ملصق", "label", "مقاس", "resize", "size", "حجم", "ابعاد",
  "كتالوج", "كاتالوج", "catalog", "brochure",
  "لائحه", "لوائح", "regulat", "eda", "sfda", "متطلبات",
  "سجل الملفات بس", "سجل بس", "ارفع بس", "file them only", "just file", "only file",
  "صحح", "check this", "افحص", "راجع الليبل",
].map(fold);
const MAX_WORDS = 10;

/** The person asked for templates by name ("اعمل قالب", "use them as templates"). */
export const asksForTemplates = (text) => TEMPLATE_WORDS.test(String(text || ""));

/** A message's words, without the chat's own "📎 الملفات دي" stand-in for an empty message. */
const wordsOf = (text) => String(text || "").replace(/📎\s*الملفات دي/, "").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));

/**
 * → null, or { certificateTypes } when this message's files go to Express by code.
 * ctx: the agent context (attachments of THIS message, isEvent).
 */
export function expressDrop(text, ctx) {
  if (ctx.isEvent || !(ctx.attachments || []).length) return null;
  if (asksForTemplates(text)) return null;
  const t = ` ${fold(text)} `;
  if (OTHER_JOB.some((w) => t.includes(w))) return null;
  if (wordsOf(text).length > MAX_WORDS) return null;
  return { certificateTypes: codesIn(text) };
}

/** Files in the message and no word about templates: the model is not offered the template tools. */
export const templateToolsAllowed = (text, ctx) => !(ctx.attachments || []).length || asksForTemplates(text);
export const TEMPLATE_TOOLS = new Set(["create_certificate_templates", "use_files_as_templates"]);

export const expressDropAnswer = (text) =>
  /[؀-ۿ]/.test(String(text || "")) || !wordsOf(text).length
    ? "بفرز الملفات دلوقتي. الكارت تحت بيوري كل ملف وهيطلع منه إيه — راجعه ودوس «طلّع الشهادات»."
    : "I'm sorting the files now. The card below shows each file and what it will make. Check it and press the button to make the certificates.";
