import multer from "multer";
import AppError from "../utils/appError.js";

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (file.mimetype === "application/pdf") {
    cb(null, true);
  } else {
    cb(new AppError("Only PDF files are allowed!", 400), false);
  }
};

export const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB limit
  },
});

const labelFileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp"
  ];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError("Only PDF and image files (PNG, JPEG, WebP) are allowed!", 400), false);
  }
};

export const uploadLabel = multer({
  storage: storage,
  fileFilter: labelFileFilter,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB limit
  },
});
