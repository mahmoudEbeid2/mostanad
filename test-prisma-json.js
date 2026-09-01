import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function test() {
  const labelId = (await prisma.generatedLabel.findFirst()).id;
  try {
    await prisma.labelVersion.create({
      data: {
        labelId,
        versionNumber: 999,
        changeSource: "ai_chat_edit",
        labelData: { name: "test", someUndefinedField: undefined }
      }
    });
  } catch (err) {
    console.log("ERROR MESSAGE:");
    console.log(err.message);
  }
}
test().finally(() => process.exit(0));

