import { prisma } from "./src/lib/prisma.js";

async function test() {
  console.log("Connecting...");
  const label = await prisma.generatedLabel.findFirst();
  if (!label) {
     console.log("No label found!");
     return;
  }
  const labelId = label.id;
  const message = `Fix _localized_text: Fields whose "primary" language is missing from "translations": productName`;

  // Simulate saveMessage inside invalid patch scenario
  const patch = { rationale: "Fix translations", changes: [{ path: "_localized_text", op: "replace", value: "fixed" }] };
  const dryRunErrors = [`Unknown path "_localized_text" - not a field in labelSchema.`];
  
  try {
    await prisma.labelChatMessage.create({
      data: {
        labelId: labelId,
        role: "user",
        content: message,
        intent: "edit",
        userId: null,
        proposedPatch: patch,
        conflicts: { errors: dryRunErrors },
      }
    });
    console.log("Success! No Prisma validation error.");
  } catch (err) {
    console.error("PRISMA ERROR:", err.name);
    console.error(err.message);
  }
}
test().finally(() => process.exit(0));

