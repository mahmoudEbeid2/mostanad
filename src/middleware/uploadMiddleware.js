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

const logoFileFilter = (req, file, cb) => {
  const allowedMimeTypes = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError("Only image files (PNG, JPEG, WebP) are allowed for logos!", 400), false);
  }
};

export const uploadLogo = multer({
  storage: storage,
  fileFilter: logoFileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit for logos
  },
});

const designFileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    "application/pdf",
    "application/illustrator",
    "application/postscript",
    "application/x-adobe-illustrator",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/svg+xml"
  ];
  if (allowedMimeTypes.includes(file.mimetype) || file.originalname.toLowerCase().endsWith(".ai") || file.originalname.toLowerCase().endsWith(".svg")) {
    cb(null, true);
  } else {
    cb(new AppError("Only design files (PDF, AI, SVG, PNG, JPEG, WebP) are allowed!", 400), false);
  }
};

export const uploadDesign = multer({
  storage: storage, // using disk storage for background processing is better but we'll adapt templateController
  fileFilter: designFileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit for big design files
  },
});
