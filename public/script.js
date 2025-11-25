window.addEventListener("DOMContentLoaded", () => {
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

  // Tag overlay element (for ROI)
  const tagOutline = document.querySelector(".tag-outline");

  // Hidden raw canvas
  const rawCanvas = document.createElement("canvas");
  const rawCtx = rawCanvas.getContext("2d");

  // State
  let stream = null;
  let hasCapture = false;
  let cvReady = false;

  // Max preview / save dimension
  const MAX_SIZE = 1600;

  // Extra: make sure video is inline on iOS Safari
  if (video) {
    video.setAttribute("playsinline", "true");
  }

  /* ---------- OpenCV init ---------- */

  if (window.cv) {
    cv.onRuntimeInitialized = () => {
      cvReady = true;
      console.log("OpenCV.js runtime initialized");
    };
  }

  /* ---------- Status helpers ---------- */

  function setStatus(message, type = "") {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = "status";
    if (type) statusEl.classList.add(type);
  }

  function setGalleryStatus(message, type = "") {
    if (!galleryStatusEl) return;
    galleryStatusEl.textContent = message;
    galleryStatusEl.className = "status";
    if (type) galleryStatusEl.classList.add(type);
  }

  /* ---------- Nav tabs ---------- */

  function showCaptureView() {
    if (navCapture) navCapture.classList.add("active");
    if (navGallery) navGallery.classList.remove("active");
    if (captureView) captureView.style.display = "";
    if (galleryView) galleryView.style.display = "none";
  }

  function showGalleryView() {
    if (navCapture) navCapture.classList.remove("active");
    if (navGallery) navGallery.classList.add("active");
    if (captureView) captureView.style.display = "none";
    if (galleryView) galleryView.style.display = "";
    loadGallery();
  }

  if (navCapture) {
    navCapture.addEventListener("click", showCaptureView);
  }
  if (navGallery) {
    navGallery.addEventListener("click", showGalleryView);
  }

  /* ---------- Camera / capture ---------- */

  async function startCamera() {
    // Defensive check: is camera API available?
    if (
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function"
    ) {
      setStatus(
        "Camera access is not supported in this browser / context.",
        "error"
      );
      return;
    }

    try {
      const constraints = {
        video: { facingMode: "environment" },
        audio: false
      };

      const newStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Stop any existing stream just in case
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }

      stream = newStream;
      if (video) {
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        video.play().catch(() => {});
      }

      if (captureBtn) captureBtn.disabled = false;
      setStatus(
        "Camera started. Align tag inside outline and tap Capture.",
        "success"
      );
    } catch (err) {
      console.error("Camera error:", err);
      if (
        err.name === "NotAllowedError" ||
        err.name === "PermissionDeniedError"
      ) {
        setStatus(
          "Camera permission was denied. Enable camera access in browser settings and reload.",
          "error"
        );
      } else if (
        err.name === "NotFoundError" ||
        err.name === "OverconstrainedError"
      ) {
        setStatus("No suitable camera found on this device.", "error");
      } else {
        setStatus("Unable to access camera: " + err.message, "error");
      }
    }
  }

  function captureFrame() {
    if (!stream) {
      setStatus("Camera is not running. Tap Start Camera first.", "error");
      return false;
    }

    if (!video) {
      setStatus("Video element not found.", "error");
      return false;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      setStatus("Camera is still initializing. Try Capture again.", "error");
      return false;
    }

    rawCanvas.width = width;
    rawCanvas.height = height;
    rawCtx.drawImage(video, 0, 0, width, height);

    hasCapture = true;
    if (saveBtn) saveBtn.disabled = false;

    runDeskewOrFallback();
    return true;
  }

  /* ---------- Device upload / drag & drop ---------- */

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
        if (saveBtn) saveBtn.disabled = false;
        runDeskewOrFallback();
        setStatus("Image loaded from device and processed.", "success");
      };
      img.onerror = () => setStatus("Failed to load image.", "error");
      img.src = reader.result;
    };
    reader.onerror = () => setStatus("Failed to read file.", "error");
    reader.readAsDataURL(file);
  }

  if (choosePhotoBtn) {
    choosePhotoBtn.addEventListener("click", () => fileInput && fileInput.click());
  }

  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) loadImageFile(file);
    });
  }

  if (dropZone) {
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
  }

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
      const warped = autoDeskewWithOpenCV();
      if (warped) {
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

  /* Simple fallback: just copy raw image into preview canvas */
  function basicCopyToPreview() {
    const srcW = rawCanvas.width;
    const srcH = rawCanvas.height;
    if (!srcW || !srcH) return;

    const longSide = Math.max(srcW, srcH);
    let scale = 1;
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

  /* --- Helper: compute ROI from tag overlay --- */

  function computeTagRoiRect() {
    if (!tagOutline || !video || !video.videoWidth || !video.videoHeight) {
      return null;
    }

    const videoRect = video.getBoundingClientRect();
    const outlineRect = tagOutline.getBoundingClientRect();

    const scaleX = rawCanvas.width / videoRect.width;
    const scaleY = rawCanvas.height / videoRect.height;

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

    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }
  function distance(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  
  /* --- OpenCV-based automatic perspective correction & grayscale --- */

  function autoDeskewWithOpenCV() {
    if (!cvReady || !window.cv) {
      return false;
    }
  
    const src = cv.imread(rawCanvas);
  
    // Restrict to overlay region for more reliable detection
    const roiRect = computeTagRoiRect();
    let roi = src;
    let roiIsSub = false;
    if (roiRect) {
      const r = new cv.Rect(roiRect.x, roiRect.y, roiRect.w, roiRect.h);
      roi = src.roi(r);
      roiIsSub = true;
    }
  
    const gray = new cv.Mat();
    const blur = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
  
    let warped = null;
    let warpedGray = null;
    let success = false;
  
    try {
      // 1. Edge detection in the ROI
      cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY, 0);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      cv.Canny(blur, edges, 50, 150);
  
      cv.findContours(
        edges,
        contours,
        hierarchy,
        cv.RETR_EXTERNAL,
        cv.CHAIN_APPROX_SIMPLE
      );
  
      if (contours.size() === 0) {
        basicCopyToPreview();
        return false;
      }
  
      // 2. Pick the largest contour
      let bestIdx = 0;
      let bestArea = 0;
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const a = cv.contourArea(cnt, false);
        if (a > bestArea) {
          bestArea = a;
          bestIdx = i;
        }
      }
  
      const bestContour = contours.get(bestIdx);
  
      // 3. Minimum-area rectangle around that contour
      const rotatedRect = cv.minAreaRect(bestContour);
      const box = cv.RotatedRect.points(rotatedRect); // array of 4 cv.Point
  
      // 4. Convert to plain {x,y} and order points:
      //    top-left, top-right, bottom-right, bottom-left
      let pts = box.map((p) => ({ x: p.x, y: p.y }));
  
      // sort by Y (top to bottom)
      pts.sort((a, b) => a.y - b.y);
      const top = pts.slice(0, 2);
      const bottom = pts.slice(2, 4);
  
      // within each row, sort by X (left to right)
      top.sort((a, b) => a.x - b.x);
      bottom.sort((a, b) => a.x - b.x);
  
      const tl = top[0];
      const tr = top[1];
      const bl = bottom[0];
      const br = bottom[1];
  
      // 5. Compute target width/height from edges
      const widthA = distance(br, bl);
      const widthB = distance(tr, tl);
      let maxWidth = Math.max(widthA, widthB);
  
      const heightA = distance(tr, br);
      const heightB = distance(tl, bl);
      let maxHeight = Math.max(heightA, heightB);
  
      if (maxWidth <= 0 || maxHeight <= 0) {
        basicCopyToPreview();
        return false;
      }
  
      // Limit size to MAX_SIZE to keep file small
      const longSide = Math.max(maxWidth, maxHeight);
      let scale = 1;
      if (longSide > MAX_SIZE) {
        scale = MAX_SIZE / longSide;
      }
      const dstW = Math.round(maxWidth * scale);
      const dstH = Math.round(maxHeight * scale);
  
      // 6. Build perspective transform using ordered corners
      const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
        tl.x, tl.y,
        tr.x, tr.y,
        br.x, br.y,
        bl.x, bl.y
      ]);
  
      const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0,
        dstW - 1, 0,
        dstW - 1, dstH - 1,
        0, dstH - 1
      ]);
  
      const M = cv.getPerspectiveTransform(srcPts, dstPts);
      warped = new cv.Mat();
      cv.warpPerspective(roi, warped, M, new cv.Size(dstW, dstH));
  
      // 7. Convert warped image to grayscale
      warpedGray = new cv.Mat();
      cv.cvtColor(warped, warpedGray, cv.COLOR_RGBA2GRAY, 0);
  
      canvas.width = dstW;
      canvas.height = dstH;
      cv.imshow(canvas, warpedGray);
  
      success = true;
  
      M.delete();
      srcPts.delete();
      dstPts.delete();
    } finally {
      if (roiIsSub && roi) roi.delete();
      src.delete();
      gray.delete();
      blur.delete();
      edges.delete();
      contours.delete();
      hierarchy.delete();
      if (warped) warped.delete();
      if (warpedGray) warpedGray.delete();
    }
  
    return success;
  }
    /* ---------- Save / upload ---------- */

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

  /* ---------- Gallery ---------- */

  function formatBytes(bytes) {
    if (bytes == null) return "";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let value = bytes;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${value.toFixed(1)} ${units[i]}`;
  }

  async function loadGallery() {
    setGalleryStatus("Loading photos...");
    if (photoTableBody) photoTableBody.innerHTML = "";

    try {
      const res = await fetch("/photos");
      if (!res.ok) {
        setGalleryStatus("Failed to load photos.", "error");
        return;
      }

      const items = await res.json();
      if (!Array.isArray(items) || items.length === 0) {
        setGalleryStatus("No photos archived yet.", "success");
        return;
      }

      for (const item of items) {
        const tr = document.createElement("tr");

        const idTd = document.createElement("td");
        idTd.textContent = item.id;
        tr.appendChild(idTd);

        const origTd = document.createElement("td");
        const origImg = document.createElement("img");
        origImg.src = item.originalUrl;
        origImg.alt = `Original ${item.id}`;
        const origSize = document.createElement("div");
        origSize.className = "size-text";
        origSize.textContent = formatBytes(item.originalSize);
        origTd.appendChild(origImg);
        origTd.appendChild(origSize);
        tr.appendChild(origTd);

        const corrTd = document.createElement("td");
        const corrImg = document.createElement("img");
        corrImg.src = item.correctedUrl;
        corrImg.alt = `Corrected ${item.id}`;
        const corrSize = document.createElement("div");
        corrSize.className = "size-text";
        corrSize.textContent = formatBytes(item.correctedSize);
        corrTd.appendChild(corrImg);
        corrTd.appendChild(corrSize);
        tr.appendChild(corrTd);

        if (photoTableBody) photoTableBody.appendChild(tr);
      }

      setGalleryStatus(`Loaded ${items.length} photo set(s).`, "success");
    } catch (err) {
      console.error(err);
      setGalleryStatus("Error loading gallery: " + err.message, "error");
    }
  }

  /* ---------- Event wiring ---------- */

  if (startCameraBtn) {
    startCameraBtn.addEventListener("click", () => {
      setStatus("Starting camera...");
      startCamera();
    });
  } else {
    console.error("startCameraBtn not found in DOM.");
  }

  if (captureBtn) {
    captureBtn.addEventListener("click", () => {
      captureFrame();
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      savePhoto();
    });
  }

  if (refreshGalleryBtn) {
    refreshGalleryBtn.addEventListener("click", loadGallery);
  }

  // Default to Capture tab on load
  showCaptureView();
});
