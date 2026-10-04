import type { UploadStatus } from "../protocol/hid";

export function formatStatus(status: UploadStatus): string {
  switch (status.kind) {
    case "connecting":
      return "Waiting for device selection…";
    case "connected":
      return "Connected.";
    case "time-sync-failed":
      return "Connected (clock sync failed — upload should still work).";
    case "starting-transfer":
      return "Starting transfer…";
    case "progress":
      return status.total === 0
        ? "Uploading…"
        : `Uploading… ${status.sent}/${status.total} chunks`;
    case "finished":
      return "Done — check your keyboard's screen.";
    case "error":
      return status.message;
  }
}
