import { config } from "../config";
import type { DecodedGif } from "../gif/decode";
import type { CropRect } from "../gif/crop";
import { buildFrames, type BuiltFrame } from "../pipeline";
import { buildPayload, chunkPayload } from "../protocol/payload";
import { browserSupportsHid, KeyboardScreen } from "../protocol/hid";
import { CropBox } from "./cropbox";
import { isLinux, type LinuxPanel } from "./linux-panel";
import { formatStatus } from "./status";

const MAX_PREVIEW_WIDTH = 420;
const MAX_PREVIEW_HEIGHT = 480;
const RECOMPUTE_DEBOUNCE_MS = 100;

export interface UploadFlowElements {
  previewWrap: HTMLDivElement;
  previewCanvas: HTMLCanvasElement;
  cropBoxEl: HTMLDivElement;
  cropHandleEl: HTMLDivElement;
  frameInfo: HTMLParagraphElement;
  optimizePanel: HTMLElement;
  frameCountSlider: HTMLInputElement;
  frameCountValue: HTMLElement;
  ditherToggle: HTMLInputElement;
  devicePreviewCanvas: HTMLCanvasElement;
  connectBtn: HTMLButtonElement;
  uploadBtn: HTMLButtonElement;
  progressWrap: HTMLDivElement;
  progressBar: HTMLDivElement;
  statusEl: HTMLParagraphElement;
  linuxPanel: LinuxPanel;
}

export interface UploadFlow {
  /** Hands off a freshly decoded source (from a GIF or a trimmed video range) to the crop/optimize/upload UI. */
  setDecoded(gif: DecodedGif, sourceName: string): void;
  setStatus(text: string, isError?: boolean): void;
}

/**
 * Everything downstream of "we have a DecodedGif": crop box, the
 * frame-count/dither optimize panel, the live device-accurate preview, and
 * connect/upload over WebHID (or, on Linux, exporting the payload for
 * play75-upload.py). Identical regardless of whether the frames
 * came from gif/decode.ts or video/decode.ts — this is the shared half of
 * what used to be all of main.ts.
 */
export function createUploadFlow(elements: UploadFlowElements): UploadFlow {
  const {
    previewWrap,
    previewCanvas,
    cropBoxEl,
    cropHandleEl,
    frameInfo,
    optimizePanel,
    frameCountSlider,
    frameCountValue,
    ditherToggle,
    devicePreviewCanvas,
    connectBtn,
    uploadBtn,
    progressWrap,
    progressBar,
    statusEl,
    linuxPanel,
  } = elements;

  const keyboard = new KeyboardScreen();
  let decoded: DecodedGif | null = null;
  let sourceName = "";
  let cropBox: CropBox | null = null;
  let previewScaleX = 1;
  let previewScaleY = 1;
  let sourceAnimationHandle = 0;
  let deviceAnimationHandle = 0;
  let recomputeDebounce = 0;

  // Device preview is always config.screenWidth x config.screenHeight
  // content, scaled up and drawn without smoothing so individual device
  // pixels are visible — a true before/after, not an approximation.
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

  function updateUploadEnabled(): void {
    uploadBtn.disabled = !(decoded && keyboard.isConnected);
    linuxPanel.exportBtn.disabled = !decoded;
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

  /** The exact bytes the device receives: also what the Linux export saves. */
  function buildCurrentPayload(): Uint8Array<ArrayBuffer> {
    const build = buildFrames(decoded!, {
      cropRect: getSourceCropRect(),
      targetFrameCount: Number(frameCountSlider.value),
      dither: ditherToggle.checked,
    });
    return buildPayload(
      build.frames.map((f) => f.rgb565),
      build.delayTicks,
    );
  }

  function scheduleRecompute(): void {
    clearTimeout(recomputeDebounce);
    recomputeDebounce = window.setTimeout(recomputeOptimized, RECOMPUTE_DEBOUNCE_MS);
  }

  function setDecoded(gif: DecodedGif, name: string): void {
    stopSourceAnimation();
    stopDeviceAnimation();
    decoded = gif;
    sourceName = name;

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
        `Source has ${gif.frames.length} frames — it'll be resampled to ${config.maxFrames} across the full loop. Use the frame slider below to pick fewer.`,
      );
    } else {
      setStatus(
        isLinux()
          ? "Drag the crop box, then download the .bin in the “On Linux?” panel below."
          : "Drag the crop box, then connect and upload.",
      );
    }
    updateUploadEnabled();
  }

  frameCountSlider.addEventListener("input", () => {
    frameCountValue.textContent = frameCountSlider.value;
    scheduleRecompute();
  });

  ditherToggle.addEventListener("change", scheduleRecompute);

  connectBtn.disabled = !browserSupportsHid();

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
      const chunks = chunkPayload(buildCurrentPayload());

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

  linuxPanel.exportBtn.addEventListener("click", () => {
    if (!decoded || !cropBox) return;
    try {
      const fileName = `${sourceName.replace(/\.[^.]*$/, "").replace(/[^\w-]+/g, "_") || "screen"}-play75.bin`;
      const url = URL.createObjectURL(new Blob([buildCurrentPayload()], { type: "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      linuxPanel.showRunCommand(fileName);
      setStatus(`Saved ${fileName}. Now run the command in the "On Linux?" panel.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });

  return { setDecoded, setStatus };
}
