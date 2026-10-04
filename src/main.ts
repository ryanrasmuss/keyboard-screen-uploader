import { browserSupportsGifDecode, decodeGif } from "./gif/decode";
import { browserSupportsHid } from "./protocol/hid";
import { createUploadFlow } from "./ui/upload-flow";
import { populateLimitsPanel } from "./ui/limits-panel";
import { isLinux, renderLinuxPanel } from "./ui/linux-panel";
import "./style.css";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

const fileInput = byId<HTMLInputElement>("file-input");
const fileLabel = byId<HTMLSpanElement>("file-label");
const browserWarning = byId<HTMLElement>("browser-warning");
const previewWrap = byId<HTMLDivElement>("preview-wrap");
const frameInfo = byId<HTMLParagraphElement>("frame-info");
const optimizePanel = byId<HTMLElement>("optimize-panel");

populateLimitsPanel({
  screenDimsEl: byId("screen-dims"),
  deviceIdsEl: byId("device-ids"),
  limitResolutionEl: byId("limit-resolution"),
  limitFramesEl: byId("limit-frames"),
  limitDelayEl: byId("limit-delay"),
  limitPayloadEl: byId("limit-payload"),
});

const flow = createUploadFlow({
  previewWrap,
  previewCanvas: byId("preview-canvas"),
  cropBoxEl: byId("crop-box"),
  cropHandleEl: byId<HTMLDivElement>("crop-box").querySelector<HTMLDivElement>(".crop-handle")!,
  frameInfo,
  optimizePanel,
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

async function handleFileSelected(file: File): Promise<void> {
  fileLabel.textContent = file.name;
  flow.setStatus("Decoding GIF…");
  optimizePanel.hidden = true;

  try {
    flow.setDecoded(await decodeGif(file), file.name);
  } catch (error) {
    frameInfo.textContent = "";
    previewWrap.hidden = true;
    flow.setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void handleFileSelected(file);
});

// On Linux the .bin export replaces WebHID, so only decoding is required there.
const supported = browserSupportsGifDecode() && (browserSupportsHid() || isLinux());
browserWarning.hidden = supported;
fileInput.disabled = !supported;
flow.setStatus(supported ? "Choose a GIF to get started." : "Unsupported browser.");
