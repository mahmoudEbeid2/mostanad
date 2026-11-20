import { z } from "zod";
import { mayUse, resolveCompany, ToolError } from "./access.js";
import { shapeResult } from "./trim.js";

// The assistant's tool registry (phase C0). Deliberately free of Gemini and
// Express: a tool is a name, a description written for the model, a zod schema,
// a risk, a module, the permissions it needs, and run(args, ctx) calling the
// existing service layer as the caller. The agent loop turns tools into Gemini
// function declarations; the same list can later be served as an MCP server.
//
// Every call goes through runTool, which is where the rules live — not in the
// tools and not in the prompt:
//   - risk: only ALLOWED_RISKS run (C1 = read). The model asking for any other
//     tool, or a tool that isn't offered to this caller, is refused.
//   - permissions: the same rule restrictToPermission applies (company session:
//     the module allowlist; system user: role permissions).
//   - company: a company session always runs against its own company — a
//     companyId the model passes is dropped, never read. A system user runs
//     against the companyId arg when it names an existing company, else the
//     conversation's scope (a company, or null = all companies).
//   - results: trimmed and capped (trim.js) before the model sees them.

export const RISKS = ["read", "write", "sensitive"];
/** C1: read-only. Write tools come in C2. */
export const ALLOWED_RISKS = ["read"];

const tools = new Map();

/**
 * def: { name, module, description, risk, args (zod object), permissions: [slug…],
 *        systemOnly?, companyArg? (default true: system users may pass companyId),
 *        needsCompany? (refuses "all companies"), core?, label (progress text), run }
 */
export function defineTool(def) {
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(def.name || "")) throw new Error(`Bad tool name "${def.name}"`);
  if (tools.has(def.name)) throw new Error(`Tool "${def.name}" is defined twice`);
  if (!RISKS.includes(def.risk)) throw new Error(`Tool "${def.name}": risk must be one of ${RISKS.join(", ")}`);
  if (!def.module) throw new Error(`Tool "${def.name}" has no module`);
  if (!def.description || def.description.length < 40) throw new Error(`Tool "${def.name}" needs a description written for the model`);
  if (!(def.args instanceof z.ZodObject)) throw new Error(`Tool "${def.name}": args must be a zod object`);
  if ("companyId" in def.args.shape) throw new Error(`Tool "${def.name}": companyId is added by the registry, don't declare it`);
  if (typeof def.run !== "function") throw new Error(`Tool "${def.name}" has no run()`);
  const tool = { permissions: [], systemOnly: false, companyArg: true, needsCompany: false, core: false, ...def };
  tools.set(def.name, Object.freeze(tool));
  return tool;
}

export const allTools = () => [...tools.values()];
export const getTool = (name) => tools.get(name) || null;
export const modules = () => [...new Set(allTools().map((t) => t.module))].sort();

const COMPANY_ARG = z.string().uuid().describe("Optional (system users only): run against this company id instead of the conversation's company. Get ids from list_companies.");

/** Whether this caller may be offered / run this tool. → null | reason */
export function refusalFor(tool, actor) {
  if (!tool) return "unknown_tool";
  if (!ALLOWED_RISKS.includes(tool.risk)) return "risk_not_allowed";
  if (tool.systemOnly && actor.kind !== "user") return "system_only";
  if (!tool.permissions.every((slug) => mayUse(actor, slug))) return "permission";
  return null;
}

/** The tools this caller may use (optionally only these modules / names), in a stable order. */
export function toolsFor(actor, { modules: only = null, names = null } = {}) {
  return allTools()
    .filter((t) => !refusalFor(t, actor))
    .filter((t) => (!only && !names) || t.core || only?.includes(t.module) || names?.includes(t.name))
    .sort((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name));
}

/** The args schema the model sees: companyId only for system users, and only where the tool takes one. */
export function argsSchemaFor(tool, actor) {
  const schema = actor.kind === "user" && tool.companyArg ? tool.args.extend({ companyId: COMPANY_ARG.optional() }) : tool.args;
  return cleanSchema(z.toJSONSchema(schema, { target: "openapi-3.0", unrepresentable: "any" }));
}

// Keywords a function declaration may carry (Gemini's JSON Schema subset, also valid for MCP).
const SCHEMA_KEYS = new Set(["type", "properties", "required", "items", "enum", "description", "format", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "nullable", "anyOf"]);
export function cleanSchema(node) {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (!SCHEMA_KEYS.has(k) || k === "format" || k === "description") continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, cleanSchema(s)])) : cleanSchema(v);
  }
  // a format Gemini doesn't know (uuid, …) is said in the description instead
  const fmt = node.format && !["date-time", "enum"].includes(node.format) ? ` (${node.format})` : "";
  if (node.format && !fmt) out.format = node.format;
  if (node.description || fmt) out.description = `${node.description || ""}${fmt}`.trim();
  return out;
}

/** Plain, serialisable descriptions — what the Gemini adapter (or an MCP server) exposes. */
export const describeTools = (list, actor) => list.map((t) => ({ name: t.name, description: t.description, parameters: argsSchemaFor(t, actor), module: t.module, risk: t.risk }));

const TOOL_TIMEOUT_MS = Number(process.env.ASSISTANT_TOOL_TIMEOUT_MS) || 15_000;

function withTimeout(promise, ms, name) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ToolError(`${name} took longer than ${Math.round(ms / 1000)}s and was stopped`, "timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Runs one tool call for ctx = { actor, scope: { companyId|null }, page?, offered?: Set<name>,
 * companyExists?: (id) => Promise<boolean>, audit?: (entry) => Promise }.
 * Never throws: → { ok, status: ok|error|refused, data?, error?, companyId, ms }
 */
export async function runTool(name, rawArgs, ctx) {
  const started = Date.now();
  const tool = getTool(name);
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? { ...rawArgs } : {};
  const finish = async (out) => {
    const result = { ...out, ms: Date.now() - started };
    if (ctx.audit) await ctx.audit({ tool: name, args: rawArgs ?? null, companyId: result.companyId ?? null, status: result.status, error: result.error ?? null, durationMs: result.ms });
    return result;
  };

  let refusal = refusalFor(tool, ctx.actor);
  if (!refusal && ctx.offered && !ctx.offered.has(name)) refusal = "not_offered";
  if (refusal) return finish({ ok: false, status: "refused", error: REFUSALS[refusal](name), companyId: null });

  let companyId = null;
  try {
    companyId = await resolveCompany(tool, args, ctx);
    delete args.companyId;
    const parsed = tool.args.safeParse(args);
    if (!parsed.success) throw new ToolError(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ")}`, "invalid_args");
    const data = await withTimeout(Promise.resolve(tool.run(parsed.data, { actor: ctx.actor, companyId, page: ctx.page || null, isSystem: ctx.actor.kind === "user" })), TOOL_TIMEOUT_MS, name);
    return finish({ ok: true, status: "ok", data: shapeResult(data), companyId });
  } catch (err) {
    // a service's 404 for another tenant's id reads the same as one that doesn't exist
    return finish({ ok: false, status: "error", error: messageOf(err), companyId });
  }
}

const REFUSALS = {
  unknown_tool: (n) => `There is no tool called ${n}.`,
  risk_not_allowed: (n) => `${n} changes data; the assistant can only read in this version.`,
  system_only: (n) => `${n} is for system users only.`,
  permission: (n) => `You don't have permission to use ${n}.`,
  not_offered: (n) => `${n} isn't available for this message.`,
};

function messageOf(err) {
  const msg = err?.message || String(err);
  return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
}
