const startCameraBtn = document.getElementById("startCameraBtn");
const captureBtn = document.getElementById("captureBtn");
const saveBtn = document.getElementById("saveBtn");
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const statusEl = document.getElementById("status");

const navCapture = document.getElementById("navCapture");
const navGallery = document.getElementById("navGallery");
const captureView = document.getElementById("captureView");
const galleryView = document.getElementById("galleryView");
const refreshGalleryBtn = document.getElementById("refreshGalleryBtn");
const galleryStatusEl = document.getElementById("galleryStatus");
const photoTableBody = document.getElementById("photoTableBody");

// Upload controls
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const choosePhotoBtn = document.getElementById("choosePhotoBtn");

// Hidden raw canvas to hold original frame / uploaded image
const rawCanvas = document.createElement("canvas");
const rawCtx = rawCanvas.getContext("2d");

let stream = null;
let hasCapture = false;
let cvReady = false;

// Limit max size for compression (longest side)
const MAX_SIZE = 1600;

/* ---------- OpenCV runtime hook ---------- */

// opencv.js was loaded before this file, so cv should exist now.
if (window.cv) {
  cv["onRuntimeInitialized"] = () => {
    cvReady = true;
    console.log("OpenCV.js runtime initialized");
  };
}

/* ---------- STATUS HELPERS ---------- */

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = "status";
  if (type) statusEl.classList.add(type);
}

function setGalleryStatus(message, type = "") {
  galleryStatusEl.textContent = message;
  galleryStatusEl.className = "status";
  if (type) galleryStatusEl.classList.add(type);
}

/* ---------- NAV TABS ---------- */

function showCaptureView() {
  navCapture.classList.add("active");
  navGallery.classList.remove("active");
  captureView.style.display = "";
  galleryView.style.display = "none";
}

function showGalleryView() {
  navCapture.classList.remove("active");
  navGallery.classList.add("active");
  captureView.style.display = "none";
  galleryView.style.display = "";
  loadGallery();
}

navCapture.addEventListener("click", showCaptureView);
navGallery.addEventListener("click", showGalleryView);

/* ---------- CAMERA / CAPTURE ---------- */

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });

    video.srcObject = stream;
    captureBtn.disabled = false;
    setStatus("Camera started. Capture your inspection tag.", "success");
  } catch (err) {
    console.error("Camera error:", err);
    setStatus("Unable to access camera. Check permissions.", "error");
  }
}

function captureFrame() {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    setStatus("Video not ready yet. Try again.", "error");
    return false;
  }

  rawCanvas.width = width;
  rawCanvas.height = height;
  rawCtx.drawImage(video, 0, 0, width, height);

  hasCapture = true;
  saveBtn.disabled = false;

  runDeskewOrFallback();
  return true;
}

/* ---------- LOAD IMAGE FROM FILE (desktop & mobile) ---------- */

function loadImageFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("Please select an image file.", "error");
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      rawCanvas.width = img.width;
      rawCanvas.height = img.height;
      rawCtx.drawImage(img, 0, 0);
      hasCapture = true;
      saveBtn.disabled = false;
      runDeskewOrFallback();
      setStatus("Image loaded from device and processed.", "success");
    };
    img.onerror = () => {
      setStatus("Failed to load image.", "error");
    };
    img.src = reader.result;
  };
  reader.onerror = () => setStatus("Failed to read file.", "error");
  reader.readAsDataURL(file);
}

choosePhotoBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) loadImageFile(file);
});

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) loadImageFile(file);
});

/* ---------- DESKEW / PREVIEW ---------- */

function runDeskewOrFallback() {
  if (!cvReady || !window.cv) {
    basicCopyToPreview();
    setStatus(
      "Captured. OpenCV still initializing, showing uncorrected preview.",
      "error"
    );
    return;
  }

  try {
    autoDeskewWithOpenCV();
    setStatus(
      "Captured, perspective-corrected and converted to grayscale.",
      "success"
    );
  } catch (err) {
    console.error("Deskew error:", err);
    basicCopyToPreview();
    setStatus(
      "Captured, but auto-straighten failed. Showing uncorrected preview.",
      "error"
    );
  }
}

/* Simple fallback: just scale raw image into preview canvas */
function basicCopyToPreview() {
  const srcW = rawCanvas.width;
  const srcH = rawCanvas.height;
  let scale = 1;
  const longSide = Math.max(srcW, srcH);
  if (longSide > MAX_SIZE) {
    scale = MAX_SIZE / longSide;
  }
  const destW = Math.round(srcW * scale);
  const destH = Math.round(srcH * scale);

  canvas.width = destW;
  canvas.height = destH;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, destW, destH);
  ctx.drawImage(rawCanvas, 0, 0, destW, destH);
}

/* --- OpenCV-based automatic perspective correction & grayscale --- */

function autoDeskewWithOpenCV() {
  if (!cvReady || !window.cv) {
    throw new Error("OpenCV not ready");
  }

  let src = cv.imread(rawCanvas);
  let gray = new cv.Mat();
  let blur = new cv.Mat();
  let edges = new cv.Mat();
  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blur, edges, 75, 200);

    // Use external contours to avoid noise
    cv.findContours(
      edges,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE
    );

    let maxArea = 0;
    let bestQuad = null;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

      if (approx.rows === 4) {
        const area = cv.contourArea(approx, false);
        if (area > maxArea) {
          maxArea = area;
          if (bestQuad) bestQuad.delete();
          bestQuad = approx;
        } else {
          approx.delete();
        }
      } else {
        approx.delete();
      }
      cnt.delete();
    }

    if (!bestQuad || maxArea < src.rows * src.cols * 0.05) {
      throw new Error("No suitable quadrilateral found");
    }

    const pts = [];
    for (let i = 0; i < 4; i++) {
      pts.push({ x: bestQuad.intAt(i, 0), y: bestQuad.intAt(i, 1) });
    }

    const ordered = orderQuadPoints(pts);

    const widthTop = distance(ordered[0], ordered[1]);
    const widthBottom = distance(ordered[3], ordered[2]);
    const maxWidth = Math.max(widthTop, widthBottom);

    const heightLeft = distance(ordered[0], ordered[3]);
    const heightRight = distance(ordered[1], ordered[2]);
    const maxHeight = Math.max(heightLeft, heightRight);

    let destWidth = maxWidth;
    let destHeight = maxHeight;
    const longSide = Math.max(destWidth, destHeight);
    let scale = 1;
    if (longSide > MAX_SIZE) {
      scale = MAX_SIZE / longSide;
      destWidth *= scale;
      destHeight *= scale;
    }

    destWidth = Math.round(destWidth);
    destHeight = Math.round(destHeight);

    let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      ordered[0].x,
      ordered[0].y,
      ordered[1].x,
      ordered[1].y,
      ordered[2].x,
      ordered[2].y,
      ordered[3].x,
      ordered[3].y
    ]);

    let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0,
      0,
      destWidth - 1,
      0,
      destWidth - 1,
      destHeight - 1,
      0,
      destHeight - 1
    ]);

    let M = cv.getPerspectiveTransform(srcTri, dstTri);
    let warped = new cv.Mat();
    const dsize = new cv.Size(destWidth, destHeight);
    cv.warpPerspective(
      src,
      warped,
      M,
      dsize,
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar()
    );

    // Convert warped image to grayscale
    let warpedGray = new cv.Mat();
    let warpedGrayRgba = new cv.Mat();
    cv.cvtColor(warped, warpedGray, cv.COLOR_RGBA2GRAY, 0);
    cv.cvtColor(warpedGray, warpedGrayRgba, cv.COLOR_GRAY2RGBA, 0);

    // Draw to preview canvas
    cv.imshow(canvas, warpedGrayRgba);

    warped.delete();
    warpedGray.delete();
    warpedGrayRgba.delete();
    srcTri.delete();
    dstTri.delete();
    M.delete();
    bestQuad.delete();
  } finally {
    src.delete();
    gray.delete();
    blur.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
  }
}

function orderQuadPoints(pts) {
  const sum = pts.map((p) => p.x + p.y);
  const diff = pts.map((p) => p.y - p.x);

  const tl = pts[sum.indexOf(Math.min(...sum))];
  const br = pts[sum.indexOf(Math.max(...sum))];
  const tr = pts[diff.indexOf(Math.min(...diff))];
  const bl = pts[diff.indexOf(Math.max(...diff))];

  return [tl, tr, br, bl];
}

function distance(p1, p2) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/* ---------- SAVE / UPLOAD ---------- */

function canvasToBlob(canvasEl, type, quality) {
  return new Promise((resolve, reject) => {
    canvasEl.toBlob(
      (blob) => {
        if (!blob) return reject(new Error("Failed to create blob."));
        resolve(blob);
      },
      type,
      quality
    );
  });
}

async function savePhoto() {
  if (!hasCapture) {
    setStatus("Capture or upload a photo first.", "error");
    return;
  }

  setStatus("Compressing and uploading photos...");

  try {
    const originalBlob = await canvasToBlob(rawCanvas, "image/jpeg", 0.95);
    const correctedBlob = await canvasToBlob(canvas, "image/jpeg", 0.6);

    const formData = new FormData();
    formData.append("original", originalBlob, "original.jpg");
    formData.append("corrected", correctedBlob, "corrected.jpg");

    const res = await fetch("/upload", {
      method: "POST",
      body: formData
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      setStatus(
        "Upload failed: " + (errData.error || res.statusText),
        "error"
      );
      return;
    }

    const data = await res.json();
    setStatus(
      `Saved pair: original ${formatBytes(
        data.originalSize
      )}, corrected ${formatBytes(data.correctedSize)}.`,
      "success"
    );
  } catch (err) {
    console.error(err);
    setStatus("Upload error: " + err.message, "error");
  }
}

/* ---------- GALLERY ---------- */

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value = value / 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

async function loadGallery() {
  setGalleryStatus("Loading photos...");
  photoTableBody.innerHTML = "";

  try {
    const res = await fetch("/photos");
    if (!res.ok) {
      setGalleryStatus("Failed to load photos.", "error");
      return;
    }

    const items = await res.json();
    if (!items.length) {
      setGalleryStatus("No photos archived yet.", "success");
      return;
    }

    for (const item of items) {
      const tr = document.createElement("tr");

      const idTd = document.createElement("td");
      idTd.textContent = item.id;
      tr.appendChild(idTd);

      const originalTd = document.createElement("td");
      const origImg = document.createElement("img");
      origImg.src = item.originalUrl;
      origImg.alt = `Original ${item.id}`;
      const origSize = document.createElement("div");
      origSize.className = "size-text";
      origSize.textContent = formatBytes(item.originalSize);
      originalTd.appendChild(origImg);
      originalTd.appendChild(origSize);
      tr.appendChild(originalTd);

      const correctedTd = document.createElement("td");
      const corrImg = document.createElement("img");
      corrImg.src = item.correctedUrl;
      corrImg.alt = `Corrected ${item.id}`;
      const corrSize = document.createElement("div");
      corrSize.className = "size-text";
      corrSize.textContent = formatBytes(item.correctedSize);
      correctedTd.appendChild(corrImg);
      correctedTd.appendChild(corrSize);
      tr.appendChild(correctedTd);

      photoTableBody.appendChild(tr);
    }

    setGalleryStatus(`Loaded ${items.length} photo set(s).`, "success");
  } catch (err) {
    console.error(err);
    setGalleryStatus("Error loading gallery: " + err.message, "error");
  }
}

/* ---------- EVENT WIRING ---------- */

startCameraBtn.addEventListener("click", () => {
  setStatus("Starting camera...");
  startCamera();
});

captureBtn.addEventListener("click", () => {
  captureFrame();
});

saveBtn.addEventListener("click", () => {
  savePhoto();
});

refreshGalleryBtn.addEventListener("click", loadGallery);

// Default to Capture tab on load
showCaptureView();
