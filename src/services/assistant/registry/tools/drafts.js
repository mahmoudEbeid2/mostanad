import { z } from "zod";
import { defineTool, allTools, draftData, draftStatus } from "../registry.js";
import { ToolError } from "../access.js";

// The model's side of operation drafts (drafts/draftService.js). An operation (any write tool)
// is collected in a draft: start_draft with what is already known, update_draft as answers and
// lookups come in. Code checks every value and makes the confirmation card when the draft is
// ready — these tools never change data themselves.

const operations = allTools().filter((t) => t.risk !== "read").map((t) => t.name);
// A value may be text, a number, true/false, or a list / object (sent as such or as JSON text):
// the draft reads it into the field's own type (drafts/coerce.js). QA 2026-11-23: a number or an
// object here used to fail the whole call ("expected string, received number").
const anyValue = z.preprocess((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v), z.union([z.string().max(8000), z.number(), z.boolean()]));
const pairs = (key) => z.array(z.object({ field: z.string().min(1).max(60), [key]: key === "value" ? anyValue : z.string().max(4000) })).max(30).optional();
const toObject = (list, key) => Object.fromEntries((list || []).map((p) => [p.field, p[key]]));
const sessionOf = async (ctx) => {
  const s = await ctx.drafts?.();
  if (!s) throw new ToolError("Drafts aren't available here", "no_drafts");
  return s;
};
const asResult = async (view) => ({ ...(await draftData(view)), status: draftStatus(view) });

defineTool({
  name: "start_draft",
  module: "assistant",
  core: true,
  risk: "read",
  label: "Starting the operation",
  description:
    `Starts collecting an operation the person asked for (one of: ${operations.join(", ")}). values: what is already known, as [{ field, value }] (value: text, a number, true/false, or a list/object as JSON text) — ` +
    "only values a tool returned or the person said; never invent one. hints: [{ field, text }] for fields code should look up (a brand / product / invoice name). " +
    "Returns what is filled (with its source), what is missing, what to ask the person and which prerequisites block it. The same as calling the operation's own tool.",
  args: z.object({ tool: z.string().min(3).max(64), values: pairs("value"), hints: pairs("text") }),
  run: async (a, ctx) => asResult(await (await sessionOf(ctx)).open({ tool: a.tool, values: toObject(a.values, "value"), hints: toObject(a.hints, "text"), companyId: ctx.companyId })),
});

defineTool({
  name: "update_draft",
  module: "assistant",
  core: true,
  risk: "read",
  label: "Updating the operation",
  description:
    "Adds to an open draft (its id from start_draft or the open drafts in the context): values the person gave (their words, mapped to fields), ids a lookup returned, hints to look up, clear to empty fields. " +
    "With nothing else it re-checks the draft (after a prerequisite step finished). Code validates every value again.",
  args: z.object({ draftId: z.string().uuid(), values: pairs("value"), hints: pairs("text"), clear: z.array(z.string().max(60)).max(30).optional() }),
  companyArg: false,
  run: async (a, ctx) => asResult(await (await sessionOf(ctx)).update(a.draftId, { values: toObject(a.values, "value"), hints: toObject(a.hints, "text"), clear: a.clear || [] })),
});

defineTool({
  name: "list_drafts",
  module: "assistant",
  core: true,
  risk: "read",
  label: "Reading open operations",
  description: "The open drafts of this conversation (operations being collected or waiting for the person's OK), to resume one (\"continue the product we were adding\").",
  args: z.object({}),
  companyArg: false,
  run: async (_a, ctx) => {
    const drafts = await (await sessionOf(ctx)).list();
    return { total: drafts.length, drafts: drafts.map((d) => ({ id: d.id, title: d.title, tool: d.tool, status: d.status, missing: d.missing, blockedBy: d.blockedBy.map((b) => b.key), updatedAt: d.updatedAt })) };
  },
});

// How-to answers come from a static, versioned help source (help/helpTopics.js), not from memory.
defineTool({
  name: "help_topics",
  module: "assistant",
  core: true,
  risk: "read",
  label: "Reading the help",
  description:
    "How the app works and what you (the assistant) can do. topic: one of the flow keys (certificates = issue a COA/certificate from an invoice, label_check, label_generate, label_resize, supplier_coa, catalogue, copy_product) " +
    "or \"capabilities\" (what you can read and change, from your own tools); omit for the list of topics. Answer how-to and \"what can you do\" questions only from this.",
  args: z.object({ topic: z.string().max(40).optional() }),
  companyArg: false,
  run: async (a, ctx) => {
    const { HELP_TOPICS, HELP_VERSION, capabilities } = await import("../../help/helpTopics.js");
    if (!a.topic) return { version: HELP_VERSION, topics: HELP_TOPICS.map((t) => ({ key: t.key, title: t.title })) };
    if (a.topic === "capabilities") {
      const { toolsFor } = await import("../registry.js");
      return { version: HELP_VERSION, capabilities: capabilities(toolsFor(ctx.actor).filter((t) => !["start_draft", "update_draft", "list_drafts", "help_topics"].includes(t.name))) };
    }
    const t = HELP_TOPICS.find((x) => x.key === a.topic);
    if (!t) throw new ToolError(`No help topic "${a.topic}". Topics: ${HELP_TOPICS.map((x) => x.key).join(", ")}, capabilities`, "not_found");
    return { version: HELP_VERSION, ...t };
  },
});
