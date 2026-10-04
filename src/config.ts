// Reverse-engineered from the PLAY75 web configurator's bundled JS
// (play75.netlify.app/assets/index-*.js). Swap these to target a different
// keyboard/screen without touching the rest of the app.
export const config = {
  vendorId: 0x0c45,
  productId: 0x800b,

  screenWidth: 135,
  screenHeight: 240,

  maxFrames: 50,
  headerSize: 256,
  chunkSize: 4096,

  // Per-frame delay byte: units of 2ms, cross-checked against an independent
  // hardware-confirmed implementation for a sibling Sonix-family keyboard
  // (github.com/d991d/ajazz-control). 0xFF (255) is reserved as the header's
  // "no frame here" padding sentinel — a real delay must never collide with
  // it, or the device mis-renders (observed there as a "torn panel").
  delayUnitMs: 2,
  maxDelayTicks: 254,

  // HID collections on the device: a control channel for command/handshake
  // feature reports, and a data channel for the bulk pixel stream.
  controlUsage: { usage: 1, usagePage: 0xff13 },
  // Confirmed against real hardware — the original static analysis mis-
  // converted the decimal value from the bundle (65384) as 0xFF88; it's 0xFF68.
  dataUsage: { usage: 0x61, usagePage: 0xff68 },

  ackTimeoutMs: 4000,
  chunkPacingMs: 15,
} as const;
