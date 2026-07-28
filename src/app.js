import express from "express";
import "./workers/referenceLabelWorker.js";
import "./workers/productAiWorker.js";
import cors from "cors";
import path from "path";
import routes from "./routes/index.js";
import globalErrorHandler from "./middleware/errorMiddleware.js";
import AppError from "./utils/appError.js";

const app = express();

// Enable CORS for all routes
app.use(cors());

// Middleware to parse JSON bodies with increased payload limit for base64 files
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Serve static uploaded files
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// Use the defined routes
app.use("/api/v1", routes);

// Handle undefined routes
app.use((req, res, next) => {
  next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});

// Global error handling middleware
app.use(globalErrorHandler);

export default app;
