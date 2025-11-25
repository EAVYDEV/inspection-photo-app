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
  let lab = new cv.Mat();
  let thresh = new cv.Mat();
  let opened = new cv.Mat();
  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();

  let channels = new cv.MatVector();
  let aChannel = null;
  let kernel = null;

  try {
    // 1. Convert to LAB for better color separation
    cv.cvtColor(src, lab, cv.COLOR_RGBA2Lab, 0);

    // 2. Use the A channel to separate tag blue from brown background
    cv.split(lab, channels);
    aChannel = channels.get(1);

    // 3. Blur + Otsu threshold to isolate tag
    cv.GaussianBlur(aChannel, aChannel, new cv.Size(11, 11), 0);
    cv.threshold(
      aChannel,
      thresh,
      0,
      255,
      cv.THRESH_BINARY + cv.THRESH_OTSU
    );

    // 4. Morphology close to fill gaps
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(25, 25));
    cv.morphologyEx(thresh, opened, cv.MORPH_CLOSE, kernel);

    // 5. Find external contours
    cv.findContours(
      opened,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE
    );

    if (contours.size() === 0) {
      throw new Error("No tag region detected.");
    }

    // 6. Pick largest contour = tag region
    let maxArea = 0;
    let bestContour = null;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt, false);
      if (area > maxArea) {
        maxArea = area;
        bestContour = cnt;
      }
    }

    if (!bestContour) {
      throw new Error("No valid tag contour found.");
    }

    // 7. Use rotated bounding rect of that contour
    let rotatedRect = cv.minAreaRect(bestContour);
    let box = cv.RotatedRect.points(rotatedRect);

    // Build source points from the rotated rectangle vertices
    let srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      box[0].x, box[0].y,
      box[1].x, box[1].y,
      box[2].x, box[2].y,
      box[3].x, box[3].y
    ]);

    let w = rotatedRect.size.width;
    let h = rotatedRect.size.height;

    if (w <= 0 || h <= 0) {
      srcPts.delete();
      throw new Error("Invalid rotated rectangle size.");
    }

    // Maintain portrait orientation
    if (h < w) {
      let tmp = w;
      w = h;
      h = tmp;
    }

    // Limit max size
    const longSide = Math.max(w, h);
    let scale = 1;
    if (longSide > MAX_SIZE) {
      scale = MAX_SIZE / longSide;
    }
    const dstW = Math.round(w * scale);
    const dstH = Math.round(h * scale);

    let dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      dstW - 1, 0,
      dstW - 1, dstH - 1,
      0, dstH - 1
    ]);

    // 8. Warp to get straightened tag
    let M = cv.getPerspectiveTransform(srcPts, dstPts);
    let warped = new cv.Mat();
    cv.warpPerspective(src, warped, M, new cv.Size(dstW, dstH));

    // 9. Convert warped image to grayscale
    let warpedGray = new cv.Mat();
    cv.cvtColor(warped, warpedGray, cv.COLOR_RGBA2GRAY, 0);

    // 10. Draw to preview canvas
    canvas.width = dstW;
    canvas.height = dstH;
    cv.imshow(canvas, warpedGray);

    warped.delete();
    warpedGray.delete();
    M.delete();
    srcPts.delete();
    dstPts.delete();
  } finally {
    src.delete();
    lab.delete();
    thresh.delete();
    opened.delete();
    contours.delete();
    hierarchy.delete();

    if (aChannel) aChannel.delete();
    channels.delete();
    if (kernel) kernel.delete();
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
