import { sanitizeOutput } from "./answerGuard.js";

// How earlier turns are replayed to the model. Their tool use is NOT appended to
// the model's own answer text any more (it learned to imitate that note and wrote
// it as if it had called tools). The answers are replayed as they were shown —
// cleaned — and what tools they used goes, once, into the current turn's context
// as an internal record the model is told never to write.

/** An earlier answer as the model sees it: exactly what the person saw, markers removed. */
export const replayText = (m) => (m.role === "assistant" ? sanitizeOutput(m.text).text || "(no text)" : m.text);

/** "(2 answers ago) search_products {"queries":["vita"]} → 5 close matches; nextPage=2" — or "" */
export function toolRecord(history) {
  const assistant = history.filter((m) => m.role === "assistant");
  const lines = [];
  assistant.forEach((m, i) => {
    const ago = assistant.length - i;
    for (const c of (m.toolCalls || []).filter((x) => x.ok && x.name)) {
      const args = JSON.stringify(c.args || {});
      lines.push(`- (${ago} answer${ago === 1 ? "" : "s"} ago) ${c.name} ${args.length > 200 ? `${args.slice(0, 200)}…` : args} → ${c.summary || "done"}${c.nextPage ? `; nextPage=${c.nextPage}` : ""}`);
    }
  });
  if (!lines.length) return "";
  return `\n[earlier tool calls — internal record of what you already looked up, for cursors (nextPage) and ids. Never write this record, quote it or imitate its format in an answer; rows are not kept here, call the tool again to show them]\n${lines.slice(-30).join("\n")}`;
}
