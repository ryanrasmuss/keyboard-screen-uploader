import { config } from "../config";

export interface LimitsPanelElements {
  screenDimsEl: HTMLElement;
  deviceIdsEl: HTMLElement;
  limitResolutionEl: HTMLElement;
  limitFramesEl: HTMLElement;
  limitDelayEl: HTMLElement;
  limitPayloadEl: HTMLElement;
}

function hex(n: number): string {
  return `0x${n.toString(16).padStart(4, "0")}`;
}

/** Fills in the footer device-id line and the "GIF upload limits" panel from config — identical on both pages, so the numbers can't drift between them. */
export function populateLimitsPanel(elements: LimitsPanelElements): void {
  elements.screenDimsEl.textContent = `${config.screenWidth}×${config.screenHeight}`;
  elements.deviceIdsEl.textContent = `${hex(config.vendorId)}:${hex(config.productId)}`;

  elements.limitResolutionEl.textContent = `${config.screenWidth}×${config.screenHeight} px`;
  elements.limitFramesEl.textContent = `${config.maxFrames}`;
  elements.limitDelayEl.textContent = `${config.delayUnitMs}–${config.maxDelayTicks * config.delayUnitMs} ms`;

  const maxPayloadBytes =
    config.headerSize + config.maxFrames * config.screenWidth * config.screenHeight * 2;
  elements.limitPayloadEl.textContent = `~${(maxPayloadBytes / 1_000_000).toFixed(1)} MB`;
}
