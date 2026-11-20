import { companyMayUse } from "../../../middleware/authMiddleware.js";

// Who the assistant is acting for, and which company a tool call runs against.
// actor: { kind: "company"|"user", id, name, companyId? (company sessions),
//          permissions: string[] | null }  — null only for the test bypass,
//          which restrictToPermission also lets through everything.

export class ToolError extends Error {
  constructor(message, code = "tool_error") {
    super(message);
    this.code = code;
  }
}

/** The rule restrictToPermission applies, for one permission slug. */
export function mayUse(actor, slug) {
  if (!actor) return false;
  if (actor.kind === "company") return companyMayUse(slug);
  if (actor.permissions === null) return true;
  return (actor.permissions || []).includes(slug);
}

/**
 * The company one tool call runs against: a company session → always its own
 * (any companyId the model sent is ignored); a system user → the companyId arg
 * when it names an existing company, else the conversation's scope (null = all).
 */
export async function resolveCompany(tool, args, ctx) {
  const { actor } = ctx;
  let companyId;
  if (actor.kind === "company") {
    companyId = actor.companyId;
  } else if (tool.companyArg && args.companyId) {
    if (typeof args.companyId !== "string" || !(await (ctx.companyExists || (async () => false))(args.companyId))) {
      throw new ToolError("Company not found. Use list_companies to get a company id.", "company_not_found");
    }
    companyId = args.companyId;
  } else {
    companyId = ctx.scope?.companyId ?? null;
  }
  if (tool.needsCompany && !companyId) {
    throw new ToolError("This needs one company: ask the user which company (or pass companyId from list_companies).", "company_required");
  }
  return companyId;
}
