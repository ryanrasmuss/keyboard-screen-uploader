# keyboard-screen-uploader

A self-hosted replacement for the PLAY75 web configurator's GIF-to-screen tool.
Crops a GIF (or a video clip) in-browser and streams it straight to the
keyboard's 135×240 screen over WebHID — no server-side involvement beyond
serving the static page. On Linux, where WebHID can't reach the screen, the
page exports the same data for a small local upload script instead.

## Compatibility

Tested on the **Osume PLAY75**, whose screen is driven by a separate Sonix
controller (USB `0C45:800B`). Other keyboards with Sonix-based screen modules
may work too, but likely need their vendor/product ID, screen size, or HID
usage pages adjusted in `src/config.ts` — all device constants live there.

| Host OS | How uploads work |
|---|---|
| Windows, macOS | Directly from the page over WebHID |
| Linux | Export a `.bin` from the page, upload it with `play75-upload.py` (see [Linux setup](#linux-setup)) |

## Why this exists

The official tool (`play75.netlify.app/screen`) silently fails on some GIFs
with no usable error message. Reading its bundled JS turned up two things:

1. Its crop step relies on an old, fragile hand-rolled GIF decoder whose
   failures are either swallowed to `console.error` only, or are uncaught
   exceptions in an unguarded animation-frame loop — nothing reaches the UI.
2. The device never actually receives a GIF file. The site decodes the
   (already-cropped) GIF into raw RGB565 frames with a small header and
   streams that over WebHID — a fact you'd only learn by decompiling the
   bundle, since it's not documented anywhere.

This app skips the fragile custom re-encoder entirely (it was never needed)
and decodes GIFs with the browser's native `ImageDecoder`, which is far more
robust and gives every failure a real message.

## Requirements

- **Chrome, Chromium, or Edge** (desktop). The keyboard connection uses
  WebHID, which Firefox and Safari don't support.
- Docker, to build/run the container.
- **Linux only:** Python 3 and a udev rule; uploads go through a small
  script instead of WebHID. See [Linux setup](#linux-setup).

## Run it

```sh
docker compose up --build
```

Then open **http://localhost:8080** in Chrome, Chromium, or Edge.

For local development without Docker (needs Node 20+):

```sh
npm install
npm run dev
```

## Linux setup

On Linux, **Connect keyboard** can't work. The screen controller's control
channel (USB interface 3) has no interrupt-IN endpoint, which the HID spec
requires, so the kernel's HID driver refuses to attach to it
(`usbhid ...: couldn't find an input interrupt endpoint`) and the browser
never sees it. Windows and macOS tolerate this; Linux doesn't.

Every message on that channel is a feature report, though, and feature
reports are plain USB control transfers that need no interrupt endpoint. So
Linux gets its own workflow: the web app exports the exact bytes it would
have uploaded as a `.bin`, and a small Python script
([`public/linux/play75-upload.py`](public/linux/play75-upload.py), standard
library only) sends the control commands through usbfs and streams the image
through the data channel's normal `/dev/hidraw` node.

The page shows this as an **On Linux?** panel below the upload controls.
It's open by default on Linux, and links to both files.

**One-time setup:** download `play75-upload.py` and `70-play75.rules`
from that panel, then install the rule so the script doesn't need `sudo`:

```sh
sudo cp ~/Downloads/70-play75.rules /etc/udev/rules.d/
sudo udevadm control --reload
sudo udevadm trigger
```

Unplug and replug the keyboard afterwards. The rule
([`public/linux/70-play75.rules`](public/linux/70-play75.rules)) grants the
logged-in user access to the screen controller's raw USB device and its
hidraw nodes only. The keyboard's QMK/VIA interface and your other devices
keep their normal permissions.

**Each upload:** crop and optimize as usual, click **Download .bin** in the
panel, then run:

```sh
python3 ~/Downloads/play75-upload.py ~/Downloads/<name>-play75.bin
```

After uploading, the script also syncs the screen clock. `--clock-only`
syncs just the clock, `--no-clock` skips it, and `-v` prints every control
packet and the device's reply.

### Adapting the rule

- **A different keyboard.** Find its screen controller's ID with `lsusb`.
  For example, `ID 0c45:800b Microdia Play75` means vendor `0c45`, product
  `800b`. Put those in both lines of the rule (lowercase hex, no `0x`), in
  `src/config.ts`, and in `VID, PID` at the top of the script.
- **The rule file name.** Keep the number below `73` (e.g. `70-…`). The
  `uaccess` tag is applied by systemd's `73-seat-late.rules`, so a rule
  that sorts after it has no effect.
- **Systems without systemd-logind** (e.g. some Void, Alpine, or Gentoo
  setups), where `uaccess` does nothing. Replace `TAG+="uaccess"` with
  `GROUP="plugdev", MODE="0660"` on both lines, create the group if needed
  (`sudo groupadd plugdev`), add yourself with `sudo usermod -aG plugdev $USER`,
  then log out and back in.

## Usage

1. Choose a GIF.
2. Drag/resize the crop box (locked to the device's screen aspect ratio).
3. Click **Connect keyboard** and pick the device in the browser's picker.
4. Click **Crop & upload**.

On Linux, replace steps 3–4 with **Download .bin** in the **On Linux?**
panel and the command shown there.

Max 50 frames per GIF — that's a device-side limit, not something this app
imposes arbitrarily.

## Video uploader (`video.html`)

A second page (linked from the header of both pages) for converting a video
clip instead of a GIF. Since this app never produces a real `.gif` file — it
goes straight from decoded frames to the device's raw pixel format — video
support doesn't need a video encoder, a GIF encoder, or ffmpeg.wasm. It only
needed one new piece: `src/video/decode.ts`, which captures a trimmed range
of a video as the same `{frames, delayTicks}` shape `gif/decode.ts` produces.
Everything downstream (crop box, frame-count/dither optimize panel, device
preview, WebHID upload or Linux `.bin` export — factored into
`src/ui/upload-flow.ts`) is shared between both pages unchanged.

Capture uses a plain `<video>` element + `requestVideoFrameCallback` rather
than WebCodecs' `VideoDecoder` — less code, and it renders with the file's
rotation metadata already applied (a raw demuxer would need to handle that
itself). Frames are sampled at up to 20fps regardless of the source's native
frame rate, since the result is immediately resampled down to the device's
frame budget anyway. Usage: pick a video, scrub to set a start/end range
(number inputs, or "use current time" while scrubbing), click **Use this
range**, then crop/optimize/upload exactly as on the GIF page.

## Safety

**Short answer: this can produce a garbled picture, but it can't brick the
keyboard.** Some reasoning behind that, in case you want to check it yourself:

- This app only ever opens two specific HID collections on a specific
  `vendorId:productId` — the ones the vendor's own configurator uses for the
  screen feature (see Protocol notes below). It never touches the keyboard's
  separate QMK/VIA raw-HID interface (`usagePage 0xFF60`), which is where
  keymaps and macros live. A bad image upload has no path to touching your
  keybindings.
- The Linux script is held to the same boundary: it opens only the
  `0C45:800B` screen controller, claims only its control interface (3, which
  has no kernel driver), writes only to the data channel's hidraw node
  (interface 2), and never detaches a kernel driver from anything.
- **Confirmed from Osume's own firmware guide**: flashing new firmware onto
  this keyboard requires physically holding ESC while cold-plugging the USB
  cable, to force the (separate) main MCU into DFU mode — at which point it
  re-enumerates under an entirely different USB identity (`342D:DFA0`, a WB32
  bootloader) than the screen's `0C45:800B`. There's no HID command that
  reaches that mode; it's a deliberate hardware step this app never performs.
- The same guide shows the main keyboard MCU (WB32) has **256KB flash / 36KB
  SRAM** — far too small to hold GIF image data (a 50-frame upload alone is
  ~3.24MB). That confirms the screen images live on separate storage tied to
  the Sonix screen chip, not anywhere near the keymap/firmware.
- Firmware flashing itself is a category of thing entirely separate from
  image upload (bootloader entry + a dedicated flashing tool, e.g.
  [SonixQMK/sonix-flasher](https://github.com/SonixQMK/sonix-flasher) for
  this chip family in general) — not something reachable via the ordinary
  "upload an image" HID commands used here.
- An independent, MIT-licensed, hardware-confirmed implementation for a
  sibling Sonix-family keyboard
  ([d991d/ajazz-control](https://github.com/d991d/ajazz-control)) documents
  exactly what happens when this kind of upload goes wrong: the screen shows
  a corrupted/torn frame, and it clears with a normal **unplug/replug** of
  the keyboard. No re-flash, no data loss — it's stuck display state, not
  damage.
- That project is also where the delay-byte unit below (2ms/tick, avoid
  `0xFF`) came from — it's the one detail in this app that's backed by real
  hardware testing rather than reading minified JS.

If an upload ever looks wrong on-screen: unplug, replug, try again.

## Protocol notes (reverse-engineered)

- **Device**: WebHID, `vendorId 0x0C45`, `productId 0x800B`. Two HID
  collections matter: a control channel (`usagePage 0xFF13, usage 1`, USB
  interface 3) and a bulk data channel (`usagePage 0xFF68, usage 0x61`, USB
  interface 2) — confirmed against a real Play75 unit; see `src/config.ts`.
  The control interface declares 64-byte input, output and feature reports
  but has only an interrupt-OUT endpoint, which is why Linux won't bind it.
  The data channel takes 4096-byte output reports and acks each with a
  64-byte input report.
- **Replies**: every control command is a feature report, followed by a
  feature-report read. The reply echoes the command, and byte 3 is a status:
  `0x01` OK, `0xFF` rejected or nothing to do.
- **Handshake**: on connect, four 64-byte feature reports sync the device's
  clock, each acked: `0x04 0x18` (begin) → `0x04 0x28` with byte 8 = `0x01`
  (set-time op) → `0x00 0x01 0x5A yy mm dd hh mm ss 0x00 dow`, with
  `0xAA 0x55` in bytes 62–63 (time data) → `0x04 0x02` (save). Taken from
  d991d/ajazz-control's hardware-confirmed protocol notes and verified on a
  real PLAY75. The time-data packet alone is rejected. Don't start an upload
  immediately after this: a clock save directly followed by a transfer start
  makes the device ignore the first data chunk.
- **Transfer**: `0x04 0x18` (start) → ack → `0x04 0x72 0x02` + chunk count
  (little-endian, bytes 8–9) → ack → stream data chunks (each acked via
  `oninputreport` before the next is sent) → `0x04 0x02` (end) → ack. The end
  command is sent even if the transfer fails partway, so the device isn't
  left waiting for chunks that are never coming.
- **Payload**: 256-byte header (`byte[0]` = frame count − 1, `byte[1..N]` =
  per-frame delay in 2ms ticks, capped at 254 — `0xFF` is the header's
  padding sentinel and a real delay must never collide with it) followed by
  each frame's pixels as **RGB565, little-endian**. Sliced into 4096-byte
  chunks, last one padded with `0xFF`.

Most of this started as static analysis of minified JS, not a USB packet
capture. Since then the clock handshake and the full transfer sequence have
been verified on a real PLAY75 (via the Linux script, which sends the same
bytes as the WebHID path), and the RGB565 byte order and delay-tick unit
were cross-checked against d991d/ajazz-control's hardware-confirmed
implementation for a sibling device. If a real upload still behaves oddly
(device doesn't respond, wrong colors, wrong timing), see
`src/protocol/hid.ts` and `src/protocol/payload.ts`.

Device/screen constants live in one place — `src/config.ts` — if you ever
need to point this at a different keyboard.

**One open question**: Osume's product page says the screen has 4 slots —
3 built-in preset animations plus 1 custom slot — but nothing we've found
documents how a slot is selected on the wire, and our upload doesn't send an
explicit slot index. It's most likely hardcoded to the custom slot (simplest
implementation, and the only thing the official tool needs to target), but
this hasn't been confirmed. Worst case if it's wrong: a preset animation
gets overwritten instead of the custom slot — not damage, just an annoyance,
and the official tool can presumably restore presets.

## Deploying beyond localhost

WebHID requires a "secure context." `http://localhost:8080` qualifies
automatically in Chromium, so no extra setup is needed for local use. If you
deploy this to any other host (a LAN IP, a remote server), Chromium will
block `navigator.hid` unless it's served over HTTPS — you'll need a reverse
proxy or cert for that.

## License

MIT — see [LICENSE](LICENSE).
