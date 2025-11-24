const startCameraBtn = document.getElementById("startCameraBtn");
const captureBtn = document.getElementById("captureBtn");
const rotateBtn = document.getElementById("rotateBtn");
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

// Hidden raw canvas to hold original frame
const rawCanvas = document.createElement("canvas");
const rawCtx = rawCanvas.getContext("2d");

let stream = null;
let rotation = 0;
let hasCapture = false;

// Limit max size for compression (longest side)
const MAX_SIZE = 1600;

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

  // Raw original frame
  rawCanvas.width = width;
  rawCanvas.height = height;
  rawCtx.drawImage(video, 0, 0, width, height);

  rotation = 0;
  hasCapture = true;

  applyTransformAndResize();
  rotateBtn.disabled = false;
  saveBtn.disabled = false;

  setStatus("Photo captured. Rotate if needed, then Save.", "success");
  return true;
}

function applyTransformAndResize() {
  if (!hasCapture) return;

  const srcW = rawCanvas.width;
  const srcH = rawCanvas.height;

  const rotatedIsPortrait = rotation === 90 || rotation === 270;
  const baseWidth = rotatedIsPortrait ? srcH : srcW;
  const baseHeight = rotatedIsPortrait ? srcW : srcH;

  let scale = 1;
  const longSide = Math.max(baseWidth, baseHeight);
  if (longSide > MAX_SIZE) {
    scale = MAX_SIZE / longSide;
  }

  const destW = Math.round(baseWidth * scale);
  const destH = Math.round(baseHeight * scale);

  canvas.width = destW;
  canvas.height = destH;
  const ctx = canvas.getContext("2d");

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, destW, destH);

  ctx.translate(destW / 2, destH / 2);
  ctx.rotate((rotation * Math.PI) / 180);

  const drawW = srcW * scale;
  const drawH = srcH * scale;
  ctx.drawImage(rawCanvas, -drawW / 2, -drawH / 2, drawW, drawH);

  ctx.restore();
}

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
    setStatus("Capture a photo first.", "error");
    return;
  }

  setStatus("Compressing and uploading photos...");

  try {
    // Original: full quality from rawCanvas
    const originalBlob = await canvasToBlob(rawCanvas, "image/jpeg", 0.95);
    // Corrected: rotated + compressed from main canvas
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

startCameraBtn.addEventListener("click", () => {
  setStatus("Starting camera...");
  startCamera();
});

captureBtn.addEventListener("click", () => {
  captureFrame();
});

rotateBtn.addEventListener("click", () => {
  if (!hasCapture) return;
  rotation = (rotation + 90) % 360;
  applyTransformAndResize();
  setStatus(`Rotated to ${rotation}°.`, "success");
});

saveBtn.addEventListener("click", () => {
  savePhoto();
});

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

refreshGalleryBtn.addEventListener("click", loadGallery);

// Default to Capture tab on load
showCaptureView();
