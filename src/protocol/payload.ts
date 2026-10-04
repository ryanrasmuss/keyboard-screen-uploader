import { config } from "../config";

/**
 * Wire payload layout (reverse-engineered from the PLAY75 bundle):
 *   [0]        frame count - 1
 *   [1..N]     per-frame delay, in config.delayUnitMs ticks, one byte each
 *   [N+1..255] padding (0xFF)
 *   [256..]    RGB565 pixel bytes for each frame, concatenated
 *
 * 0xFF is reserved as the padding sentinel, so a real delay must never be
 * written as 0xFF — see config.maxDelayTicks.
 */
export function buildPayload(frameBytes: Uint8Array[], delayTicks: number[]): Uint8Array<ArrayBuffer> {
  if (frameBytes.length === 0) {
    throw new Error("No frames to upload.");
  }
  if (frameBytes.length !== delayTicks.length) {
    throw new Error("Frame/delay count mismatch — this is an internal bug.");
  }
  if (frameBytes.length > config.maxFrames) {
    throw new Error(
      `This GIF has ${frameBytes.length} frames, but the device accepts at most ${config.maxFrames}. Trim it or drop the frame rate.`,
    );
  }

  const header = new Uint8Array(config.headerSize).fill(0xff);
  header[0] = frameBytes.length - 1;
  for (let i = 0; i < delayTicks.length; i++) {
    header[i + 1] = Math.min(config.maxDelayTicks, Math.max(1, delayTicks[i]));
  }

  const totalFrameBytes = frameBytes.reduce((sum, f) => sum + f.length, 0);
  const payload = new Uint8Array(header.length + totalFrameBytes);
  payload.set(header, 0);

  let offset = header.length;
  for (const frame of frameBytes) {
    payload.set(frame, offset);
    offset += frame.length;
  }

  return payload;
}

/** Slices the payload into fixed-size report chunks, padding the final chunk with 0xFF. */
export function chunkPayload(payload: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < payload.length; offset += config.chunkSize) {
    const chunk = new Uint8Array(config.chunkSize).fill(0xff);
    chunk.set(payload.subarray(offset, offset + config.chunkSize), 0);
    chunks.push(chunk);
  }
  return chunks;
}
