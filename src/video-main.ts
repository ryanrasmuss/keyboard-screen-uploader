import { browserSupportsVideoDecode, decodeVideo } from "./video/decode";
import { browserSupportsHid } from "./protocol/hid";
import { createUploadFlow } from "./ui/upload-flow";
import { populateLimitsPanel } from "./ui/limits-panel";
import { isLinux, renderLinuxPanel } from "./ui/linux-panel";
import "./style.css";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in video.html`);
  return el as T;
}

const fileInput = byId<HTMLInputElement>("file-input");
const fileLabel = byId<HTMLSpanElement>("file-label");
const browserWarning = byId<HTMLElement>("browser-warning");
const videoWrap = byId<HTMLDivElement>("video-wrap");
const videoEl = byId<HTMLVideoElement>("video-el");
const trimStart = byId<HTMLInputElement>("trim-start");
const trimEnd = byId<HTMLInputElement>("trim-end");
const trimStartNowBtn = byId<HTMLButtonElement>("trim-start-now");
const trimEndNowBtn = byId<HTMLButtonElement>("trim-end-now");
const useRangeBtn = byId<HTMLButtonElement>("use-range-btn");

populateLimitsPanel({
  screenDimsEl: byId("screen-dims"),
  deviceIdsEl: byId("device-ids"),
  limitResolutionEl: byId("limit-resolution"),
  limitFramesEl: byId("limit-frames"),
  limitDelayEl: byId("limit-delay"),
  limitPayloadEl: byId("limit-payload"),
});

const flow = createUploadFlow({
  previewWrap: byId("preview-wrap"),
  previewCanvas: byId("preview-canvas"),
  cropBoxEl: byId("crop-box"),
  cropHandleEl: byId<HTMLDivElement>("crop-box").querySelector<HTMLDivElement>(".crop-handle")!,
  frameInfo: byId("frame-info"),
  optimizePanel: byId("optimize-panel"),
  frameCountSlider: byId("frame-count-slider"),
  frameCountValue: byId("frame-count-value"),
  ditherToggle: byId("dither-toggle"),
  devicePreviewCanvas: byId("device-preview-canvas"),
  connectBtn: byId("connect-btn"),
  uploadBtn: byId("upload-btn"),
  progressWrap: byId("progress-wrap"),
  progressBar: byId("progress-bar"),
  statusEl: byId("status"),
  linuxPanel: renderLinuxPanel(byId("linux-panel")),
});

let currentFile: File | null = null;
let currentUrl: string | null = null;

function handleFileSelected(file: File): void {
  currentFile = file;
  fileLabel.textContent = file.name;

  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(file);
  videoEl.src = currentUrl;
  videoWrap.hidden = false;
  flow.setStatus("Loading video…");
}

videoEl.addEventListener("loadedmetadata", () => {
  const duration = videoEl.duration || 0;
  trimStart.max = String(duration);
  trimEnd.max = String(duration);
  trimStart.value = "0";
  trimEnd.value = String(Math.min(duration, 5));
  flow.setStatus("Scrub the video, set a range below, then click “Use this range.”");
});

trimStartNowBtn.addEventListener("click", () => {
  trimStart.value = videoEl.currentTime.toFixed(1);
});

trimEndNowBtn.addEventListener("click", () => {
  trimEnd.value = videoEl.currentTime.toFixed(1);
});

useRangeBtn.addEventListener("click", async () => {
  if (!currentFile) return;

  const startSec = Number(trimStart.value);
  const endSec = Number(trimEnd.value);
  if (!(endSec > startSec)) {
    flow.setStatus("End time must be after start time.", true);
    return;
  }

  useRangeBtn.disabled = true;
  flow.setStatus("Capturing frames from the trimmed range…");
  try {
    const gif = await decodeVideo(currentFile, { startSec, endSec });
    flow.setDecoded(gif, currentFile.name);
  } catch (error) {
    flow.setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    useRangeBtn.disabled = false;
  }
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) handleFileSelected(file);
});

// On Linux the .bin export replaces WebHID, so only decoding is required there.
const supported = browserSupportsVideoDecode() && (browserSupportsHid() || isLinux());
browserWarning.hidden = supported;
fileInput.disabled = !supported;
flow.setStatus(supported ? "Choose a video to get started." : "Unsupported browser.");
