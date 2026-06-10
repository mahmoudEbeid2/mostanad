import AppError from "../utils/appError.js";

/**
 * Express middleware to validate request using Zod schemas.
 * Can take a single Zod schema (validates req.body) or an object containing body, query, and/or params schemas.
 * 
 * @param {object} schemas - Zod schema or object containing { body, query, params }
 */
export const validate = (schemas) => (req, res, next) => {
  try {
    // 1. If schemas is a direct Zod schema (safeParse is a function)
    if (schemas && typeof schemas.safeParse === "function") {
      const result = schemas.safeParse(req.body);
      if (!result.success) {
        const message = result.error.issues
          .map((err) => `${err.path.join(".")}: ${err.message}`)
          .join(", ");
        return next(new AppError(`Validation error: ${message}`, 400));
      }
      req.body = result.data;
      return next();
    }

    // 2. If schemas is an object specifying validation for body, query, and/or params
    if (schemas && typeof schemas === "object") {
      const targets = ["body", "query", "params"];
      for (const target of targets) {
        if (schemas[target]) {
          const result = schemas[target].safeParse(req[target]);
          if (!result.success) {
            const message = result.error.issues
              .map((err) => `${err.path.join(".")}: ${err.message}`)
              .join(", ");
            return next(new AppError(`Validation error in ${target}: ${message}`, 400));
          }
          req[target] = result.data;
        }
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};
