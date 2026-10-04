import { config } from "../config";
import { isLinux } from "../ui/linux-panel";

export type UploadStatus =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "time-sync-failed"; error: unknown }
  | { kind: "starting-transfer" }
  | { kind: "progress"; sent: number; total: number }
  | { kind: "finished" }
  | { kind: "error"; message: string };

export type StatusListener = (status: UploadStatus) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function browserSupportsHid(): boolean {
  return "hid" in navigator;
}

function hex(n: number): string {
  return `0x${n.toString(16).padStart(2, "0")}`;
}

/** Formats exactly what Chrome granted us, for diagnosing a usage/usagePage mismatch against real hardware. */
function describeDevices(devices: HIDDevice[]): string {
  const describeCollection = (c: HIDCollectionInfo, depth: number): string => {
    const indent = "  ".repeat(depth);
    const children = (c.collections ?? [])
      .map((child) => describeCollection(child, depth + 1))
      .join("");
    return `${indent}- usage=${hex(c.usage)} usagePage=${hex(c.usagePage)}\n${children}`;
  };

  return devices
    .map((device, i) => {
      const collections = device.collections.map((c) => describeCollection(c, 1)).join("");
      return (
        `device[${i}] "${device.productName}" vendorId=${hex(device.vendorId)} productId=${hex(device.productId)}\n` +
        collections
      );
    })
    .join("\n");
}

export class KeyboardScreen {
  private controlDevice: HIDDevice | null = null;
  private dataDevice: HIDDevice | null = null;

  get isConnected(): boolean {
    return !!this.controlDevice?.opened && !!this.dataDevice?.opened;
  }

  /** Prompts the browser's device picker, opens the two HID interfaces we need, and best-effort syncs the device clock. */
  async connect(onStatus?: StatusListener): Promise<void> {
    if (!browserSupportsHid()) {
      throw new Error("WebHID isn't available in this browser. Use a recent Chrome or Edge.");
    }

    onStatus?.({ kind: "connecting" });

    const devices = await navigator.hid.requestDevice({
      filters: [{ vendorId: config.vendorId, productId: config.productId }],
    });
    if (devices.length === 0) {
      throw new Error("No device was selected.");
    }

    let controlDevice: HIDDevice | null = null;
    let dataDevice: HIDDevice | null = null;
    for (const device of devices) {
      for (const collection of device.collections) {
        if (
          collection.usage === config.controlUsage.usage &&
          collection.usagePage === config.controlUsage.usagePage
        ) {
          controlDevice = device;
        }
        if (
          collection.usage === config.dataUsage.usage &&
          collection.usagePage === config.dataUsage.usagePage
        ) {
          dataDevice = device;
        }
      }
    }
    if (dataDevice && !controlDevice && isLinux()) {
      throw new Error(
        "Linux doesn't let the browser reach the screen's control channel. " +
          "Use the “On Linux?” panel below to upload with a small script instead.",
      );
    }
    if (!controlDevice || !dataDevice) {
      const found = describeDevices(devices);
      console.error("Expected HID collections not found. What Chrome actually granted:\n" + found);
      throw new Error(
        "Found a matching device, but it doesn't expose the expected screen HID interfaces. " +
          "Open the browser console for the exact collections Chrome granted — paste that back " +
          "so the usage/usagePage values in src/config.ts can be corrected. " +
          "(Also worth checking: if Chrome's device picker listed more than one entry, try " +
          "reconnecting and selecting all of them, not just one.)",
      );
    }

    if (!controlDevice.opened) await controlDevice.open();
    if (!dataDevice.opened) await dataDevice.open();

    this.controlDevice = controlDevice;
    this.dataDevice = dataDevice;

    try {
      await this.timeSync();
    } catch (error) {
      // Non-critical — the upload itself doesn't depend on the clock being right.
      onStatus?.({ kind: "time-sync-failed", error });
    }

    onStatus?.({ kind: "connected" });
  }

  /**
   * Syncs the device's real-time clock. Four feature reports, each acked:
   * begin (0x04 0x18) → set-time op (0x04 0x28, byte 8 = 1) → the time data
   * itself → save (0x04 0x02). Sequence from d991d/ajazz-control's
   * hardware-confirmed docs/PROTOCOL.md for a sibling Sonix keyboard, and
   * verified on a real PLAY75. Sending only the time-data packet, as the
   * original site's bundle appeared to, is rejected by the device.
   */
  private async timeSync(): Promise<void> {
    if (!this.controlDevice) throw new Error("Not connected.");
    const controlDevice = this.controlDevice;
    const command = async (packet: Uint8Array) => {
      await controlDevice.sendFeatureReport(0, packet);
      await controlDevice.receiveFeatureReport(0);
    };

    const now = new Date();
    const beginPacket = new Uint8Array(64);
    beginPacket[0] = 4;
    beginPacket[1] = 24;

    const opPacket = new Uint8Array(64);
    opPacket[0] = 4;
    opPacket[1] = 40;
    opPacket[8] = 1;

    // 0x00 0x01 0x5A — 0x5A is the firmware's time-data discriminator, which
    // is why this packet doesn't start with the usual 0x04.
    const timePacket = new Uint8Array(64);
    timePacket[1] = 1;
    timePacket[2] = 0x5a;
    timePacket[3] = now.getFullYear() % 100;
    timePacket[4] = now.getMonth() + 1;
    timePacket[5] = now.getDate();
    timePacket[6] = now.getHours();
    timePacket[7] = now.getMinutes();
    timePacket[8] = now.getSeconds();
    timePacket[10] = now.getDay();
    timePacket[62] = 0xaa;
    timePacket[63] = 0x55;

    const savePacket = new Uint8Array(64);
    savePacket[0] = 4;
    savePacket[1] = 2;

    await command(beginPacket);
    await command(opPacket);
    await command(timePacket);
    await command(savePacket);
  }

  async uploadPayload(chunks: Uint8Array[], onStatus?: StatusListener): Promise<void> {
    if (!this.controlDevice || !this.dataDevice) {
      throw new Error("Not connected.");
    }
    if (chunks.length === 0) {
      throw new Error("Nothing to upload.");
    }
    const controlDevice = this.controlDevice;
    const dataDevice = this.dataDevice;

    onStatus?.({ kind: "starting-transfer" });

    // 0x04 0x18 — announce start of transfer.
    const startPacket = new Uint8Array(64);
    startPacket[0] = 4;
    startPacket[1] = 24;
    await controlDevice.sendFeatureReport(0, startPacket);
    await controlDevice.receiveFeatureReport(0);

    // 0x04 0x72 0x02 — announce chunk count, little-endian at bytes [8..9].
    const lenPacket = new Uint8Array(64);
    lenPacket[0] = 4;
    lenPacket[1] = 114;
    lenPacket[2] = 2;
    lenPacket[8] = chunks.length & 0xff;
    lenPacket[9] = (chunks.length >> 8) & 0xff;
    await controlDevice.sendFeatureReport(0, lenPacket);
    await controlDevice.receiveFeatureReport(0);

    try {
      await this.streamChunks(dataDevice, chunks, onStatus);
    } catch (error) {
      // The device is mid-transfer and expecting more chunks that are never
      // coming. Best-effort tell it we're done anyway, so it doesn't sit
      // waiting — see sendEndOfTransfer()'s doc comment.
      await this.sendEndOfTransfer().catch(() => {});
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${reason} If the screen looks corrupted or frozen now, unplug and replug the keyboard — that's a known, harmless way this display recovers from an interrupted upload.`,
      );
    }

    await this.sendEndOfTransfer();
    onStatus?.({ kind: "finished" });
  }

  /**
   * 0x04 0x02 — tells the device the transfer is complete.
   *
   * A sibling Sonix-family display (github.com/d991d/ajazz-control) documents
   * that an interrupted/malformed upload can leave the panel showing a
   * corrupted frame until the keyboard is power-cycled — not lasting damage,
   * just stuck display state. Always sending this, even after a failure,
   * minimizes the chance of leaving the device stuck mid-transfer.
   */
  private async sendEndOfTransfer(): Promise<void> {
    if (!this.controlDevice) return;
    const endPacket = new Uint8Array(64);
    endPacket[0] = 4;
    endPacket[1] = 2;
    await this.controlDevice.sendFeatureReport(0, endPacket);
    await this.controlDevice.receiveFeatureReport(0);
  }

  /** Sends chunk 0, then waits for the device's `oninputreport` ack before sending each next chunk. */
  private streamChunks(
    dataDevice: HIDDevice,
    chunks: Uint8Array[],
    onStatus?: StatusListener,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let index = 0;
      let timeoutHandle: ReturnType<typeof setTimeout>;

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        dataDevice.oninputreport = null;
      };

      const armTimeout = () => {
        clearTimeout(timeoutHandle);
        timeoutHandle = setTimeout(() => {
          cleanup();
          reject(new Error("The device stopped responding partway through the upload."));
        }, config.ackTimeoutMs);
      };

      dataDevice.oninputreport = () => {
        if (index >= chunks.length - 1) {
          cleanup();
          resolve();
          return;
        }
        index++;
        onStatus?.({ kind: "progress", sent: index, total: chunks.length });
        armTimeout();
        sleep(config.chunkPacingMs)
          .then(() => dataDevice.sendReport(0, chunks[index]))
          .catch((error) => {
            cleanup();
            reject(error);
          });
      };

      armTimeout();
      onStatus?.({ kind: "progress", sent: 0, total: chunks.length });
      dataDevice.sendReport(0, chunks[0]).catch((error) => {
        cleanup();
        reject(error);
      });
    });
  }
}
