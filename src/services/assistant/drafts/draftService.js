import { prisma } from "../../../lib/prisma.js";
import AppError from "../../../utils/appError.js";
import { getTool, runTool, refusalFor } from "../registry/index.js";
import { fold } from "../agent/grounding.js";
import { specFor, labelOf } from "./specs.js";
import { coerceToSchema } from "./coerce.js";

// Operation drafts (slot filling). A write the model asks for is never a card straight away:
// it is a draft that collects the operation's values across steps and turns —
//   values the model gives are checked by code: against the field's schema (never coerced), a
//     lookup field's id must exist in the company, a user field must be in the person's own
//     words (else it stays missing and the person is asked), a pending choice is the person's;
//   code fills what it can: the page, this message's files, a lookup with a single result
//     (several become a choice for the person, never picked by the model);
//   the prerequisites are checked, each with the tools that satisfy it.
// When nothing is missing or blocking the draft is ready and code makes ONE confirmation card
// from exactly its values (actions.proposeAction, hashed). Run executes only a ready draft's card
// whose args still hash the same (actions.approveAction). Every change is audited.

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const OPEN = ["collecting", "ready"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const owns = (actor, row) => row.ownerType === actor.kind && row.ownerId === actor.id;
const clip = (v, n = 300) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

// ── checks on one value ─────────────────────────────────────────────────────
// keys that pick WHERE a value goes (update_product_fields' { field, value }, copy_products_to_brand's
// { productId, name }) — the model maps those (an id from a lookup, which the tool's preview checks
// in the caller's company); the value is the person's
const SELECTOR_KEYS = new Set(["field", "productId"]);
/** Every string / number inside a value (not its selector keys). */
const leaves = (v, out = []) => {
  if (v === null || v === undefined) return out;
  if (typeof v === "string" || typeof v === "number") out.push(String(v));
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (typeof v === "object") Object.entries(v).forEach(([k, x]) => !SELECTOR_KEYS.has(k) && leaves(x, out));
  return out;
};
/** The value is in the person's own messages, word for word (case and Arabic forms folded). */
export function saidByUser(value, userTexts) {
  const corpus = fold((userTexts || []).join("\n"));
  const parts = leaves(value).map((x) => fold(x)).filter(Boolean);
  return parts.length > 0 && parts.every((p) => corpus.includes(p));
}

/** A value as the person reads it on the card ("Vitamin C 10%, Zinc 5%"). */
export function displayOf(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? Object.entries(x).filter(([k, y]) => k !== "field" && y !== null && y !== undefined && y !== "").map(([, y]) => String(y)).join(" ") : String(x))).join(", ");
  if (typeof v === "object") return Object.entries(v).map(([k, y]) => `${k}: ${y}`).join(", ");
  return String(v);
}

/** A value the model sent as text (start_draft / update_draft) read as the field's type — strictly. */
function typed(field, raw) {
  if (typeof raw !== "string" || field.type === "string") return raw;
  const t = raw.trim();
  if (field.type === "number" || field.type === "integer") {
    if (!/^-?\d+(\.\d+)?$/.test(t)) throw new Error(`"${raw}" is not a number`);
    return Number(t);
  }
  if (field.type === "boolean") {
    if (t !== "true" && t !== "false") throw new Error(`"${raw}" is not true or false`);
    return t === "true";
  }
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`"${clip(raw, 60)}" is not valid JSON for a ${field.type}`);
  }
}

/** "Invalid arguments: lineNo: …" / a spec's patterns / a field's label in the message → field names. */
export function fieldsOfError(spec, message) {
  const msg = String(message || "");
  const names = spec.fields.map((f) => f.name);
  const out = new Set();
  for (const m of msg.matchAll(/(?:^|[;:]\s*)([a-zA-Z]+)(?:\.\d+)?(?:\.[a-zA-Z]+)?:/g)) if (names.includes(m[1])) out.add(m[1]);
  if (!out.size) for (const [re, name] of spec.errors) if (re.test(msg) && names.includes(name)) out.add(name);
  if (!out.size) for (const f of spec.fields) if (new RegExp(`\\b${f.label}\\b`, "i").test(msg)) out.add(f.name);
  return [...out];
}

// ── loading ─────────────────────────────────────────────────────────────────
async function loadOwnDraft(actor, id, conversationId = null) {
  const row = UUID.test(String(id)) ? await prisma.assistantDraft.findUnique({ where: { id } }) : null;
  if (!row || !owns(actor, row) || (conversationId && row.conversationId !== conversationId)) throw new AppError("Draft not found!", 404);
  const conv = await prisma.assistantConversation.findUnique({ where: { id: row.conversationId }, select: { deletedAt: true } });
  if (!conv || conv.deletedAt) throw new AppError("Draft not found!", 404);
  return row;
}

async function companyName(id) {
  return id ? (await prisma.company.findUnique({ where: { id }, select: { name: true } }))?.name ?? null : null;
}

// ── audit (the assistant's tool-call audit log) ─────────────────────────────
function auditDraft(base, draft, status, args = {}, error = null) {
  return prisma.assistantToolCall
    .create({ data: { conversationId: draft.conversationId, messageId: base.messageId || null, ownerType: draft.ownerType, ownerId: draft.ownerId, tool: `draft:${draft.tool}`, args: { draftId: draft.id, ...args }, companyId: draft.companyId, status, error, durationMs: 0 } })
    .catch((err) => console.error(`[assistant] draft audit row for ${draft.id} not written: ${err.message}`));
}

// ── the collecting loop ─────────────────────────────────────────────────────
/**
 * One step on a draft: apply values / hints / clears, fill what code can, check prerequisites,
 * then ready → card, or collecting. by: "model" (a tool call) | "user" (the form card).
 * env: { actor, scope, page, conversationId, userTexts, attachments, companyExists, propose, audit, messageId, onDraft, ledgerMeta }
 */
async function step(draft, spec, { values = {}, hints = {}, clear = [], by = "model" }, env) {
  const fields = { ...(draft.fields || {}) };
  const rejected = [];
  const notes = [];
  const changed = [];
  const now = new Date();
  let companyId = draft.companyId;

  const run = async (tool, args) => {
    const r = await runTool(tool, { ...args, ...(env.actor.kind === "user" && companyId ? { companyId } : {}) }, { actor: env.actor, scope: { companyId }, companyExists: env.companyExists, audit: env.audit });
    if (!r.ok) {
      notes.push(`${tool}: ${r.error}`);
      return null;
    }
    return r.data;
  };
  const d = () => ({ ctx: env, companyId, fields: Object.fromEntries(Object.entries(fields).filter(([, f]) => f.value !== undefined).map(([k, f]) => [k, f.value])), run });
  const set = (name, entry) => {
    fields[name] = { ...entry, at: now.toISOString() };
    changed.push({ field: name, value: clip(entry.value), source: entry.source, by: entry.by });
  };

  // the company (system users: it may still be open)
  if (values.companyId !== undefined || hints.companyId !== undefined) {
    const want = values.companyId ?? null;
    if (env.actor.kind === "company") rejected.push({ field: "companyId", reason: "A company session always works in its own company" });
    else if (companyId && want && want !== companyId) rejected.push({ field: "companyId", reason: "The company of a draft can't change; cancel it and start a new one" });
    else if (want && !(UUID.test(want) && (await env.companyExists?.(want)))) rejected.push({ field: "companyId", reason: "Company not found — use list_companies" });
    else if (want) {
      companyId = want;
      changed.push({ field: "companyId", value: want, source: by === "user" ? "user" : "lookup", by });
    } else if (hints.companyId) {
      const data = await run("list_companies", { q: String(hints.companyId), limit: 12 });
      const options = (data?.items || []).map((c) => ({ value: c.id, label: c.name }));
      if (options.length === 1) {
        companyId = options[0].value;
        changed.push({ field: "companyId", value: companyId, source: "lookup", by: "code" });
      } else if (options.length) fields.companyId = { options, at: now.toISOString() };
      else notes.push(`No company matched "${hints.companyId}"`);
    }
  }
  delete values.companyId;
  delete hints.companyId;
  if (companyId) delete fields.companyId;

  for (const name of clear) {
    if (fields[name]) {
      delete fields[name];
      changed.push({ field: name, value: null, source: null, by });
    }
  }

  // values given (the model's or the person's form), in the spec's field order (an invoice before its line)
  for (const field of spec.fields) {
    if (!(field.name in values)) continue;
    const raw = values[field.name];
    if (raw === null || raw === "" || (Array.isArray(raw) && !raw.length)) {
      if (fields[field.name]) {
        delete fields[field.name];
        changed.push({ field: field.name, value: null, source: null, by });
      }
      continue;
    }
    try {
      if (!companyId && field.resolvers.some((r) => r.verify)) throw new Error("Pick the company first");
      // the form of the value is read leniently into the field's type; its content never changes
      const coerced = coerceToSchema(field.schema, raw, env.userTexts || []);
      const value = typed(field, field.normalize ? field.normalize(coerced) : coerced);
      const parsed = field.schema.safeParse(value);
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; "));
      const v = parsed.data;
      const current = fields[field.name];
      const verifier = field.resolvers.find((r) => r.verify);
      const missingNeeds = (verifier?.needs || []).filter((n) => d().fields[n] === undefined);
      if (missingNeeds.length) throw new Error(`Set ${missingNeeds.map(labelOf).join(", ")} first`);
      // a pending choice is the person's: the model may only pass on what they said
      if (current?.options?.length && by !== "user") {
        const hit = current.options.find((o) => JSON.stringify(o.value) === JSON.stringify(v));
        if (!hit) throw new Error("Not one of the options offered to the person");
        if (!saidByUser(hit.label, env.userTexts) && !saidByUser(v, env.userTexts)) throw new Error(`This is a choice for the person between ${current.options.length} options — show them; don't pick`);
      }
      let display = displayOf(v);
      let source = by === "user" ? "user" : "lookup";
      let evidence = by === "user" ? "typed in the form" : null;
      if (verifier) {
        // the model's id is checked against what code sees: an ambiguity found here becomes a choice
        if (by !== "user" && !current?.options?.length) {
          const lookup = field.resolvers.find((r) => r.kind === "lookup" && r.resolve);
          const seen = lookup && hints[field.name] ? await lookup.resolve(d(), String(hints[field.name])) : null;
          if (seen?.options?.length > 1 && seen.options.some((o) => JSON.stringify(o.value) === JSON.stringify(v))) {
            fields[field.name] = { options: seen.options, at: now.toISOString() };
            throw new Error(`${seen.options.length} match "${hints[field.name]}" — that's a choice for the person`);
          }
        }
        display = (await verifier.verify(v, d())).display;
        if (by !== "user") {
          source = verifier.kind === "context" ? "context" : "lookup";
          evidence = "from a lookup in this conversation";
        }
      } else if (by !== "user") {
        // only the person can give it: their own words, never the model's
        if (!saidByUser(v, env.userTexts)) throw new Error("Not in the person's messages. Only they can give this — ask them (the chat shows a form); never fill it in yourself");
        source = "user";
        evidence = "in your message";
      }
      set(field.name, { value: v, display, source, evidence, confirmed: by === "user", by });
    } catch (err) {
      rejected.push({ field: field.name, reason: err.message });
    }
  }
  for (const name of Object.keys(values)) if (!spec.fields.some((f) => f.name === name)) rejected.push({ field: name, reason: `${spec.tool.name} has no field ${name}` });

  // hints: text code looks up (a name, a code) — a single result fills the field, several are a choice
  for (const [name, text] of Object.entries(hints)) {
    const field = spec.fields.find((f) => f.name === name);
    const lookup = field?.resolvers.find((r) => r.kind === "lookup" && r.resolve);
    if (!field || !lookup) {
      rejected.push({ field: name, reason: `${name} isn't found by lookup${field ? "; give the value" : ""}` });
      continue;
    }
    if (fields[name]?.value !== undefined && name in values) continue;
    if (!companyId) {
      rejected.push({ field: name, reason: "Pick the company first" });
      continue;
    }
    const missingNeeds = (lookup.needs || []).filter((n) => d().fields[n] === undefined);
    if (missingNeeds.length) {
      rejected.push({ field: name, reason: `Set ${missingNeeds.map(labelOf).join(", ")} first` });
      continue;
    }
    const got = await lookup.resolve(d(), String(text));
    if (got?.options) fields[name] = { options: got.options, at: now.toISOString() };
    else if (got) set(name, { value: got.value, display: got.display ?? String(got.value), source: "lookup", evidence: got.evidence, confirmed: false, by: "code" });
    else notes.push(`Nothing matched "${text}" for ${labelOf(name)}`);
  }

  // what code fills by itself: the page / files; a required field's lookup when it has a single answer
  if (companyId) {
    for (const field of spec.fields) {
      if (fields[field.name]?.value !== undefined || fields[field.name]?.options?.length || fields[field.name]?.error) continue;
      for (const r of field.resolvers) {
        if (!r.resolve || (r.needs || []).some((n) => d().fields[n] === undefined)) continue;
        if (r.kind === "lookup" && !field.required) continue;
        const got = await r.resolve(d(), null);
        if (got?.options) {
          fields[field.name] = { options: got.options, at: now.toISOString() };
          break;
        }
        if (got) {
          set(field.name, { value: got.value, display: got.display ?? String(got.value), source: r.kind === "context" ? "context" : "lookup", evidence: got.evidence, confirmed: false, by: "code" });
          break;
        }
      }
    }
  }

  // what's missing, and what blocks
  const vals = Object.fromEntries(Object.entries(fields).filter(([, f]) => f.value !== undefined).map(([k, f]) => [k, f.value]));
  const missing = [...(companyId ? [] : ["companyId"]), ...spec.fields.filter((f) => (f.required && vals[f.name] === undefined) || fields[f.name]?.error).map((f) => f.name)];
  const blockedBy = [];
  if (companyId) {
    for (const p of spec.prerequisites) {
      if (p.needs.some((n) => vals[n] === undefined)) continue;
      const out = await p.check({ ...d(), fields: vals });
      if (out) blockedBy.push({ key: p.key, label: p.label, detail: out.detail, fix: p.fix });
    }
  }
  // steps in order: while lines still need products, "confirm" / "fill the data" aren't the next step
  // (QA 2026-11-23: it proposed confirming an invoice whose seven lines were all unmatched)
  if (blockedBy.some((b) => b.key === "lines_matched" || b.key === "some_matched")) {
    for (let i = blockedBy.length - 1; i >= 0; i--) if (["invoice_ready", "data_complete"].includes(blockedBy[i].key)) blockedBy.splice(i, 1);
  }
  if (!companyId && !fields.companyId?.options && env.actor.kind === "user") {
    const data = await run("list_companies", { limit: 12 });
    const options = (data?.items || []).map((c) => ({ value: c.id, label: c.name }));
    if (options.length) fields.companyId = { options, at: now.toISOString() };
  }

  // ready → one card from exactly these values; else the draft keeps collecting
  let status = "collecting";
  let error = null;
  let actionId = draft.actionId;
  let argsHash = draft.argsHash;
  let watch = draft.watch;
  const { argsHashOf, proposeAction, cancelPending } = await import("../actions.js");
  if (!missing.length && !blockedBy.length) {
    const parsed = spec.tool.args.safeParse(vals);
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        const name = String(i.path[0] || "");
        if (fields[name]) fields[name] = { ...fields[name], error: i.message };
      }
      error = "Some values don't fit the operation";
    } else {
      const hash = argsHashOf({ tool: spec.tool.name, companyId, args: parsed.data });
      const card = actionId ? await prisma.assistantAction.findUnique({ where: { id: actionId } }) : null;
      if (card?.status === "pending" && card.argsHash === hash && draft.status === "ready") {
        status = "ready";
      } else {
        const tctx = { actor: env.actor, companyId, page: env.page || null, isSystem: env.actor.kind === "user", conversationId: draft.conversationId, userTexts: env.userTexts || [] };
        try {
          if (spec.tool.guard) await spec.tool.guard(parsed.data, tctx);
          const preview = await spec.tool.preview(parsed.data, tctx);
          if (card?.status === "pending") await cancelPending(env.actor, card.id, "the draft changed");
          const fieldsShown = [
            { name: "companyId", label: "Company", value: await companyName(companyId), source: env.actor.kind === "company" || companyId === env.scope?.companyId ? "context" : "user", evidence: env.actor.kind === "company" ? "your company" : "the company picked" },
            ...spec.fields.filter((f) => vals[f.name] !== undefined).map((f) => ({ name: f.name, label: f.label, value: fields[f.name].display ?? displayOf(vals[f.name]), source: fields[f.name].source, evidence: fields[f.name].evidence || null })),
          ];
          const propose = env.propose || ((p) => proposeAction({ conversationId: draft.conversationId, messageId: env.messageId || null, actor: env.actor, ...p }));
          const row = await propose({ tool: spec.tool.name, args: parsed.data, companyId, preview: { ...preview, fields: fieldsShown, draftId: draft.id }, draftId: draft.id });
          status = "ready";
          actionId = row.id;
          argsHash = hash;
          watch = spec.watch ? await spec.watch(vals, d()) : null;
        } catch (err) {
          error = String(err.message || err).slice(0, 500);
          for (const name of fieldsOfError(spec, error)) if (fields[name]) fields[name] = { ...fields[name], error };
        }
      }
    }
  }
  if (status !== "ready" && actionId) {
    const card = await prisma.assistantAction.findUnique({ where: { id: actionId }, select: { status: true } });
    if (card?.status === "pending") await cancelPending(env.actor, actionId, "the draft changed");
    actionId = null;
    argsHash = null;
    watch = null;
  }

  const messageIds = [...new Set([...(Array.isArray(draft.messageIds) ? draft.messageIds : []), ...(env.messageId ? [env.messageId] : [])])].slice(-50);
  const updated = await prisma.assistantDraft.update({
    where: { id: draft.id },
    data: { companyId, fields, missing, blockedBy, status, actionId, argsHash, watch, error, messageIds, expiresAt: new Date(now.getTime() + DRAFT_TTL_MS) },
  });
  for (const c of changed) await auditDraft(env, updated, "draft_set", c);
  for (const r of rejected) await auditDraft(env, updated, "draft_rejected", { field: r.field, by }, r.reason);
  if (updated.status !== draft.status) await auditDraft(env, updated, "draft_status", { from: draft.status, to: updated.status });
  if (env.ledgerMeta) env.ledgerMeta.draftId = updated.id; // this message's later AI calls are this draft's
  const view = await draftView(updated, { rejected, notes });
  env.onDraft?.(view);
  return view;
}

// ── lazy expiry: 24 h after the last change, or what it acts on changed after its card was shown ──
async function expireIfStale(row, actor) {
  if (!OPEN.includes(row.status)) return row;
  let reason = null;
  if (row.expiresAt <= new Date()) reason = "it wasn't touched for 24 hours";
  else if (row.status === "ready" && row.watch) {
    const spec = specFor(row.tool);
    const vals = Object.fromEntries(Object.entries(row.fields || {}).filter(([, f]) => f.value !== undefined).map(([k, f]) => [k, f.value]));
    const now = spec?.watch ? await spec.watch(vals, { companyId: row.companyId }) : null;
    if (now !== row.watch) reason = "what it acts on changed after its card was shown";
  }
  if (!reason) return row;
  const { cancelPending } = await import("../actions.js");
  if (row.actionId) await cancelPending(actor, row.actionId, `draft expired: ${reason}`, { status: "expired" });
  const updated = await prisma.assistantDraft.update({ where: { id: row.id }, data: { status: "expired", error: `Expired: ${reason}.` } });
  await auditDraft({}, updated, "draft_status", { from: row.status, to: "expired", reason });
  return updated;
}

// ── views ───────────────────────────────────────────────────────────────────
const FORM_TYPES = { integer: "number", number: "number", boolean: "boolean" };

export async function draftView(row, { rejected = [], notes = [], withAction = true } = {}) {
  const spec = specFor(row.tool);
  const fields = row.fields || {};
  const blockedBy = Array.isArray(row.blockedBy) ? row.blockedBy : [];
  const missing = Array.isArray(row.missing) ? row.missing : [];
  const list = (spec?.fields || []).map((f) => {
    const e = fields[f.name] || {};
    return { name: f.name, label: f.label, required: f.required, how: f.how, type: f.type, enum: f.enum, multiple: f.multiple, form: f.form, fieldOptions: f.fieldOptions || null, staticOptions: f.staticOptions || null, value: e.value, display: e.display ?? null, source: e.source ?? null, evidence: e.evidence ?? null, confirmed: !!e.confirmed, options: e.options ?? null, error: e.error ?? null };
  });
  const companyOptions = fields.companyId?.options || null;
  const byName = Object.fromEntries(list.map((f) => [f.name, f]));
  // what only the person can answer (asked in one form), and what the model should find with a lookup
  const ask = [
    ...(missing.includes("companyId") ? [{ name: "companyId", label: "Company", type: "choice", options: companyOptions, required: true }] : []),
    ...missing
      .filter((n) => byName[n])
      .map((n) => byName[n])
      .filter((f) => f.options?.length || f.staticOptions?.length || f.how.includes("user"))
      .map((f) => ({ name: f.name, label: f.label, required: true, type: f.options?.length || f.staticOptions?.length ? "choice" : f.form || (f.enum ? "choice" : FORM_TYPES[f.type] || (f.type === "array" ? "list" : "text")), multiple: f.multiple, options: f.options || f.staticOptions || (f.enum ? f.enum.map((v) => ({ value: v, label: String(v) })) : null), ...(f.fieldOptions ? { fieldOptions: f.fieldOptions } : {}), error: f.error })),
  ];
  const toFind = missing.filter((n) => byName[n] && !ask.some((a) => a.name === n)).map((n) => ({ name: n, label: byName[n].label, how: byName[n].how }));
  const action = withAction && row.actionId ? await prisma.assistantAction.findUnique({ where: { id: row.actionId } }) : null;
  const { actionView } = await import("../actions.js");
  return {
    id: row.id,
    tool: row.tool,
    title: spec?.title || row.tool,
    status: row.status,
    companyId: row.companyId,
    companyName: await companyName(row.companyId),
    fields: list.filter((f) => f.value !== undefined || f.options || f.error || f.required),
    optional: list.filter((f) => !f.required && f.value === undefined).map((f) => f.name),
    missing,
    ask,
    toFind,
    blockedBy,
    actionId: row.actionId,
    action: action ? actionView(action) : null,
    error: row.error,
    result: row.result,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
    ...(rejected.length ? { rejected } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

/** What the model reads after a draft step: the view plus what to do next. */
export function forModel(view) {
  const next = [];
  if (view.status === "ready") next.push("Ready: the person sees ONE confirmation card with every value and its source. NOTHING has happened yet — it runs only if they press its button. Don't say it was done.");
  if (view.rejected?.length) next.push(`Rejected (not stored): ${view.rejected.map((r) => `${r.field}: ${r.reason}`).join(" · ")}. Never retry with a value you made up.`);
  if (view.toFind.length) next.push(`Find with a lookup (read tools, or pass hints): ${view.toFind.map((f) => `${f.name} [${f.how.join(", ")}]`).join(", ")}.`);
  if (view.ask.length) next.push(`Ask the person, ALL in ONE short message (the chat shows them a form): ${view.ask.map((a) => `${a.label}${a.options?.length ? ` (a choice of ${a.options.length})` : ""}`).join(", ")}. Re-use what they already said by passing it with update_draft instead of asking again.`);
  if (view.blockedBy.length) next.push(`Blocked first by: ${view.blockedBy.map((b) => `${b.label} — ${b.detail}${b.fix.length ? ` (fix with: ${b.fix.join(" or ")}, each its own draft)` : " (the person must do this on its page)"}`).join("; ")}. Then call update_draft(${view.id}) to check again.`);
  if (view.status === "collecting" && view.error && !view.rejected?.length) next.push(`Last problem: ${view.error}`);
  return { draft: view, next: next.join(" ") || "Nothing to do." };
}

// ── the model's session (one turn) ──────────────────────────────────────────
/** Draft operations bound to one turn's context (the registry ctx of sendMessage, or a test's). */
export function draftSession(env) {
  return {
    /** start_draft / a write tool call: a new draft, or the open one for the same operation (same key). */
    async open({ tool: name, values = {}, hints = {}, companyId = null }) {
      const tool = getTool(name);
      if (!tool || tool.risk === "read") throw new AppError(`${name} is not an operation`, 400);
      const refusal = refusalFor(tool, env.actor);
      if (refusal) throw new AppError(`You can't ${name.replace(/_/g, " ")} (${refusal})`, 403);
      if (!env.conversationId) throw new AppError("Drafts live in a conversation", 400);
      const spec = specFor(name);
      const scope = env.actor.kind === "company" ? env.actor.companyId : companyId ?? env.scope?.companyId ?? null;
      const open = await prisma.assistantDraft.findMany({ where: { conversationId: env.conversationId, ownerType: env.actor.kind, ownerId: env.actor.id, tool: name, status: { in: OPEN } }, orderBy: { updatedAt: "desc" } });
      const keyOf = (vals) => spec.key.map((k) => JSON.stringify(vals[k] ?? null)).join("|");
      const want = keyOf(values);
      const match = spec.key.length && spec.key.some((k) => values[k] !== undefined) ? open.find((r) => (!scope || r.companyId === scope) && keyOf(Object.fromEntries(Object.entries(r.fields || {}).map(([k, f]) => [k, f.value]))) === want) : null;
      // an expired one is never revived: the operation starts over in a new draft
      const reuse = match && OPEN.includes((await expireIfStale(match, env.actor)).status) ? match : null;
      const draft =
        reuse ||
        (await prisma.assistantDraft.create({
          data: { conversationId: env.conversationId, ownerType: env.actor.kind, ownerId: env.actor.id, companyId: scope, tool: name, fields: {}, missing: [], blockedBy: [], status: "collecting", expiresAt: new Date(Date.now() + DRAFT_TTL_MS) },
        }));
      if (!reuse) {
        await auditDraft(env, draft, "draft_status", { from: null, to: "collecting", tool: name });
        if (scope) await auditDraft(env, draft, "draft_set", { field: "companyId", value: scope, source: "context", by: "code" });
      }
      return step(draft, spec, { values: { ...values }, hints: { ...hints }, by: "model" }, env);
    },
    async update(draftId, { values = {}, hints = {}, clear = [] } = {}) {
      const row = await expireIfStale(await loadOwnDraft(env.actor, draftId, env.conversationId), env.actor);
      if (!OPEN.includes(row.status)) return draftView(row, { notes: [`This draft is ${row.status}; start a new one if the person still wants it.`] });
      return step(row, specFor(row.tool), { values: { ...values }, hints: { ...hints }, clear, by: "model" }, env);
    },
    async list() {
      const rows = await prisma.assistantDraft.findMany({ where: { conversationId: env.conversationId, ownerType: env.actor.kind, ownerId: env.actor.id, status: { in: OPEN } }, orderBy: { updatedAt: "desc" }, take: 20 });
      const live = [];
      for (const r of rows) live.push(await expireIfStale(r, env.actor));
      return Promise.all(live.filter((r) => OPEN.includes(r.status)).map((r) => draftView(r, { withAction: false })));
    },
  };
}

/** One line per open draft, for the model's context on every message. */
export async function openDraftsNote(actor, conversationId) {
  const rows = await prisma.assistantDraft.findMany({ where: { conversationId, ownerType: actor.kind, ownerId: actor.id, status: { in: OPEN }, expiresAt: { gt: new Date() } }, orderBy: { updatedAt: "desc" }, take: 10 });
  return rows.map((r) => `${r.id} · ${specFor(r.tool)?.title || r.tool} · ${r.status}${(r.missing || []).length ? ` · missing: ${r.missing.join(", ")}` : ""}${(r.blockedBy || []).length ? ` · blocked by: ${r.blockedBy.map((b) => b.key).join(", ")}` : ""}`);
}

// ── the person, from the UI ─────────────────────────────────────────────────
/** POST /assistant/drafts/:id/fields — the form card: values typed or chosen by the person. */
export async function submitDraftFields(actor, draftId, values, env = {}) {
  const row = await expireIfStale(await loadOwnDraft(actor, draftId), actor);
  if (!OPEN.includes(row.status)) throw new AppError(`This draft is ${row.status}.`, 409);
  const conv = await prisma.assistantConversation.findUnique({ where: { id: row.conversationId }, select: { companyId: true } });
  const companyExists = async (id) => UUID.test(String(id)) && !!(await prisma.company.findUnique({ where: { id }, select: { id: true } }));
  const lastMessage = Array.isArray(row.messageIds) ? row.messageIds.at(-1) : null;
  return step(row, specFor(row.tool), { values: { ...values }, by: "user" }, { actor, scope: { companyId: conv?.companyId ?? null }, conversationId: row.conversationId, companyExists, messageId: lastMessage, userTexts: [], ...env });
}

const uiEnv = async (actor, row, env = {}) => {
  const conv = await prisma.assistantConversation.findUnique({ where: { id: row.conversationId }, select: { companyId: true } });
  const companyExists = async (id) => UUID.test(String(id)) && !!(await prisma.company.findUnique({ where: { id }, select: { id: true } }));
  const lastMessage = Array.isArray(row.messageIds) ? row.messageIds.at(-1) : null;
  const userTexts = (await prisma.assistantMessage.findMany({ where: { conversationId: row.conversationId, role: "user", supersededAt: null }, select: { text: true } })).map((m) => m.text);
  return { actor, scope: { companyId: conv?.companyId ?? null }, conversationId: row.conversationId, companyExists, messageId: lastMessage, userTexts, ...env };
};

/**
 * POST /assistant/drafts/:id/fix { key } — "Do this step": the prerequisite's fix operation starts as its
 * own draft right away (the invoice carried over), instead of posting a long English text as the
 * person's message (QA 2026-11-23). → the new draft's view
 */
export async function startFixDraft(actor, draftId, key, env = {}) {
  const row = await loadOwnDraft(actor, draftId);
  const blocker = (Array.isArray(row.blockedBy) ? row.blockedBy : []).find((b) => b.key === key);
  if (!blocker || !blocker.fix?.length) throw new AppError("That step has no operation to start here; do it on its page.", 400);
  const carry = Object.fromEntries(["invoiceId", "productId", "labelId"].map((k) => [k, row.fields?.[k]?.value]).filter(([, v]) => v !== undefined));
  const session = draftSession(await uiEnv(actor, row, env));
  return session.open({ tool: blocker.fix[0], values: carry, companyId: row.companyId });
}

/**
 * POST /assistant/drafts/:id/refresh — an expired draft (what it acts on changed after its card was
 * shown) rebuilt: a new draft with the same values, checked again now; a fresh card when still ready.
 */
export async function refreshDraft(actor, draftId, env = {}) {
  const row = await loadOwnDraft(actor, draftId);
  if (row.status !== "expired") throw new AppError(`This draft is ${row.status}; nothing to refresh.`, 409);
  const fields = Object.fromEntries(Object.entries(row.fields || {}).filter(([, f]) => f.value !== undefined).map(([k, f]) => [k, { ...f, error: undefined }]));
  const fresh = await prisma.assistantDraft.create({
    data: { conversationId: row.conversationId, ownerType: row.ownerType, ownerId: row.ownerId, companyId: row.companyId, tool: row.tool, fields, missing: [], blockedBy: [], status: "collecting", messageIds: row.messageIds ?? undefined, expiresAt: new Date(Date.now() + DRAFT_TTL_MS) },
  });
  await auditDraft({}, fresh, "draft_status", { from: null, to: "collecting", refreshedFrom: row.id });
  return step(fresh, specFor(row.tool), { by: "user" }, await uiEnv(actor, row, env));
}

/** POST /assistant/drafts/:id/cancel */
export async function cancelDraft(actor, draftId) {
  const row = await loadOwnDraft(actor, draftId);
  if (!OPEN.includes(row.status)) throw new AppError(`This draft is already ${row.status}.`, 409);
  const { cancelPending } = await import("../actions.js");
  if (row.actionId) await cancelPending(actor, row.actionId, "the draft was cancelled");
  const updated = await prisma.assistantDraft.update({ where: { id: row.id }, data: { status: "cancelled" } });
  await auditDraft({}, updated, "draft_status", { from: row.status, to: "cancelled", by: "user" });
  return draftView(updated);
}

/** Every draft of a conversation (the chat's cards and its pending list), with each one's AI cost so far. */
export async function conversationDrafts(actor, conversationId) {
  const rows = await prisma.assistantDraft.findMany({ where: { conversationId, ownerType: actor.kind, ownerId: actor.id }, orderBy: { createdAt: "asc" }, take: 100 });
  const out = [];
  for (const r of rows) {
    const row = await expireIfStale(r, actor);
    const ids = Array.isArray(row.messageIds) ? row.messageIds : [];
    const calls = ids.length ? await prisma.aiCall.findMany({ where: { entityType: "assistant_conversation", entityId: conversationId, OR: [{ meta: { path: ["draftId"], equals: row.id } }, ...ids.map((id) => ({ meta: { path: ["messageId"], equals: id } }))] }, select: { costUsd: true } }) : [];
    out.push({ ...(await draftView(row)), aiCalls: calls.length, costUsd: calls.length && calls.every((c) => c.costUsd !== null) ? calls.reduce((n, c) => n + Number(c.costUsd), 0) : null });
  }
  return out;
}

// ── Run (actions.approveAction) ─────────────────────────────────────────────
/** The ready draft behind a card, checked: still ready, still this card, same args, nothing it acts on changed. */
export async function draftForRun(actor, action) {
  if (!action.draftId) throw new AppError("This card wasn't made from a ready draft, so it won't run. Ask again.", 409);
  let row = await loadOwnDraft(actor, action.draftId);
  row = await expireIfStale(row, actor);
  if (row.status === "expired") throw new AppError(`The draft expired (${row.error?.replace(/^Expired: /, "") || "24 hours"}). Ask again.`, 410);
  if (row.status !== "ready" || row.actionId !== action.id) throw new AppError(`The draft behind this card is ${row.status === "ready" ? "on a newer card" : row.status}, so this card won't run.`, 409);
  const { argsHashOf } = await import("../actions.js");
  const vals = Object.fromEntries(Object.entries(row.fields || {}).filter(([, f]) => f.value !== undefined).map(([k, f]) => [k, f.value]));
  const parsed = specFor(row.tool).tool.args.safeParse(vals);
  if (!parsed.success || argsHashOf({ tool: row.tool, companyId: row.companyId, args: parsed.data }) !== action.argsHash || row.argsHash !== action.argsHash) {
    throw new AppError("The draft's values changed after the card was shown, so it won't run. Ask again.", 409);
  }
  return row;
}

/** Run pressed and claimed: the draft is confirmed (and executed / back to collecting after). */
export const markConfirmed = (row) => prisma.assistantDraft.update({ where: { id: row.id }, data: { status: "confirmed" } }).then((u) => auditDraft({}, u, "draft_status", { from: "ready", to: "confirmed" }));

export async function markExecuted(row, result) {
  const u = await prisma.assistantDraft.update({ where: { id: row.id }, data: { status: "executed", result: result ?? undefined, error: null } });
  await auditDraft({}, u, "draft_status", { from: "confirmed", to: "executed" });
}

/** The API refused: the error goes back to the field(s) it concerns; the draft collects again. */
export async function markFailed(row, message) {
  const spec = specFor(row.tool);
  const names = fieldsOfError(spec, message);
  const fields = { ...(row.fields || {}) };
  for (const n of names) if (fields[n]) fields[n] = { ...fields[n], error: message };
  const missing = [...new Set([...(Array.isArray(row.missing) ? row.missing : []), ...names])];
  const u = await prisma.assistantDraft.update({ where: { id: row.id }, data: { status: "collecting", fields, missing, error: String(message).slice(0, 1000), actionId: null, argsHash: null, watch: null, expiresAt: new Date(Date.now() + DRAFT_TTL_MS) } });
  await auditDraft({}, u, "draft_status", { from: "confirmed", to: "collecting", fields: names }, String(message).slice(0, 500));
  return names;
}

/** A card cancelled by the person (or replaced by an edit): its draft is cancelled with it. */
export async function draftCardCancelled(action) {
  if (!action.draftId) return;
  const row = await prisma.assistantDraft.findUnique({ where: { id: action.draftId } });
  if (!row || row.actionId !== action.id || !OPEN.includes(row.status)) return;
  const u = await prisma.assistantDraft.update({ where: { id: row.id }, data: { status: "cancelled" } });
  await auditDraft({}, u, "draft_status", { from: row.status, to: "cancelled", by: "card" });
}
