// Certificates V2 Phase 0 — permission-name parsing.
// Pure unit test: drives restrictToPermission directly with a fake company
// request (no bypass headers, NODE_ENV forced off "test"), so it exercises the
// real allowlist path. No server or DB needed.
process.env.NODE_ENV = "development";

const { restrictToPermission, permissionModule, COMPANY_ALLOWED_MODULES } = await import(
  "../src/middleware/authMiddleware.js"
);
const { permissions } = await import("../prisma/seed.js");

let passed = 0;
let failed = 0;
function assert(label, condition, details = "") {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}${details ? `\n     → ${details}` : ""}`);
    failed++;
  }
}

// Runs the middleware; resolves to null (allowed) or the AppError passed to next.
function run(slug, req) {
  let outcome;
  restrictToPermission(slug)(req, {}, (err) => {
    outcome = err || null;
  });
  return outcome;
}

const companyReq = () => ({
  headers: {},
  company: { id: "c1", name: "Co", isActive: true },
  user: { id: "c1", name: "Co", role: "company" },
});
const systemReq = (slugs) => ({
  headers: {},
  user: { id: "u1", role: { name: "staff", permissions: slugs.map((slug) => ({ permission: { slug } })) } },
});

console.log("\n🧪 Permission parsing (permissionModule)");
assert("single-word module", permissionModule("read_products") === "products");
assert("two-word module", permissionModule("create_certificate_templates") === "certificate_templates");
assert("two-word module (types)", permissionModule("delete_certificate_types") === "certificate_types");
assert("three-word module", permissionModule("publish_global_reference") === "global_reference");
assert("no underscore → empty", permissionModule("admin") === "");
assert(
  "create_certificate_templates does NOT resolve to 'certificate'",
  permissionModule("create_certificate_templates") !== "certificate"
);

console.log("\n🧪 Every seeded slug: module column == parsed module, or is a deliberate exception");
// Slugs whose seeded `module` intentionally differs from the parsed name.
const KNOWN_ALIASES = {
  publish_global_reference: "global", // Invariant #13 — never company-grantable
  export_certificates: "certificates", // reuses the certificates module
};
for (const p of permissions) {
  const parsed = permissionModule(p.slug);
  const expected = KNOWN_ALIASES[p.slug] ? p.slug.slice(p.slug.indexOf("_") + 1) : p.module;
  assert(`${p.slug} → ${parsed}`, parsed === expected, `seed module=${p.module}`);
}

console.log("\n🧪 Company caller: every Certificates V2 permission is allowed");
const v2Slugs = permissions
  .map((p) => p.slug)
  .filter((s) => /_(certificate_types|certificate_templates|invoices)$/.test(s) || s === "export_certificates");
assert("seed has 13 V2 permissions", v2Slugs.length === 13, v2Slugs.join(","));
for (const slug of v2Slugs) {
  const err = run(slug, companyReq());
  assert(`company allowed: ${slug}`, err === null, err?.message);
}

console.log("\n🧪 Company caller: existing allowed modules unchanged");
for (const slug of ["read_products", "create_templates", "create_certificates", "update_labels", "read_regulatory"]) {
  assert(`company allowed: ${slug}`, run(slug, companyReq()) === null);
}

console.log("\n🧪 Company caller: non-company modules still blocked (403)");
for (const slug of [
  "create_users",
  "read_roles",
  "delete_eda_requirements",
  "publish_global_reference",
  "approve_assurance",
  // Prefix tricks must not slip through: the module must match exactly.
  "create_certificate",
  "create_certificate_templates_admin",
  "create_invoices_global",
]) {
  const err = run(slug, companyReq());
  assert(`company blocked: ${slug}`, err?.statusCode === 403, err ? `${err.statusCode}` : "allowed");
}
assert("allowlist has no single-word prefix of a V2 module", !COMPANY_ALLOWED_MODULES.includes("certificate"));

console.log("\n🧪 System user: exact slug match only");
assert(
  "system user with the slug is allowed",
  run("create_certificate_templates", systemReq(["create_certificate_templates"])) === null
);
assert(
  "system user without the slug is blocked",
  run("create_certificate_templates", systemReq(["create_certificates"]))?.statusCode === 403
);

console.log(`\n📊 RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total\n`);
process.exit(failed > 0 ? 1 : 0);
