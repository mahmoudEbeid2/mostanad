import fs from "fs";
import path from "path";
import crypto from "crypto";

const tempDir = path.join(process.cwd(), "uploads", "temp_jobs");

// Ensure temp_jobs folder exists
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

/**
 * Saves a file buffer to the shared temp directory
 * @param {Buffer} buffer 
 * @param {string} originalName 
 * @returns {string} Absolute path to the saved file
 */
export const saveTempFile = (buffer, originalName) => {
  const ext = path.extname(originalName) || "";
  const randomName = `${crypto.randomUUID()}${ext}`;
  const filePath = path.join(tempDir, randomName);
  fs.writeFileSync(filePath, buffer);
  return filePath;
};

/**
 * Safely deletes a file if it exists
 * @param {string} filePath 
 */
export const deleteFile = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error(`[FileHelper] Failed to delete file: ${filePath}`, err.message);
    }
  }
};
