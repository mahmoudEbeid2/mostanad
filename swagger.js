import swaggerUi from "swagger-ui-express";
import RefParser from "@apidevtools/json-schema-ref-parser";
import path from "path";

const rootSpecPath = path.resolve(process.cwd(), "src", "docs", "swagger.yaml");

// Resolve and bundle references on-the-fly
export const swaggerSpec = await RefParser.bundle(rootSpecPath);
export { swaggerUi };
