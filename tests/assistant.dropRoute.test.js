// QA 27 Nov (re-test), item 1: files + "شهادات ADDVET" went to template creation while
// "طلّعلي كل الشهادات من الملفات دي" went to Express. A drop's route is decided by code.
// Pure: no database, no model.
import { expressDrop, templateToolsAllowed } from "../src/services/assistant/agent/dropRoute.js";

let failed = 0;
const assert = (label, ok, details = "") => {
  console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"}: ${label}${ok || details === "" ? "" : `\n     → ${JSON.stringify(details)}`}`);
  if (!ok) failed++;
};
const withFiles = { attachments: [{ id: "a" }, { id: "b" }] };
const noFiles = { attachments: [] };

for (const text of ["شهادات ADDVET", "📎 الملفات دي", "طلّعلي كل الشهادات من الملفات دي", "دي شهادات maxvet", "COA و FSC لـ ADDVET", "certificates for ADDVET", "خد دول", "ADDVET"]) {
  assert(`"${text}" + files → Express`, !!expressDrop(text, withFiles));
}
assert("the types named in the message are kept", JSON.stringify(expressDrop("شهادات COA و FSC لـ ADDVET", withFiles)?.certificateTypes) === JSON.stringify(["COA", "FSC"]));
for (const text of ["اعمل قالب من الشهادات دي", "اعملهم قوالب", "use these as templates", "افحص الليبل ده", "غيّر مقاس الليبل", "دا كتالوج ADDVET", "سجّل الملفات بس"]) {
  assert(`"${text}" + files → not Express by code`, expressDrop(text, withFiles) === null);
}
assert("no files → no route", expressDrop("شهادات ADDVET", noFiles) === null);
assert("an [action …] event → no route", expressDrop("شهادات ADDVET", { ...withFiles, isEvent: true }) === null);
assert("a long message goes to the model", expressDrop("عايز أعرف إيه الفرق بين الشهادات اللي بعتها المرة اللي فاتت والمرة دي وليه الأرقام مختلفة", withFiles) === null);
assert("files without template words → template tools not offered", templateToolsAllowed("شهادات ADDVET", withFiles) === false);
assert("files + «اعمل قالب» → template tools offered", templateToolsAllowed("اعمل قالب", withFiles) === true);
assert("no files → template tools offered", templateToolsAllowed("شهادات ADDVET", noFiles) === true);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
