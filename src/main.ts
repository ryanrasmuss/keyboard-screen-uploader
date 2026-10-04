import { config } from "./config";
import { browserSupportsGifDecode, decodeGif, type DecodedGif } from "./gif/decode";
import type { CropRect } from "./gif/crop";
import { buildFrames, type BuiltFrame } from "./pipeline";
import { buildPayload, chunkPayload } from "./protocol/payload";
import { browserSupportsHid, KeyboardScreen } from "./protocol/hid";
import { CropBox } from "./ui/cropbox";
import { formatStatus } from "./ui/status";
import "./style.css";

const MAX_PREVIEW_WIDTH = 420;
const MAX_PREVIEW_HEIGHT = 480;
const RECOMPUTE_DEBOUNCE_MS = 100;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

const fileInput = byId<HTMLInputElement>("file-input");
const fileLabel = byId<HTMLSpanElement>("file-label");
const browserWarning = byId<HTMLElement>("browser-warning");
const previewWrap = byId<HTMLDivElement>("preview-wrap");
const previewCanvas = byId<HTMLCanvasElement>("preview-canvas");
const cropBoxEl = byId<HTMLDivElement>("crop-box");
const cropHandleEl = cropBoxEl.querySelector<HTMLDivElement>(".crop-handle")!;
const frameInfo = byId<HTMLParagraphElement>("frame-info");
const optimizePanel = byId<HTMLElement>("optimize-panel");
const frameCountSlider = byId<HTMLInputElement>("frame-count-slider");
const frameCountValue = byId<HTMLElement>("frame-count-value");
const ditherToggle = byId<HTMLInputElement>("dither-toggle");
const devicePreviewCanvas = byId<HTMLCanvasElement>("device-preview-canvas");
const connectBtn = byId<HTMLButtonElement>("connect-btn");
const uploadBtn = byId<HTMLButtonElement>("upload-btn");
const progressWrap = byId<HTMLDivElement>("progress-wrap");
const progressBar = byId<HTMLDivElement>("progress-bar");
const statusEl = byId<HTMLParagraphElement>("status");
const screenDimsEl = byId<HTMLSpanElement>("screen-dims");
const deviceIdsEl = byId<HTMLSpanElement>("device-ids");
const limitResolutionEl = byId<HTMLElement>("limit-resolution");
const limitFramesEl = byId<HTMLElement>("limit-frames");
const limitDelayEl = byId<HTMLElement>("limit-delay");
const limitPayloadEl = byId<HTMLElement>("limit-payload");

function hex(n: number): string {
  return `0x${n.toString(16).padStart(4, "0")}`;
}

screenDimsEl.textContent = `${config.screenWidth}×${config.screenHeight}`;
deviceIdsEl.textContent = `${hex(config.vendorId)}:${hex(config.productId)}`;

limitResolutionEl.textContent = `${config.screenWidth}×${config.screenHeight} px`;
limitFramesEl.textContent = `${config.maxFrames}`;
limitDelayEl.textContent = `${config.delayUnitMs}–${config.maxDelayTicks * config.delayUnitMs} ms`;
const maxPayloadBytes =
  config.headerSize + config.maxFrames * config.screenWidth * config.screenHeight * 2;
limitPayloadEl.textContent = `~${(maxPayloadBytes / 1_000_000).toFixed(1)} MB`;

// Device preview is always config.screenWidth x config.screenHeight content,
// scaled up and drawn without smoothing so individual device pixels are
// visible — a true before/after, not an approximation.
const deviceScale = Math.min(
  MAX_PREVIEW_WIDTH / config.screenWidth,
  MAX_PREVIEW_HEIGHT / config.screenHeight,
);
devicePreviewCanvas.width = Math.round(config.screenWidth * deviceScale);
devicePreviewCanvas.height = Math.round(config.screenHeight * deviceScale);
const deviceBuffer = document.createElement("canvas");
deviceBuffer.width = config.screenWidth;
deviceBuffer.height = config.screenHeight;
const deviceBufferCtx = deviceBuffer.getContext("2d")!;

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("status-error", isError);
}

function setProgress(fraction: number | null): void {
  if (fraction === null) {
    progressWrap.hidden = true;
    return;
  }
  progressWrap.hidden = false;
  progressBar.style.width = `${Math.round(fraction * 100)}%`;
}

const keyboard = new KeyboardScreen();
let decoded: DecodedGif | null = null;
let cropBox: CropBox | null = null;
let previewScaleX = 1;
let previewScaleY = 1;
let sourceAnimationHandle = 0;
let deviceAnimationHandle = 0;
let recomputeDebounce = 0;

function checkBrowserSupport(): boolean {
  const ok = browserSupportsGifDecode() && browserSupportsHid();
  browserWarning.hidden = ok;
  fileInput.disabled = !ok;
  connectBtn.disabled = !ok;
  return ok;
}

function updateUploadEnabled(): void {
  uploadBtn.disabled = !(decoded && keyboard.isConnected);
}

function stopSourceAnimation(): void {
  clearTimeout(sourceAnimationHandle);
}

function startSourceAnimation(gif: DecodedGif): void {
  stopSourceAnimation();
  const ctx = previewCanvas.getContext("2d");
  if (!ctx) return;

  let frameIndex = 0;
  const drawNext = () => {
    const bitmap = gif.frames[frameIndex];
    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    ctx.drawImage(bitmap, 0, 0, previewCanvas.width, previewCanvas.height);
    const delayMs = Math.max(20, gif.delayTicks[frameIndex] * config.delayUnitMs);
    frameIndex = (frameIndex + 1) % gif.frames.length;
    sourceAnimationHandle = window.setTimeout(drawNext, delayMs);
  };
  drawNext();
}

function stopDeviceAnimation(): void {
  clearTimeout(deviceAnimationHandle);
}

function startDeviceAnimation(build: { frames: BuiltFrame[]; delayTicks: number[] }): void {
  stopDeviceAnimation();
  const ctx = devicePreviewCanvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;

  let frameIndex = 0;
  const drawNext = () => {
    deviceBufferCtx.putImageData(build.frames[frameIndex].preview, 0, 0);
    ctx.clearRect(0, 0, devicePreviewCanvas.width, devicePreviewCanvas.height);
    ctx.drawImage(deviceBuffer, 0, 0, devicePreviewCanvas.width, devicePreviewCanvas.height);
    const delayMs = Math.max(20, build.delayTicks[frameIndex] * config.delayUnitMs);
    frameIndex = (frameIndex + 1) % build.frames.length;
    deviceAnimationHandle = window.setTimeout(drawNext, delayMs);
  };
  drawNext();
}

function getSourceCropRect(): CropRect {
  const rect = cropBox!.getRect();
  return {
    x: Math.round(rect.x * previewScaleX),
    y: Math.round(rect.y * previewScaleY),
    width: Math.round(rect.width * previewScaleX),
    height: Math.round(rect.height * previewScaleY),
  };
}

/** Re-runs the resample/crop/quantize pipeline and refreshes the "on the screen" preview. Also the exact function the upload button calls at send time. */
function recomputeOptimized(): void {
  if (!decoded || !cropBox) return;
  try {
    const build = buildFrames(decoded, {
      cropRect: getSourceCropRect(),
      targetFrameCount: Number(frameCountSlider.value),
      dither: ditherToggle.checked,
    });
    startDeviceAnimation(build);
  } catch (error) {
    console.error("Optimize preview failed:", error);
  }
}

function scheduleRecompute(): void {
  clearTimeout(recomputeDebounce);
  recomputeDebounce = window.setTimeout(recomputeOptimized, RECOMPUTE_DEBOUNCE_MS);
}

async function handleFileSelected(file: File): Promise<void> {
  stopSourceAnimation();
  stopDeviceAnimation();
  fileLabel.textContent = file.name;
  setStatus("Decoding GIF…");
  uploadBtn.disabled = true;
  optimizePanel.hidden = true;
  decoded = null;

  try {
    const gif = await decodeGif(file);
    decoded = gif;

    const scale = Math.min(MAX_PREVIEW_WIDTH / gif.width, MAX_PREVIEW_HEIGHT / gif.height, 1);
    const displayWidth = Math.round(gif.width * scale);
    const displayHeight = Math.round(gif.height * scale);

    previewCanvas.width = displayWidth;
    previewCanvas.height = displayHeight;
    previewWrap.style.width = `${displayWidth}px`;
    previewWrap.style.height = `${displayHeight}px`;
    previewWrap.hidden = false;

    previewScaleX = gif.width / displayWidth;
    previewScaleY = gif.height / displayHeight;

    const aspect = config.screenWidth / config.screenHeight;
    cropBox = new CropBox(
      cropBoxEl,
      cropHandleEl,
      { width: displayWidth, height: displayHeight },
      aspect,
      scheduleRecompute,
    );

    startSourceAnimation(gif);

    const maxFrameCount = Math.min(gif.frames.length, config.maxFrames);
    frameCountSlider.min = "1";
    frameCountSlider.max = String(maxFrameCount);
    frameCountSlider.value = String(maxFrameCount);
    frameCountValue.textContent = String(maxFrameCount);
    optimizePanel.hidden = false;
    recomputeOptimized();

    frameInfo.textContent = `${gif.frames.length} frame${gif.frames.length === 1 ? "" : "s"} · ${gif.width}×${gif.height} source`;
    if (gif.frames.length > config.maxFrames) {
      setStatus(
        `This GIF has ${gif.frames.length} frames — it'll be resampled to ${config.maxFrames} across its full loop. Use the frame slider below to pick fewer.`,
      );
    } else {
      setStatus("Drag the crop box, then connect and upload.");
    }
  } catch (error) {
    frameInfo.textContent = "";
    previewWrap.hidden = true;
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    updateUploadEnabled();
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void handleFileSelected(file);
});

frameCountSlider.addEventListener("input", () => {
  frameCountValue.textContent = frameCountSlider.value;
  scheduleRecompute();
});

ditherToggle.addEventListener("change", scheduleRecompute);

connectBtn.addEventListener("click", async () => {
  connectBtn.disabled = true;
  try {
    await keyboard.connect((status) => setStatus(formatStatus(status)));
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    connectBtn.disabled = false;
    updateUploadEnabled();
  }
});

uploadBtn.addEventListener("click", async () => {
  if (!decoded || !cropBox) return;

  uploadBtn.disabled = true;
  connectBtn.disabled = true;
  setProgress(0);

  try {
    setStatus("Cropping and quantizing frames…");
    const build = buildFrames(decoded, {
      cropRect: getSourceCropRect(),
      targetFrameCount: Number(frameCountSlider.value),
      dither: ditherToggle.checked,
    });

    const payload = buildPayload(
      build.frames.map((f) => f.rgb565),
      build.delayTicks,
    );
    const chunks = chunkPayload(payload);

    await keyboard.uploadPayload(chunks, (status) => {
      setStatus(formatStatus(status));
      if (status.kind === "progress" && status.total > 0) {
        setProgress(status.sent / status.total);
      }
      if (status.kind === "finished") {
        setProgress(1);
      }
    });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    connectBtn.disabled = false;
    updateUploadEnabled();
    setTimeout(() => setProgress(null), 1500);
  }
});

const supported = checkBrowserSupport();
updateUploadEnabled();
setStatus(supported ? "Choose a GIF to get started." : "Unsupported browser.");
