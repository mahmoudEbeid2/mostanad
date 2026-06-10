import express from "express";
import routes from "./routes/index.js";
import globalErrorHandler from "./middleware/errorMiddleware.js";
import AppError from "./utils/appError.js";

const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Use the defined routes
app.use("/api/v1", routes);

// Handle undefined routes
app.use((req, res, next) => {
  next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});

// Global error handling middleware
app.use(globalErrorHandler);

export default app;
