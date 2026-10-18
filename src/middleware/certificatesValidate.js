import AppError from "../utils/appError.js";

// Request validation for the Certificates V2 router. Same contract as
// validateMiddleware.validate, except `query`: Express 5 exposes req.query as
// a getter, so the parsed query is stored on req.validatedQuery instead of
// being assigned (assigning throws under strict-mode ESM).
export const validateRequest = (schemas) => (req, res, next) => {
  for (const target of ["params", "query", "body"]) {
    const schema = schemas[target];
    if (!schema) continue;
    const result = schema.safeParse(req[target] ?? {});
    if (!result.success) {
      const message = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
      return next(new AppError(`Validation error in ${target}: ${message}`, 400));
    }
    if (target === "query") req.validatedQuery = result.data;
    else req[target] = result.data;
  }
  next();
};
