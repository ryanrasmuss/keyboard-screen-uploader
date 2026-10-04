import { config } from "../config";

export interface ResamplePlan {
  /** Which original frame index each output frame is drawn from. */
  sourceIndices: number[];
  /** Output delay per frame, in device ticks (config.delayUnitMs each). */
  delayTicks: number[];
}

/**
 * Picks `targetFrameCount` frames spread evenly across the *entire* original
 * loop (by playback time, not by index), instead of truncating from the
 * front. Each output frame gets an equal share of the original total
 * duration, so a long GIF compressed to fewer frames still represents its
 * whole animation, just at a coarser sample rate.
 */
export function planResample(
  originalDelayTicks: number[],
  targetFrameCount: number,
): ResamplePlan {
  const n = originalDelayTicks.length;
  if (n === 0) throw new Error("No source frames to resample.");
  const target = Math.max(1, Math.min(targetFrameCount, config.maxFrames));

  const cumulative: number[] = [0];
  for (const ticks of originalDelayTicks) {
    cumulative.push(cumulative[cumulative.length - 1] + ticks);
  }
  const totalTicks = cumulative[cumulative.length - 1];

  const sourceIndices: number[] = [];
  for (let i = 0; i < target; i++) {
    const t = ((i + 0.5) * totalTicks) / target;
    sourceIndices.push(findFrameAt(cumulative, t));
  }

  const evenDelay = Math.round(totalTicks / target);
  const delayTicks = sourceIndices.map(() =>
    Math.min(config.maxDelayTicks, Math.max(1, evenDelay)),
  );

  return { sourceIndices, delayTicks };
}

/** Binary search: the index of the original frame covering timestamp `t`. */
function findFrameAt(cumulative: number[], t: number): number {
  let lo = 0;
  let hi = cumulative.length - 2; // last valid frame index
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cumulative[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
