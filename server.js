// server.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

// Base uploads folder
const UPLOAD_BASE = path.join(__dirname, "uploads");
const ARCHIVE_FOLDER = path.join(UPLOAD_BASE, "archive");

// Ensure folders exist
if (!fs.existsSync(UPLOAD_BASE)) {
  fs.mkdirSync(UPLOAD_BASE);
}
if (!fs.existsSync(ARCHIVE_FOLDER)) {
  fs.mkdirSync(ARCHIVE_FOLDER, { recursive: true });
}

// Multer in-memory storage; we write the file ourselves
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// Serve static files
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
      folder: "archive",
      fileName
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Server error while saving file." });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
