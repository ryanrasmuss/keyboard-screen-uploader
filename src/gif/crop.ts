export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Crops one decoded frame to the target size, letterboxing with `background` if the crop rect's aspect doesn't match (it should, since the UI locks it, but this keeps the math safe regardless). */
export function cropFrameToImageData(
  bitmap: ImageBitmap,
  rect: CropRect,
  targetWidth: number,
  targetHeight: number,
  background = "#000",
): ImageData {
  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get a 2D canvas context for cropping.");

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(
    bitmap,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    targetWidth,
    targetHeight,
  );
  return ctx.getImageData(0, 0, targetWidth, targetHeight);
}
