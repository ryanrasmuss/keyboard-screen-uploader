/**
 * RGBA -> RGB565 with Floyd-Steinberg error diffusion, to soften the banding
 * that flat truncation (see rgbaToRgb565) produces on gradients at this
 * color depth (65,536 colors). Same little-endian output layout as
 * rgbaToRgb565 — a drop-in alternative.
 */
export function ditherToRgb565(imageData: ImageData): Uint8Array {
  const { width, height, data } = imageData;

  // Float working buffers so accumulated error doesn't clip/wrap like a
  // Uint8 buffer would.
  const r = new Float32Array(width * height);
  const g = new Float32Array(width * height);
  const b = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    r[p] = data[i];
    g[p] = data[i + 1];
    b[p] = data[i + 2];
  }

  const out = new Uint8Array(width * height * 2);

  const quantize = (value: number, bits: number): number => {
    const levels = 1 << bits;
    const step = 256 / levels;
    const clamped = Math.min(255, Math.max(0, value));
    return Math.min(levels - 1, Math.floor(clamped / step));
  };
  const diffuse = (channel: Float32Array, x: number, y: number, error: number): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    channel[y * width + x] += error;
  };

  let o = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;

      const r5 = quantize(r[p], 5);
      const g6 = quantize(g[p], 6);
      const b5 = quantize(b[p], 5);

      const rErr = r[p] - r5 * (256 / 32);
      const gErr = g[p] - g6 * (256 / 64);
      const bErr = b[p] - b5 * (256 / 32);

      diffuse(r, x + 1, y, (rErr * 7) / 16);
      diffuse(r, x - 1, y + 1, (rErr * 3) / 16);
      diffuse(r, x, y + 1, (rErr * 5) / 16);
      diffuse(r, x + 1, y + 1, (rErr * 1) / 16);

      diffuse(g, x + 1, y, (gErr * 7) / 16);
      diffuse(g, x - 1, y + 1, (gErr * 3) / 16);
      diffuse(g, x, y + 1, (gErr * 5) / 16);
      diffuse(g, x + 1, y + 1, (gErr * 1) / 16);

      diffuse(b, x + 1, y, (bErr * 7) / 16);
      diffuse(b, x - 1, y + 1, (bErr * 3) / 16);
      diffuse(b, x, y + 1, (bErr * 5) / 16);
      diffuse(b, x + 1, y + 1, (bErr * 1) / 16);

      const value = (r5 << 11) | (g6 << 5) | b5;
      out[o++] = value & 0xff;
      out[o++] = (value >> 8) & 0xff;
    }
  }

  return out;
}
