import express from "express";
import routes from "./routes/index.js";

const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Use the defined routes
app.use("/api/v1", routes);

export default app;
