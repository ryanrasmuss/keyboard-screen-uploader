import { config } from "./config";
import type { DecodedGif } from "./gif/decode";
import { cropFrameToImageData, type CropRect } from "./gif/crop";
import { planResample } from "./gif/resample";
import { rgbaToRgb565, rgb565ToImageData } from "./pixel/rgb565";
import { ditherToRgb565 } from "./pixel/dither";

export interface BuildOptions {
  cropRect: CropRect;
  targetFrameCount: number;
  dither: boolean;
}

export interface BuiltFrame {
  rgb565: Uint8Array;
  /** Exactly what was quantized, decoded back for display — not an approximation. */
  preview: ImageData;
}

/**
 * The single pipeline both the live "on the screen" preview and the actual
 * upload go through — resample -> crop -> quantize — so what you see before
 * uploading is provably what gets sent, not a separately-maintained guess.
 */
export function buildFrames(
  decoded: DecodedGif,
  opts: BuildOptions,
): { frames: BuiltFrame[]; delayTicks: number[] } {
  const plan = planResample(decoded.delayTicks, opts.targetFrameCount);

  const frames = plan.sourceIndices.map((sourceIndex) => {
    const cropped = cropFrameToImageData(
      decoded.frames[sourceIndex],
      opts.cropRect,
      config.screenWidth,
      config.screenHeight,
    );
    const rgb565 = opts.dither ? ditherToRgb565(cropped) : rgbaToRgb565(cropped);
    const preview = rgb565ToImageData(rgb565, config.screenWidth, config.screenHeight);
    return { rgb565, preview };
  });

  return { frames, delayTicks: plan.delayTicks };
}
