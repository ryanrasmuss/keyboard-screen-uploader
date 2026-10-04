// Minimal WebHID surface. TypeScript's bundled lib.dom.d.ts does not include
// the WebHID API (unlike WebCodecs/ImageDecoder, which it does), so it's
// declared here by hand against the spec: https://wicg.github.io/webhid/

interface HIDDeviceFilter {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

interface HIDDeviceRequestOptions {
  filters: HIDDeviceFilter[];
}

interface HIDCollectionInfo {
  usagePage: number;
  usage: number;
  collections?: HIDCollectionInfo[];
}

interface HIDInputReportEvent extends Event {
  readonly device: HIDDevice;
  readonly reportId: number;
  readonly data: DataView;
}

interface HIDDeviceEventMap {
  inputreport: HIDInputReportEvent;
}

declare class HIDDevice extends EventTarget {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: HIDCollectionInfo[];
  oninputreport: ((this: HIDDevice, ev: HIDInputReportEvent) => unknown) | null;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
  sendFeatureReport(reportId: number, data: Uint8Array): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
  addEventListener<K extends keyof HIDDeviceEventMap>(
    type: K,
    listener: (this: HIDDevice, ev: HIDDeviceEventMap[K]) => unknown,
  ): void;
  removeEventListener<K extends keyof HIDDeviceEventMap>(
    type: K,
    listener: (this: HIDDevice, ev: HIDDeviceEventMap[K]) => unknown,
  ): void;
}

interface HIDEventMap {
  connect: Event;
  disconnect: Event;
}

declare class HID extends EventTarget {
  requestDevice(options: HIDDeviceRequestOptions): Promise<HIDDevice[]>;
  getDevices(): Promise<HIDDevice[]>;
  addEventListener<K extends keyof HIDEventMap>(
    type: K,
    listener: (this: HID, ev: HIDEventMap[K]) => unknown,
  ): void;
}

interface Navigator {
  readonly hid: HID;
}
