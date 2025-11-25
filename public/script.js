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

// Tag alignment overlay element to compute ROI
const tagOutline = document.querySelector(".tag-outline");

// Hidden raw canvas to hold original frame / uploaded image
const rawCanvas = document.createElement("canvas");
const rawCtx = rawCanvas.getContext("2d");

let stream = null;
let hasCapture = false;
let cvReady = false;

// Limit max size for compression (longest side)
const MAX_SIZE = 1600;

/* ---------- OpenCV runtime hook ---------- */

// opencv.js is loaded before this file, so cv should exist now.
if (window.cv) {
  cv.onRuntimeInitialized = () => {
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

/* ---------- ROI-BASED DESKEW / PREVIEW ---------- */

/**
 * Calculate the region of interest of the tag outline within the raw canvas.
 * It uses the bounding client rect of the .tag-outline overlaid on the video
 * element and translates it into pixel coordinates corresponding to rawCanvas.
 * Returns an object { x, y, w, h } or null if the overlay or video metrics
 * are not available.
 */
function computeTagRoiRect() {
  if (!tagOutline || !video.videoWidth || !video.videoHeight) {
    return null;
  }

  const videoRect = video.getBoundingClientRect();
  const outlineRect = tagOutline.getBoundingClientRect();

  // Determine scaling factors from DOM coordinates to raw canvas pixel space
  const scaleX = rawCanvas.width / videoRect.width;
  const scaleY = rawCanvas.height / videoRect.height;

  // Compute pixel coordinates relative to raw canvas
  const x = Math.max(
    0,
    Math.round((outlineRect.left - videoRect.left) * scaleX)
  );
  const y = Math.max(
    0,
    Math.round((outlineRect.top - videoRect.top) * scaleY)
  );
  const w = Math.min(
    rawCanvas.width - x,
    Math.round(outlineRect.width * scaleX)
  );
  const h = Math.min(
    rawCanvas.height - y,
    Math.round(outlineRect.height * scaleY)
  );

  if (w <= 0 || h <= 0) {
    return null;
  }

  return { x, y, w, h };
}

/* --- OpenCV-based automatic perspective correction & grayscale --- */

function autoDeskewWithOpenCV() {
  if (!cvReady || !window.cv) {
    throw new Error("OpenCV not ready");
  }

  // Read the raw frame from the hidden canvas
  const src = cv.imread(rawCanvas);
  let roi = null;
  let roiIsSub = false;

  // Mat containers
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  // Flag to indicate if a warp happened
  let warpSucceeded = false;

  try {
    // Determine the region of interest based on the tag overlay
    const rect = computeTagRoiRect();
    if (rect) {
      const r = new cv.Rect(rect.x, rect.y, rect.w, rect.h);
      roi = src.roi(r);
      roiIsSub = true;
    } else {
      roi = src.clone();
    }

    // Convert ROI to grayscale
    cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY, 0);

    // Blur to reduce noise
    cv.GaussianBlur(gray, blur, new cv.Size(7, 7), 0);

    // Detect edges
    cv.Canny(blur, edges, 50, 150);

    // Find all external contours
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let bestContour = null;
    let bestArea = 0;
    // Choose the largest contour by area
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt, false);
      if (area > bestArea) {
        bestArea = area;
        if (bestContour) bestContour.delete();
        bestContour = cnt;
      } else {
        cnt.delete();
      }
    }

    if (!bestContour || bestArea <= 0) {
      // No contour found: just display grayscale ROI
      displayMatOnCanvas(gray);
      return false;
    }

    // Compute the rotated bounding rectangle of the largest contour
    const rotatedRect = cv.minAreaRect(bestContour);
    const box = cv.RotatedRect.points(rotatedRect);

    // Create array of the 4 corner coordinates
    const srcPtsArr = [];
    for (let i = 0; i < box.length; i++) {
      srcPtsArr.push(box[i].x);
      srcPtsArr.push(box[i].y);
    }
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, srcPtsArr);

    let w = rotatedRect.size.width;
    let h = rotatedRect.size.height;
    if (w <= 0 || h <= 0) {
      srcPts.delete();
      displayMatOnCanvas(gray);
      return false;
    }

    // Force portrait orientation (height >= width)
    if (h < w) {
      const tmp = w;
      w = h;
      h = tmp;
    }

    // Limit output so its longest side does not exceed MAX_SIZE
    const longSide = Math.max(w, h);
    let scale = 1;
    if (longSide > MAX_SIZE) {
      scale = MAX_SIZE / longSide;
    }
    const dstW = Math.round(w * scale);
    const dstH = Math.round(h * scale);

    // Prepare destination points (axis-aligned rectangle)
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      dstW - 1, 0,
      dstW - 1, dstH - 1,
      0, dstH - 1
    ]);

    // Apply perspective transformation to obtain a straightened tag
    const M = cv.getPerspectiveTransform(srcPts, dstPts);
    const warped = new cv.Mat();
    cv.warpPerspective(roi, warped, M, new cv.Size(dstW, dstH));

    // Convert warped image to grayscale (in case warp produces a color image)
    const warpedGray = new cv.Mat();
    cv.cvtColor(warped, warpedGray, cv.COLOR_RGBA2GRAY, 0);

    // Draw warped grayscale image to preview canvas
    canvas.width = dstW;
    canvas.height = dstH;
    cv.imshow(canvas, warpedGray);

    warpSucceeded = true;

    // Clean up
    warped.delete();
    warpedGray.delete();
    M.delete();
    srcPts.delete();
    dstPts.delete();
    if (bestContour) bestContour.delete();

    return warpSucceeded;
  } finally {
    // Free up allocated matrices
    if (roiIsSub && roi) {
      roi.delete();
    }
    src.delete();
    gray.delete();
    blur.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
  }
}

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
    const didWarp = autoDeskewWithOpenCV();
    if (didWarp) {
      setStatus(
        "Captured and auto-straightened. Converted to grayscale.",
        "success"
      );
    } else {
      setStatus(
        "Captured, but could not confidently find the tag edges. Showing best grayscale capture.",
        "error"
      );
    }
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
