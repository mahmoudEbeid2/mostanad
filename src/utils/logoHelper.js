import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Saves a logo buffer to the corresponding uploads folder.
 * @param {Buffer} buffer - File buffer
 * @param {string} folderName - Folder name ("companies" or "brands")
 * @param {string} originalName - Original file name for extracting extension
 * @returns {string} The relative path to the saved logo file
 */
export const saveLogo = (buffer, folderName, originalName) => {
  const uploadDir = path.join(process.cwd(), "uploads", folderName);
  
  // Ensure the folder exists
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const ext = path.extname(originalName) || ".png";
  const fileName = `${crypto.randomUUID()}${ext}`;
  const filePath = path.join(uploadDir, fileName);

  fs.writeFileSync(filePath, buffer);

  // Return the relative path
  return `uploads/${folderName}/${fileName}`;
};

/**
 * Deletes a logo file if it exists
 * @param {string} relativePath - The relative path of the logo to delete
 */
export const deleteLogo = (relativePath) => {
  if (!relativePath) return;
  const filePath = path.join(process.cwd(), relativePath);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      console.log(`[LogoHelper] Deleted logo at: ${filePath}`);
    } catch (err) {
      console.error(`[LogoHelper] Failed to delete logo: ${filePath}`, err.message);
    }
  }
};
