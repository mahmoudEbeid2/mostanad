import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import geminiClient from "./ai/geminiClient.js";
import { PrismaFeatures } from "../utils/PrismaFeatures.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

export const processAndCreate = async (file, body) => {
  const { title, country = "Egypt" } = body;
  
  if (!file) throw new AppError("Document file is required", 400);
  if (!title) throw new AppError("Title is required", 400);

  let rawText = "";

  // 1. Local Extraction
  if (file.mimetype === "application/pdf") {
    const pdfData = await pdfParse(file.buffer);
    rawText = pdfData.text;
  } else if (file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || file.originalname.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    rawText = result.value;
  } else {
    throw new AppError("Only PDF and DOCX files are supported", 400);
  }

  if (!rawText || rawText.trim().length === 0) {
    throw new AppError("Could not extract any text from the document", 400);
  }

  // 2. AI Structuring
  const systemInstruction = `You are a highly capable regulatory affairs assistant analyzing Egyptian Drug Authority (EDA) documents or other regulatory requirements.`;
  
  const schema = {
    type: "array",
    description: "An array of structured requirement sections.",
    items: {
      type: "object",
      properties: {
        section: { type: "string", description: "The title of the section or category (e.g., General Conditions, Required Documents, Formatting Rules)." },
        content: { type: "string", description: "The detailed extracted rules or text belonging to this section." }
      },
      required: ["section", "content"]
    }
  };

  const prompt = `Please carefully read the following extracted regulatory document text. Structure and categorize all the rules, conditions, and requirements into logical sections. Do not leave out any important conditions. Ensure the text is clean and professional.\n\nDOCUMENT TEXT:\n${rawText.substring(0, 50000)}`;

  let extractedData;
  try {
    extractedData = await geminiClient.generateJson({
      model: "gemini-2.5-flash",
      contents: [prompt],
      systemInstruction,
      schema
    });
  } catch (error) {
    throw new AppError("Failed to process document with AI: " + error.message, 500);
  }

  // 3. Save to Database
  const requirement = await prisma.edaRequirement.create({
    data: {
      title,
      country,
      extractedText: rawText.substring(0, 10000),
      extractedData,
    }
  });

  return requirement;
};

export const getAll = async (queryString) => {
  // Extract companyId if it exists in query string to filter explicitly
  // PrismaFeatures handles standard equality filters automatically if we pass it in query
  const features = new PrismaFeatures(prisma.edaRequirement, queryString)
    .filter()
    .sort()
    .paginate();

  const { data: requirements, meta } = await features.exec();

  return { requirements, total: meta.total };
};

export const update = async (id, data) => {
  return await prisma.edaRequirement.update({
    where: { id },
    data,
  });
};

export const remove = async (id) => {
  const req = await prisma.edaRequirement.findUnique({ where: { id } });
  if (!req) throw new AppError("Requirement not found", 404);
  
  await prisma.edaRequirement.delete({ where: { id } });
  return true;
};
