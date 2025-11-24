// server.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const app = express();

// Detect when running on Vercel
const isVercel = !!process.env.VERCEL;

// Use /tmp on Vercel (writable but NOT permanent), local "uploads" when running on your Mac
const UPLOAD_BASE = isVercel
  ? path.join("/tmp", "uploads")
  : path.join(__dirname, "uploads");

const ARCHIVE_FOLDER = path.join(UPLOAD_BASE, "archive");

// Ensure folders exist
if (!fs.existsSync(UPLOAD_BASE)) {
  fs.mkdirSync(UPLOAD_BASE, { recursive: true });
}
if (!fs.existsSync(ARCHIVE_FOLDER)) {
  fs.mkdirSync(ARCHIVE_FOLDER, { recursive: true });
}

// Multer in-memory storage; we write the files ourselves
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max per file
});

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

// Serve archived files so the gallery can display them
app.use("/files", express.static(ARCHIVE_FOLDER));

/**
 * POST /upload
 * Accepts two files:
 *  - original: raw capture (full resolution, before rotation/compress)
 *  - corrected: rotated + compressed image
 *
 * Saves each pair into: ARCHIVE_FOLDER/<timestamp>/original.jpg + corrected.jpg
 */
app.post(
  "/upload",
  upload.fields([
    { name: "original", maxCount: 1 },
    { name: "corrected", maxCount: 1 }
  ]),
  (req, res) => {
    try {
      const originalFile = req.files["original"]?.[0];
      const correctedFile = req.files["corrected"]?.[0];

      if (!originalFile || !correctedFile) {
        return res.status(400).json({
          error: "Both 'original' and 'corrected' files are required."
        });
      }

      const timestamp = Date.now().toString();
      const photoDir = path.join(ARCHIVE_FOLDER, timestamp);
      fs.mkdirSync(photoDir, { recursive: true });

      const originalFileName = "original.jpg";
      const correctedFileName = "corrected.jpg";

      const originalPath = path.join(photoDir, originalFileName);
      const correctedPath = path.join(photoDir, correctedFileName);

      fs.writeFileSync(originalPath, originalFile.buffer);
      fs.writeFileSync(correctedPath, correctedFile.buffer);

      console.log(`Saved pair to: ${photoDir}`);

      const originalSize = originalFile.size;
      const correctedSize = correctedFile.size;

      res.json({
        id: timestamp,
        originalUrl: `/files/${timestamp}/${originalFileName}`,
        correctedUrl: `/files/${timestamp}/${correctedFileName}`,
        originalSize,
        correctedSize
      });
    } catch (err) {
      console.error("Upload error:", err);
      res.status(500).json({ error: "Server error while saving files." });
    }
  }
);

/**
 * GET /photos
 * Returns all archived photo pairs and their file sizes.
 */
app.get("/photos", (req, res) => {
  try {
    const items = [];

    if (!fs.existsSync(ARCHIVE_FOLDER)) {
      return res.json(items);
    }

    const entries = fs.readdirSync(ARCHIVE_FOLDER, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const id = entry.name;
      const dirPath = path.join(ARCHIVE_FOLDER, id);
      const originalPath = path.join(dirPath, "original.jpg");
      const correctedPath = path.join(dirPath, "corrected.jpg");

      if (!fs.existsSync(originalPath) || !fs.existsSync(correctedPath)) {
        continue;
      }

      const originalStat = fs.statSync(originalPath);
      const correctedStat = fs.statSync(correctedPath);

      items.push({
        id,
        originalUrl: `/files/${id}/original.jpg`,
        correctedUrl: `/files/${id}/corrected.jpg`,
        originalSize: originalStat.size,
        correctedSize: correctedStat.size
      });
    }

    // Newest first
    items.sort((a, b) => Number(b.id) - Number(a.id));

    res.json(items);
  } catch (err) {
    console.error("Error reading photos:", err);
    res.status(500).json({ error: "Failed to read photo archive." });
  }
});

// Local dev: start server normally
if (!isVercel) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Local server listening on http://localhost:${PORT}`);
  });
}

// Vercel: export the app for serverless
module.exports = app;
