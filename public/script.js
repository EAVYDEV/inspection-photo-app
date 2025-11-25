// ----- DOM references -----
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

const chooseFromDeviceBtn = document.getElementById("chooseFromDeviceBtn");
const deviceInput = document.getElementById("deviceInput");
const dropZone = document.getElementById("dropZone");

// ----- State -----
let stream = null;
let hasCapture = false;
let cvReady = false;

const MAX_SIZE = 1600;

// Offscreen raw capture canvas
const rawCanvas = document.createElement("canvas");
const rawCtx = rawCanvas.getContext("2d");

// Blobs for upload
let lastOriginalBlob = null;
let lastCorrectedBlob = null;

// ----- Helpers -----
function setStatus(message) {
  if (!statusEl) return;
  statusEl.textContent = message;
}

function setGalleryStatus(message) {
  if (!galleryStatusEl) return;
  galleryStatusEl.textContent = message;
}

function showCaptureView() {
  captureView.style.display = "";
  galleryView.style.display = "none";
  navCapture.classList.add("active");
  navGallery.classList.remove("active");
}

function showGalleryView() {
  captureView.style.display = "none";
  galleryView.style.display = "";
  navCapture.classList.remove("active");
  navGallery.classList.add("active");
  stopCamera();
  loadGallery();
}

navCapture.addEventListener("click", showCaptureView);
navGallery.addEventListener("click", showGalleryView);

// ----- OpenCV init -----
captureBtn.disabled = true;
saveBtn.disabled = true;

if (window.cv) {
  cv.onRuntimeInitialized = () => {
    cvReady = true;
    console.log("OpenCV.js runtime initialized");
    captureBtn.disabled = false;
    setStatus(
      "Image processor ready. Start the camera, align the tag, then tap Capture."
    );
  };
} else {
  console.warn("OpenCV.js not found – using basic capture only.");
  setStatus(
    "Advanced processing unavailable. Captures will not be auto-straightened."
  );
}

// ----- Camera -----
async function startCamera() {
  if (!cvReady) {
    setStatus(
      "Still loading the image processor. Wait a moment until the message says it's ready, then try again."
    );
    return;
  }

  try {
    setStatus("Starting camera...");
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });
    video.srcObject = stream;
    setStatus(
      "Camera started. Align the tag inside the outline and tap Capture."
    );
  } catch (err) {
    console.error("Camera error:", err);
    setStatus("Unable to access camera. Check permissions.");
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  }
}

startCameraBtn.addEventListener("click", startCamera);

// ----- Capture + processing -----
function captureFrame() {
  if (!stream) {
    setStatus("Camera is not active. Start the camera first.");
    return;
  }

  const vWidth = video.videoWidth;
  const vHeight = video.videoHeight;
  if (!vWidth || !vHeight) {
    setStatus("Camera is not ready yet. Try again in a moment.");
    return;
  }

  rawCanvas.width = vWidth;
  rawCanvas.height = vHeight;
  rawCtx.drawImage(video, 0, 0, vWidth, vHeight);

  hasCapture = true;
  saveBtn.disabled = false;
  runDeskewOrFallback();
}

captureBtn.addEventListener("click", captureFrame);

function basicCopyToPreview() {
  const srcW = rawCanvas.width;
  const srcH = rawCanvas.height;
  if (!srcW || !srcH) return;

  const ctx = canvas.getContext("2d");
  const scale = MAX_SIZE / Math.max(srcW, srcH);
  const targetW = scale < 1 ? Math.round(srcW * scale) : srcW;
  const targetH = scale < 1 ? Math.round(srcH * scale) : srcH;

  canvas.width = targetW;
  canvas.height = targetH;
  ctx.drawImage(rawCanvas, 0, 0, targetW, targetH);
}

function displayMatOnCanvas(mat) {
  const gray = mat; // CV_8UC1
  const srcW = gray.cols;
  const srcH = gray.rows;

  const scale = MAX_SIZE / Math.max(srcW, srcH);
  const targetW = scale < 1 ? Math.round(srcW * scale) : srcW;
  const targetH = scale < 1 ? Math.round(srcH * scale) : srcH;

  const resized = new cv.Mat();
  cv.resize(gray, resized, new cv.Size(targetW, targetH), 0, 0, cv.INTER_AREA);

  canvas.width = targetW;
  canvas.height = targetH;

  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(targetW, targetH);

  let idx = 0;
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const v = resized.ucharPtr(y, x)[0];
      imageData.data[idx++] = v;
      imageData.data[idx++] = v;
      imageData.data[idx++] = v;
      imageData.data[idx++] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  resized.delete();
}

function updateBlobs(callback) {
  if (!hasCapture) return;

  let pending = 2;

  function done() {
    pending--;
    if (pending === 0 && typeof callback === "function") {
      callback();
    }
  }

  rawCanvas.toBlob(
    (blob) => {
      lastOriginalBlob = blob;
      done();
    },
    "image/jpeg",
    0.85
  );

  canvas.toBlob(
    (blob) => {
      lastCorrectedBlob = blob;
      done();
    },
    "image/jpeg",
    0.85
  );
}

// Core: find tag and warp so it looks straight-on
function runDeskewOrFallback() {
  if (!cvReady || !window.cv) {
    basicCopyToPreview();
    updateBlobs();
    setStatus(
      "Captured. Advanced processing not available, showing uncorrected preview."
    );
    return;
  }

  let usedPerspective = false;

  try {
    const src = cv.imread(rawCanvas);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

    const blur = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    const edges = new cv.Mat();
    cv.Canny(blur, edges, 50, 150);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(
      edges,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE
    );

    const frameW = gray.cols;
    const frameH = gray.rows;
    const frameArea = frameW * frameH;
    const minArea = frameArea * 0.01; // at least 1% of frame

    let best = null;
    let bestArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

      if (approx.rows === 4) {
        const rect = cv.boundingRect(approx);
        const area = rect.width * rect.height;
        const aspect = rect.height / rect.width; // tag is tall

        // Filter: big enough, reasonably tall tag shape
        if (area >= minArea && aspect >= 1.2 && aspect <= 4.0) {
          if (area > bestArea) {
            if (best) best.delete();
            best = approx;
            bestArea = area;
          } else {
            approx.delete();
          }
        } else {
          approx.delete();
        }
      } else {
        approx.delete();
      }
      cnt.delete();
    }

    // default to original gray
    let outputMat = gray;

    if (best && bestArea > 0) {
      // Extract 4 corner points correctly from approx.data32S
      const pts = [];
      const data = best.data32S; // [x0,y0,x1,y1,x2,y2,x3,y3]
      for (let i = 0; i < data.length; i += 2) {
        pts.push({ x: data[i], y: data[i + 1] });
      }

      if (pts.length === 4) {
        // sort by y (top to bottom), then x
        pts.sort((a, b) => a.y - b.y);
        const top = pts.slice(0, 2).sort((a, b) => a.x - b.x);
        const bottom = pts.slice(2, 4).sort((a, b) => a.x - b.x);

        const [tl, tr] = top;
        const [bl, br] = bottom;

        const widthTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
        const widthBottom = Math.hypot(br.x - bl.x, br.y - bl.y);
        const heightLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
        const heightRight = Math.hypot(br.x - tr.x, br.y - tr.y);

        const dstWidth = Math.round(Math.max(widthTop, widthBottom));
        const dstHeight = Math.round(Math.max(heightLeft, heightRight));

        if (dstWidth > 0 && dstHeight > 0) {
          const srcTri = cv.matFromArray(
            4,
            1,
            cv.CV_32FC2,
            [
              tl.x, tl.y,
              tr.x, tr.y,
              bl.x, bl.y,
              br.x, br.y
            ]
          );
          const dstTri = cv.matFromArray(
            4,
            1,
            cv.CV_32FC2,
            [
              0, 0,
              dstWidth, 0,
              0, dstHeight,
              dstWidth, dstHeight
            ]
          );

          const M = cv.getPerspectiveTransform(srcTri, dstTri);
          const warped = new cv.Mat();
          cv.warpPerspective(
            gray,
            warped,
            M,
            new cv.Size(dstWidth, dstHeight)
          );

          srcTri.delete();
          dstTri.delete();
          M.delete();
          best.delete();

          displayMatOnCanvas(warped);
          warped.delete();
          usedPerspective = true;
        } else {
          best.delete();
          displayMatOnCanvas(gray);
        }
      } else {
        best.delete();
        displayMatOnCanvas(gray);
      }
    } else {
      if (best) best.delete();
      displayMatOnCanvas(gray);
    }

    src.delete();
    gray.delete();
    blur.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();

    updateBlobs(() => {
      if (usedPerspective) {
        setStatus(
          "Captured and auto-straightened. Tag is now aligned like a straight-on shot."
        );
      } else {
        setStatus(
          "Captured, but could not confidently find the tag edges. Showing best grayscale capture."
        );
      }
    });
  } catch (err) {
    console.error("Deskew error:", err);
    basicCopyToPreview();
    updateBlobs(() => {
      setStatus(
        "Captured, but auto-straighten failed. Showing uncorrected preview."
      );
    });
  }
}

// ----- Device upload & drag/drop -----
chooseFromDeviceBtn.addEventListener("click", () => {
  deviceInput.click();
});

deviceInput.addEventListener("change", () => {
  const file = deviceInput.files[0];
  if (file) {
    loadImageFile(file);
  }
});

function loadImageFile(file) {
  if (!file.type.startsWith("image/")) {
    setStatus("Please choose an image file.");
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
      setStatus("Image loaded from device and processed.");
    };
    img.onerror = () => {
      setStatus("Failed to load image.");
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

["dragenter", "dragover"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add("drag-over");
  });
});

["dragleave", "drop"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove("drag-over");
  });
});

dropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) {
  loadImageFile(file);
  }
});

// ----- Upload to server -----
function savePhoto() {
  if (!hasCapture) {
    setStatus("Capture or load a tag first.");
    return;
  }

  setStatus("Preparing image for upload...");

  updateBlobs(async () => {
    if (!lastOriginalBlob || !lastCorrectedBlob) {
      setStatus("Unable to prepare image blobs.");
      return;
    }

    try {
      const formData = new FormData();
      formData.append("original", lastOriginalBlob, "original.jpg");
      formData.append("corrected", lastCorrectedBlob, "corrected.jpg");

      const response = await fetch("/upload", {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        throw new Error(`Upload failed with status ${response.status}`);
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || "Upload failed.");
      }

      setStatus(
        `Saved pair ${data.id}. Original: ${formatBytes(
          data.originalSize
        )}, Corrected: ${formatBytes(data.correctedSize)}.`
      );
    } catch (err) {
      console.error("Upload error:", err);
      setStatus("Failed to upload images.");
    }
  });
}

saveBtn.addEventListener("click", savePhoto);

// ----- Gallery -----
function formatBytes(bytes) {
  if (bytes == null) return "";
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

async function loadGallery() {
  setGalleryStatus("Loading photos...");
  photoTableBody.innerHTML = "";

  try {
    const res = await fetch("/photos");
    if (!res.ok) throw new Error(`Failed with status ${res.status}`);

    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) {
      setGalleryStatus("No photos saved yet.");
      return;
    }

    for (const item of items) {
      const tr = document.createElement("tr");

      const idTd = document.createElement("td");
      idTd.textContent = item.id;

      const origTd = document.createElement("td");
      const origImg = document.createElement("img");
      origImg.src = item.originalUrl;
      origImg.alt = `Original ${item.id}`;
      // Fallback to corrected if original failed
      origImg.onerror = () => {
        console.warn(
          `Original image failed for ${item.id}, falling back to corrected.`
        );
        origImg.src = item.correctedUrl;
        origImg.alt = `Original (fallback to corrected) ${item.id}`;
      };
      const origSize = document.createElement("div");
      origSize.textContent = formatBytes(item.originalSize);
      origTd.appendChild(origImg);
      origTd.appendChild(origSize);

      const corrTd = document.createElement("td");
      const corrImg = document.createElement("img");
      corrImg.src = item.correctedUrl;
      corrImg.alt = `Corrected ${item.id}`;
      const corrSize = document.createElement("div");
      corrSize.textContent = formatBytes(item.correctedSize);
      corrTd.appendChild(corrImg);
      corrTd.appendChild(corrSize);

      tr.appendChild(idTd);
      tr.appendChild(origTd);
      tr.appendChild(corrTd);

      photoTableBody.appendChild(tr);
    }

    setGalleryStatus("");
  } catch (err) {
    console.error("Gallery error:", err);
    setGalleryStatus("Failed to load photo archive.");
  }
}

refreshGalleryBtn.addEventListener("click", loadGallery);

// ----- Initial -----
showCaptureView();
