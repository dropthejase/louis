/**
 * Multer-based file-upload middleware for the backend Express app.
 *
 * Files are held in memory (never written to disk) and capped at 100 MB.
 * Returns HTTP 413 with a human-readable message when the limit is exceeded.
 */
import type { RequestHandler } from "express";
import multer from "multer";

export const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_SIZE_MB = Math.round(
  MAX_UPLOAD_SIZE_BYTES / (1024 * 1024),
);

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_SIZE_BYTES,
    files: 1,
  },
});

/**
 * Express middleware that parses a single multipart file upload from the
 * given form field name, storing the bytes in `req.file.buffer`.
 *
 * @param fieldName The multipart field name to read the file from.
 * Returns 400 on multer errors, 413 when the file exceeds MAX_UPLOAD_SIZE_BYTES.
 */
export function singleFileUpload(fieldName: string): RequestHandler {
  return (req, res, next) => {
    memoryUpload.single(fieldName)(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return void res.status(413).json({
            detail: `File too large. Maximum size is ${MAX_UPLOAD_SIZE_MB} MB.`,
          });
        }
        return void res.status(400).json({
          detail: `Upload failed: ${err.message}`,
        });
      }

      return next(err);
    });
  };
}
