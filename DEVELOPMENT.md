# Development notes

## What this is

A self-hosted replacement for the Osume PLAY75 keyboard's official web
configurator (`play75.netlify.app/screen`), which crops a GIF and pushes it
to the keyboard's 135×240 screen but silently fails on some GIFs with no
usable error message. This app does the same job — plus more — by
reverse-engineering the actual device protocol from the official site's own
JS bundle, rather than reusing its fragile code.

Two pages, one shared pipeline:

- **`index.html`** — pick a GIF, crop it, optimize it, upload it.
- **`video.html`** — pick a video, trim a range, then the identical
  crop/optimize/upload flow. Linked from both pages' headers.

Everything runs in the browser (Chrome/Edge only — WebHID and the
`ImageDecoder`/`requestVideoFrameCallback` APIs used here are Chromium-only).
Docker only serves the static files; it never touches the keyboard directly.

## What was built, in order

1. **The uploader itself** (`src/gif/`, `src/pixel/`, `src/protocol/`,
   `src/ui/`, `src/main.ts`) — decode a GIF frame-by-frame, crop to 135×240,
   convert to RGB565, and stream it to the keyboard over WebHID using a
   protocol fully reverse-engineered from the vendor app's minified bundle
   (connection handshake, chunked transfer with per-chunk acks, the 256-byte
   header + RGB565 payload format).
2. **A safety pass** — checked whether any of this could damage the keyboard.
   Short answer: no. Full reasoning (separate HID interfaces from the
   keymap/VIA channel, firmware flashing requires a physical key-hold into a
   totally different USB identity, the main MCU's flash is too small to hold
   image data) is in `README.md`'s Safety section.
3. **Real-hardware fixes** — two bugs found only by testing against the
   actual keyboard: a wrong `usagePage` hex conversion, and a wrong
   delay-byte time unit (corrected from an independent hardware-confirmed
   reference for a sibling keyboard, see README).
4. **An in-app "GIF upload limits" panel** and a printable reference sheet,
   so the hard limits (max 50 frames, 2–508ms per-frame delay, 65,536
   colors, ~3.1MB max payload) are visible from inside the tool itself, not
   buried in docs.
5. **The "Optimize for the screen" panel** (`src/pipeline.ts`,
   `src/gif/resample.ts`, `src/pixel/dither.ts`) — a GIF longer than 50
   frames is now evenly resampled across its *whole* loop instead of just
   truncated, plus optional Floyd–Steinberg dithering to reduce color
   banding at 65,536 colors, plus a live "on the screen" preview that's
   pixel-and-timing-accurate to what actually gets uploaded.
6. **The video page** (`src/video/decode.ts`, `video.html`,
   `src/video-main.ts`) — captures a trimmed video range as the same
   `{frames, delayTicks}` shape the GIF decoder produces, so the entire
   crop/optimize/upload flow (`src/ui/upload-flow.ts`) works unchanged
   regardless of source. No video/GIF encoder needed anywhere — this app
   never produces a real `.gif` file, only the device's raw pixel format.

Full protocol details, the exact device constants, and known open questions
(e.g. whether uploads target a specific screen slot) are documented in
`README.md`, not repeated here.

## Docker setup guide

### Prerequisites

- Docker Desktop (Windows/Mac) or Docker Engine (Linux), running.
- Chrome or Edge to actually use the app (WebHID + the decode APIs are
  Chromium-only — Firefox/Safari can't run this regardless of how it's served).

### Run it

From this directory:

```sh
docker compose up --build
```

First build takes a minute or two (pulls `node:20-alpine` and `nginx:alpine`,
installs deps, runs `npm run build`). Then open:

- **http://localhost:8080/** — GIF uploader
- **http://localhost:8080/video.html** — video uploader

### Stop it

```sh
docker compose down
```

This stops and removes the container (and its network); it does not touch
the built image, so the next `up --build` reuses Docker's layer cache and is
much faster.

### After changing code

```sh
docker compose up --build -d
```

Rebuilds the image (only the changed layers — `npm install`'s layer is
cached unless `package.json` changed) and recreates the container. The `-d`
flag runs it in the background; drop it to see logs in the foreground.

### Rebuilding from scratch

If something seems stale (rare, but Docker layer caching can occasionally
serve an old build):

```sh
docker compose build --no-cache
docker compose up -d
```

### Checking it's actually running

```sh
docker ps --filter "name=keyboard-screen-uploader"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/
```

A `200` means it's up. `docker compose logs -f` tails the nginx container's
logs if a page isn't loading as expected.

### Deploying anywhere other than localhost

WebHID requires a secure context. `http://localhost:8080` qualifies
automatically in Chromium; any other host (a LAN IP, a remote server) needs
HTTPS in front of it or `navigator.hid` will be blocked outright. Out of
scope for this setup — see `README.md`'s "Deploying beyond localhost"
section if that's ever needed.
