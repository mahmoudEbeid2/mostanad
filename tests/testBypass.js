import fs from "fs";
import path from "path";

// The test auth-bypass secret (src/middleware/testBypass.js). `npm run dev:test`
// generates it per start and writes it to the gitignored .test-bypass-secret;
// tests send it as the `x-test-bypass` header. Never hardcoded.
const FILE = path.resolve(process.cwd(), ".test-bypass-secret");

export function readBypassSecret() {
  if (process.env.TEST_BYPASS_SECRET) return process.env.TEST_BYPASS_SECRET;
  try {
    return fs.readFileSync(FILE, "utf8").trim();
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

export const BYPASS = readBypassSecret();
