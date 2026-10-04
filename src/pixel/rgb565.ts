/**
 * RGBA -> RGB565, little-endian (low byte then high byte) per pixel.
 * Matches the byte order the keyboard firmware expects, reverse-engineered
 * from the original site's pixel-packing routine.
 */
export function rgbaToRgb565(imageData: ImageData): Uint8Array {
  const { data, width, height } = imageData;
  const out = new Uint8Array(width * height * 2);

  let o = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const value = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
    out[o++] = value & 0xff; // low byte
    out[o++] = (value >> 8) & 0xff; // high byte
  }

  return out;
}

/**
 * The inverse of rgbaToRgb565/ditherToRgb565, for previewing exactly what
 * was quantized (not an approximation of it). Uses the same 8x/4x
 * reconstruction as dither.ts's error term, so the preview matches what the
 * dithering pass actually optimized against.
 */
export function rgb565ToImageData(bytes: Uint8Array, width: number, height: number): ImageData {
  const out = new ImageData(width, height);
  let o = 0;
  for (let i = 0; i < bytes.length; i += 2, o += 4) {
    const value = bytes[i] | (bytes[i + 1] << 8);
    const r5 = (value >> 11) & 0x1f;
    const g6 = (value >> 5) & 0x3f;
    const b5 = value & 0x1f;
    out.data[o] = r5 * 8;
    out.data[o + 1] = g6 * 4;
    out.data[o + 2] = b5 * 8;
    out.data[o + 3] = 255;
  }
  return out;
}
