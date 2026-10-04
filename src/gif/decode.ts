import { config } from "../config";

export interface DecodedGif {
  width: number;
  height: number;
  frames: ImageBitmap[];
  /** Per-frame display duration, in device delay ticks (config.delayUnitMs each), clamped to config.maxDelayTicks. */
  delayTicks: number[];
}

export function browserSupportsGifDecode(): boolean {
  return "ImageDecoder" in window;
}

export async function decodeGif(file: File): Promise<DecodedGif> {
  if (!browserSupportsGifDecode()) {
    throw new Error(
      "This browser can't decode GIFs frame-by-frame (missing the ImageDecoder API). Use a recent Chrome or Edge.",
    );
  }

  const data = await file.arrayBuffer();
  const decoder = new ImageDecoder({ data, type: "image/gif" });
  await decoder.tracks.ready;

  const track = decoder.tracks.selectedTrack;
  if (!track) {
    decoder.close();
    throw new Error("Couldn't find an image track in this file — is it really a GIF?");
  }

  const frameCount = track.frameCount;
  if (frameCount === 0) {
    decoder.close();
    throw new Error("This GIF has no frames.");
  }

  const frames: ImageBitmap[] = [];
  const delayTicks: number[] = [];
  let width = 0;
  let height = 0;

  try {
    for (let i = 0; i < frameCount; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      width = image.displayWidth;
      height = image.displayHeight;

      frames.push(await createImageBitmap(image));

      const durationUs = image.duration ?? 100_000; // default ~100ms if the encoder omitted it
      const ticks = Math.round(durationUs / 1000 / config.delayUnitMs);
      delayTicks.push(Math.min(config.maxDelayTicks, Math.max(1, ticks)));

      image.close();
    }
  } finally {
    decoder.close();
  }

  return { width, height, frames, delayTicks };
}
