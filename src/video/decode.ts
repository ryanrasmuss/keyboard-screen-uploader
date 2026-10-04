import { config } from "../config";
import type { DecodedGif } from "../gif/decode";

// Captured frames feed straight into gif/resample.ts's even-spread resampling
// down to <=50 frames, so there's no benefit to capturing at the source's
// native frame rate — only slower decode and more memory for long/high-fps
// clips. This caps how often we actually grab a frame.
const MAX_SAMPLE_FPS = 20;
const MIN_FRAME_INTERVAL_SEC = 1 / MAX_SAMPLE_FPS;

export interface VideoRange {
  startSec: number;
  endSec: number;
}

export function browserSupportsVideoDecode(): boolean {
  return (
    typeof HTMLVideoElement !== "undefined" &&
    "requestVideoFrameCallback" in HTMLVideoElement.prototype
  );
}

function waitForEvent(target: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve) => target.addEventListener(event, () => resolve(), { once: true }));
}

async function seekTo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  video.currentTime = timeSec;
  await waitForEvent(video, "seeked");
}

/**
 * Captures a trimmed range of a video file as a DecodedGif — the same shape
 * gif/decode.ts produces — so everything downstream (crop, optimize, RGB565,
 * upload) works unchanged regardless of whether the source was a GIF or a
 * video. Uses a plain <video> element rather than WebCodecs' VideoDecoder:
 * far less code, and it renders with the file's rotation metadata already
 * applied (phone videos often carry a "display this sideways" flag — a
 * canvas draw from a rendered <video> inherits the correct orientation for
 * free; a raw demuxer would not).
 */
export async function decodeVideo(file: File, range: VideoRange): Promise<DecodedGif> {
  if (!browserSupportsVideoDecode()) {
    throw new Error(
      "This browser can't capture video frames (missing requestVideoFrameCallback). Use a recent Chrome or Edge.",
    );
  }
  if (range.endSec <= range.startSec) {
    throw new Error("End time must be after start time.");
  }

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await waitForEvent(video, "loadedmetadata");

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      throw new Error("Couldn't read this video's dimensions — is it a supported format?");
    }
    const endSec = Math.min(range.endSec, video.duration || range.endSec);

    await seekTo(video, range.startSec);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get a 2D canvas context for video capture.");

    const framePromises: Promise<ImageBitmap>[] = [];
    const timestamps: number[] = [];

    await new Promise<void>((resolve, reject) => {
      let lastCaptureTime = -Infinity;

      const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        if (metadata.mediaTime >= endSec) {
          video.pause();
          resolve();
          return;
        }
        if (metadata.mediaTime - lastCaptureTime >= MIN_FRAME_INTERVAL_SEC) {
          ctx.drawImage(video, 0, 0, width, height);
          framePromises.push(createImageBitmap(canvas));
          timestamps.push(metadata.mediaTime);
          lastCaptureTime = metadata.mediaTime;
        }
        video.requestVideoFrameCallback(onFrame);
      };

      video.requestVideoFrameCallback(onFrame);
      video.addEventListener("ended", () => resolve(), { once: true });
      video.addEventListener(
        "error",
        () => reject(new Error("Video playback failed during capture.")),
        { once: true },
      );
      void video.play();
    });

    const frames = await Promise.all(framePromises);
    if (frames.length === 0) {
      throw new Error("No frames captured in that range — try a longer range.");
    }

    const delayTicks = timestamps.map((t, i) => {
      const deltaSec =
        i < timestamps.length - 1
          ? timestamps[i + 1] - t
          : t - (timestamps[i - 1] ?? t - MIN_FRAME_INTERVAL_SEC);
      const ticks = Math.round((deltaSec * 1000) / config.delayUnitMs);
      return Math.min(config.maxDelayTicks, Math.max(1, ticks));
    });

    return { width, height, frames, delayTicks };
  } finally {
    video.pause();
    video.src = "";
    URL.revokeObjectURL(url);
  }
}
