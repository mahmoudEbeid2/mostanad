import { Prisma } from "@prisma/client";
import AppError from "../utils/appError.js";

const handlePrismaUniqueConstraintError = (err) => {
  const fields = err.meta?.target || [];
  const message = `Duplicate field value: ${fields.join(", ")}. Please use another value!`;
  return new AppError(message, 400);
};

const handlePrismaRecordNotFoundError = (err) => {
  const message = err.meta?.cause || "Record not found!";
  return new AppError(message, 404);
};

const handlePrismaForeignKeyConstraintError = (err) => {
  const field = err.meta?.field_name || "";
  const message = `Invalid relation constraint on field: ${field}. Referenced record does not exist.`;
  return new AppError(message, 400);
};

const handlePrismaValidationError = (err) => {
  const message = `Invalid database input data. Check your fields schema.`;
  return new AppError(message, 400);
};

const sendErrorDev = (err, res) => {
  res.status(err.statusCode).json({
    status: err.status,
    error: err,
    message: err.message,
    stack: err.stack,
  });
};

const sendErrorProd = (err, res) => {
  if (err.isOperational) {
    // Operational, trusted error: send message to client
    res.status(err.statusCode).json({
      status: err.status,
      message: err.message,
    });
  } else {
    // Programming or other unknown error: don't leak error details
    console.error("ERROR 💥", err.stack || err);
    res.status(500).json({
      status: "error",
      message: "Something went very wrong!",
    });
  }
};

const globalErrorHandler = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || "error";

  if (process.env.NODE_ENV === "development") {
    sendErrorDev(err, res);
  } else {
    let error = Object.assign(Object.create(Object.getPrototypeOf(err)), err);
    error.message = err.message;
    error.statusCode = err.statusCode;
    error.status = err.status;
    error.stack = err.stack;

    // Prisma Known Request Errors
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2002") error = handlePrismaUniqueConstraintError(err);
      if (err.code === "P2025") error = handlePrismaRecordNotFoundError(err);
      if (err.code === "P2003") error = handlePrismaForeignKeyConstraintError(err);
    }
    // Prisma Validation Errors
    if (err instanceof Prisma.PrismaClientValidationError) {
      error = handlePrismaValidationError(err);
    }

    sendErrorProd(error, res);
  }
};

export default globalErrorHandler;
