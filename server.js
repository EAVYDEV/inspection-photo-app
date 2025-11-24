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

// Ensure folders exist (on Vercel this will create them under /tmp)
if (!fs.existsSync(UPLOAD_BASE)) {
  fs.mkdirSync(UPLOAD_BASE, { recursive: true });
}
if (!fs.existsSync(ARCHIVE_FOLDER)) {
  fs.mkdirSync(ARCHIVE_FOLDER, { recursive: true });
}

// Multer in-memory storage; we write the file ourselves
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// Serve static frontend from /public
app.use(express.static(path.join(__dirname, "public")));

// Upload endpoint (Phase 1: no QR logic, just archive)
app.post("/upload", upload.single("photo"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No photo uploaded." });
    }

    const timestamp = Date.now();
    const fileName = `inspection_${timestamp}.jpg`;
    const filePath = path.join(ARCHIVE_FOLDER, fileName);

    fs.writeFileSync(filePath, req.file.buffer);

    console.log(`Saved photo to: ${filePath}`);

    res.json({
      message: "Photo archived successfully.",
      folder: isVercel ? "/tmp/uploads/archive" : "uploads/archive",
      fileName
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Server error while saving file." });
  }
});

// For local development, start the server normally.
// On Vercel (where process.env.VERCEL is set), we export the app instead
// and LET VERCEL handle the serverless function wrapper.
if (!isVercel) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Local server listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
