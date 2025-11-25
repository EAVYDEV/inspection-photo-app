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

// Ensure base folders exist
for (const dir of [UPLOAD_BASE, ARCHIVE_FOLDER]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Basic middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the frontend from /public
app.use(express.static(path.join(__dirname, "public")));

// Serve archived image files
app.use("/files", express.static(ARCHIVE_FOLDER));

// Multer in-memory storage – we write the files ourselves into /archive/<id>/
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024 // 20 MB per image
  }
});

/**
 * POST /upload
 * Expects form-data fields:
 *   - original: original image
 *   - corrected: deskewed / processed image
 */
app.post(
  "/upload",
  upload.fields([
    { name: "original", maxCount: 1 },
    { name: "corrected", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const originalFile = req.files?.original?.[0];
      const correctedFile = req.files?.corrected?.[0];

      if (!originalFile || !correctedFile) {
        return res.status(400).json({
          error: "Both 'original' and 'corrected' images are required."
        });
      }

      const id = Date.now().toString();
      const pairDir = path.join(ARCHIVE_FOLDER, id);
      await fs.promises.mkdir(pairDir, { recursive: true });

      const originalPath = path.join(pairDir, "original.jpg");
      const correctedPath = path.join(pairDir, "corrected.jpg");

      await fs.promises.writeFile(originalPath, originalFile.buffer);
      await fs.promises.writeFile(correctedPath, correctedFile.buffer);

      const [originalStat, correctedStat] = await Promise.all([
        fs.promises.stat(originalPath),
        fs.promises.stat(correctedPath)
      ]);

      return res.json({
        success: true,
        id,
        originalUrl: `/files/${id}/original.jpg`,
        correctedUrl: `/files/${id}/corrected.jpg`,
        originalSize: originalStat.size,
        correctedSize: correctedStat.size
      });
    } catch (err) {
      console.error("Upload error:", err);
      return res.status(500).json({ error: "Failed to save images." });
    }
  }
);

/**
 * GET /photos
 * Returns list of all saved pairs in /archive
 */
app.get("/photos", async (req, res) => {
  try {
    if (!fs.existsSync(ARCHIVE_FOLDER)) {
      return res.json([]);
    }

    const entries = await fs.promises.readdir(ARCHIVE_FOLDER, {
      withFileTypes: true
    });

    const items = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const id = entry.name;
      const pairDir = path.join(ARCHIVE_FOLDER, id);
      const originalPath = path.join(pairDir, "original.jpg");
      const correctedPath = path.join(pairDir, "corrected.jpg");

      if (!fs.existsSync(originalPath) || !fs.existsSync(correctedPath)) {
        continue;
      }

      const [originalStat, correctedStat] = await Promise.all([
        fs.promises.stat(originalPath),
        fs.promises.stat(correctedPath)
      ]);

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

    return res.json(items);
  } catch (err) {
    console.error("Error reading photo archive:", err);
    return res.status(500).json({ error: "Failed to read photo archive." });
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
