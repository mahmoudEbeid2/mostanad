import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function test() {
  const labelId = (await prisma.generatedLabel.findFirst()).id;
  const message = `Fix _localized_text: Fields whose "primary" language is missing from "translations": productName`;

  try {
    const { chat } = await import("./src/services/label/generatedLabelService.js");
    await chat(labelId, { message, expectedVersion: 1, userId: "admin" });
    console.log("Success");
  } catch (err) {
    console.error("ERROR CAUGHT:");
    console.error(err);
  }
}
test().finally(() => prisma.$disconnect());

