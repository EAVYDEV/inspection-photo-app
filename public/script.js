const startCameraBtn = document.getElementById("startCameraBtn");
const captureBtn = document.getElementById("captureBtn");
const rotateBtn = document.getElementById("rotateBtn");
const saveBtn = document.getElementById("saveBtn");
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const statusEl = document.getElementById("status");

const rawCanvas = document.createElement("canvas");
const rawCtx = rawCanvas.getContext("2d");

let stream = null;
let rotation = 0;
let hasCapture = false;

const MAX_SIZE = 1600;

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = "status";
  if (type) statusEl.classList.add(type);
}

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

async function savePhoto() {
  if (!hasCapture) {
    setStatus("Capture a photo first.", "error");
    return;
  }

  setStatus("Compressing and uploading photo...");

  canvas.toBlob(
    async (blob) => {
      if (!blob) {
        setStatus("Failed to prepare image for upload.", "error");
        return;
      }

      const formData = new FormData();
      formData.append("photo", blob, "inspection.jpg");

      try {
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
          `Photo archived as ${data.fileName} in folder "${data.folder}".`,
          "success"
        );
      } catch (err) {
        console.error(err);
        setStatus("Upload error: " + err.message, "error");
      }
    },
    "image/jpeg",
    0.6
  );
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
