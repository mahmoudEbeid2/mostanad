import { z } from "zod";
import { defineTool, allTools, draftData, draftStatus } from "../registry.js";
import { ToolError } from "../access.js";

// The model's side of operation drafts (drafts/draftService.js). An operation (any write tool)
// is collected in a draft: start_draft with what is already known, update_draft as answers and
// lookups come in. Code checks every value and makes the confirmation card when the draft is
// ready — these tools never change data themselves.

const operations = allTools().filter((t) => t.risk !== "read").map((t) => t.name);
const pairs = (key) => z.array(z.object({ field: z.string().min(1).max(60), [key]: z.string().max(4000) })).max(30).optional();
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
    `Starts collecting an operation the person asked for (one of: ${operations.join(", ")}). values: what is already known, as [{ field, value }] (value as text; JSON for lists/objects) — ` +
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
