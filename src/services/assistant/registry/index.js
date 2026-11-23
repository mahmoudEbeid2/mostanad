// Loads every tool definition once, then re-exports the registry API.
import "./tools/products.js";
import "./tools/catalogues.js";
import "./tools/certificates.js";
import "./tools/labels.js";
import "./tools/organisation.js";
import "./tools/actions.js";
import "./tools/productCopy.js";
import "./tools/drafts.js"; // after the write tools: start_draft lists them

export * from "./registry.js";
export { PROTECTED_KEY, assertVerbatim } from "./tools/actions.js";
export { mayUse, ToolError } from "./access.js";
