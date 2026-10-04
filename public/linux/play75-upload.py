#!/usr/bin/env python3
"""Upload a .bin exported by the keyboard-screen-uploader web app to the
Osume PLAY75's screen, from Linux.

Why this exists: the screen controller (USB 0c45:800b) has two HID
interfaces that matter. The data channel (interface 2) works through the
normal /dev/hidraw node. The control channel (interface 3) has no
interrupt-IN endpoint, so the kernel's HID driver refuses to bind it, and
Chrome's WebHID can't see it. But everything sent on the control channel is
a feature report, and feature reports are plain USB control transfers that
need no interrupt endpoint. So this script sends them straight through
usbfs (/dev/bus/usb/...), and streams the image over hidraw as usual.

Standard library only: no pip packages needed.

Usage:
  python3 play75-upload.py FILE.bin     upload FILE.bin, then sync the clock
  python3 play75-upload.py --clock-only just sync the screen clock

Needs read/write access to the device. Install the udev rule from the web
app's "On Linux?" panel (70-play75.rules), then unplug and replug.
"""
import argparse
import ctypes
import datetime
import errno
import fcntl
import glob
import os
import select
import sys
import time

VID, PID = 0x0C45, 0x800B
CONTROL_IF = 3
DATA_USAGE_PAGE = bytes([0x06, 0x68, 0xFF])  # report descriptor: Usage Page (0xFF68)

# Mirrors src/config.ts.
SCREEN_W, SCREEN_H = 135, 240
MAX_FRAMES = 50
HEADER_SIZE = 256
CHUNK_SIZE = 4096
ACK_TIMEOUT_S = 4.0
CHUNK_PACING_S = 0.015

# HID class requests (HID 1.11 §7.2), addressed to an interface.
SET_REPORT, GET_REPORT, FEATURE = 0x09, 0x01, 0x03
OUT_CLASS_IF, IN_CLASS_IF = 0x21, 0xA1


class CtrlTransfer(ctypes.Structure):
    """struct usbdevfs_ctrltransfer from <linux/usbdevice_fs.h>."""

    _fields_ = [
        ("bRequestType", ctypes.c_uint8),
        ("bRequest", ctypes.c_uint8),
        ("wValue", ctypes.c_uint16),
        ("wIndex", ctypes.c_uint16),
        ("wLength", ctypes.c_uint16),
        ("timeout", ctypes.c_uint32),
        ("data", ctypes.c_void_p),
    ]


def _ioc(direction: int, nr: int, size: int) -> int:
    return (direction << 30) | (size << 16) | (ord("U") << 8) | nr


USBDEVFS_CONTROL = _ioc(3, 0, ctypes.sizeof(CtrlTransfer))  # _IOWR('U', 0, ...)
USBDEVFS_CLAIMINTERFACE = _ioc(2, 15, ctypes.sizeof(ctypes.c_uint))  # _IOR('U', 15, uint)
USBDEVFS_RELEASEINTERFACE = _ioc(2, 16, ctypes.sizeof(ctypes.c_uint))  # _IOR('U', 16, uint)

PERMISSION_HELP = (
    "Install the udev rule from the web app's \"On Linux?\" panel:\n"
    "  sudo cp 70-play75.rules /etc/udev/rules.d/\n"
    "  sudo udevadm control --reload && sudo udevadm trigger\n"
    "then unplug and replug the keyboard."
)


class UploadError(Exception):
    pass


def read_sysfs(path: str) -> str:
    with open(path) as f:
        return f.read().strip()


def find_usb_node() -> str:
    """Returns the /dev/bus/usb/BBB/DDD node for the screen controller."""
    for dev in glob.glob("/sys/bus/usb/devices/*"):
        try:
            if (int(read_sysfs(f"{dev}/idVendor"), 16), int(read_sysfs(f"{dev}/idProduct"), 16)) == (VID, PID):
                bus, num = int(read_sysfs(f"{dev}/busnum")), int(read_sysfs(f"{dev}/devnum"))
                return f"/dev/bus/usb/{bus:03d}/{num:03d}"
        except (OSError, ValueError):
            continue
    raise UploadError("Keyboard screen (USB 0c45:800b) not found. Is the keyboard plugged in by cable?")


def find_data_hidraw() -> str:
    """Returns the /dev/hidrawN node for the screen's data channel (usage page 0xFF68)."""
    want = f"HID_ID=0003:{VID:08X}:{PID:08X}"
    for node in sorted(glob.glob("/sys/class/hidraw/hidraw*")):
        try:
            uevent = read_sysfs(f"{node}/device/uevent")
            with open(f"{node}/device/report_descriptor", "rb") as f:
                descriptor = f.read()
        except OSError:
            continue
        if want in uevent.upper() and descriptor.startswith(DATA_USAGE_PAGE):
            return f"/dev/{os.path.basename(node)}"
    raise UploadError("Found the keyboard screen, but not its data channel (/dev/hidraw with usage page 0xFF68).")


def open_node(path: str) -> int:
    try:
        return os.open(path, os.O_RDWR)
    except PermissionError:
        raise UploadError(f"No permission to open {path}.\n{PERMISSION_HELP}") from None


class Screen:
    def __init__(self, verbose: bool) -> None:
        self.verbose = verbose
        self.usb_fd = open_node(find_usb_node())
        self.hid_fd = open_node(find_data_hidraw())
        try:
            fcntl.ioctl(self.usb_fd, USBDEVFS_CLAIMINTERFACE, ctypes.c_uint(CONTROL_IF))
        except OSError as e:
            self.close()
            if e.errno == errno.EBUSY:
                raise UploadError("The screen's control interface is in use by another driver or program.") from None
            raise

    def close(self) -> None:
        if self.usb_fd >= 0:
            try:
                fcntl.ioctl(self.usb_fd, USBDEVFS_RELEASEINTERFACE, ctypes.c_uint(CONTROL_IF))
            except OSError:
                pass
            os.close(self.usb_fd)
        if self.hid_fd >= 0:
            os.close(self.hid_fd)
        self.usb_fd = self.hid_fd = -1

    def _control(self, request_type: int, request: int, data: ctypes.Array) -> None:
        xfer = CtrlTransfer(
            request_type, request, FEATURE << 8, CONTROL_IF, len(data), 1000, ctypes.addressof(data)
        )
        fcntl.ioctl(self.usb_fd, USBDEVFS_CONTROL, xfer)

    def command(self, name: str, packet: bytearray) -> bytes:
        """Sends a 64-byte feature report (report ID 0) on the control channel and reads the device's ack."""
        self._control(OUT_CLASS_IF, SET_REPORT, (ctypes.c_uint8 * 64).from_buffer_copy(packet))
        reply = (ctypes.c_uint8 * 64)()
        self._control(IN_CLASS_IF, GET_REPORT, reply)
        if self.verbose:
            print(f"  {name:>6}: sent {bytes(packet[:12]).hex(' ')} ... reply {bytes(reply[:12]).hex(' ')} ...")
        return bytes(reply)

    def send_chunk(self, chunk: bytes) -> None:
        # Leading 0x00 = report ID 0; hidraw strips it before sending.
        os.write(self.hid_fd, b"\x00" + chunk)

    def wait_ack(self) -> None:
        ready, _, _ = select.select([self.hid_fd], [], [], ACK_TIMEOUT_S)
        if not ready:
            raise UploadError("The keyboard stopped responding partway through the upload.")
        os.read(self.hid_fd, 64)

    def drain_acks(self) -> None:
        while select.select([self.hid_fd], [], [], 0)[0]:
            os.read(self.hid_fd, 64)


def packet(*head: int) -> bytearray:
    p = bytearray(64)
    p[: len(head)] = bytes(head)
    return p


def sync_clock(screen: Screen) -> None:
    """Four-packet sequence; see KeyboardScreen.timeSync() in src/protocol/hid.ts."""
    now = datetime.datetime.now()
    set_time = packet(0x04, 0x28)
    set_time[8] = 0x01
    # 0x5A is the firmware's time-data discriminator.
    time_data = packet(0x00, 0x01, 0x5A, now.year % 100, now.month, now.day,
                       now.hour, now.minute, now.second, 0x00, now.isoweekday() % 7)
    time_data[62], time_data[63] = 0xAA, 0x55

    screen.command("begin", packet(0x04, 0x18))
    screen.command("op", set_time)
    screen.command("time", time_data)
    screen.command("save", packet(0x04, 0x02))
    print(f"Clock set to {now:%H:%M:%S}.")


def load_payload(path: str) -> bytes:
    with open(path, "rb") as f:
        payload = f.read()
    if len(payload) <= HEADER_SIZE:
        raise UploadError(f"{path} is too small to be an exported screen file.")
    frames = payload[0] + 1
    expected = HEADER_SIZE + frames * SCREEN_W * SCREEN_H * 2
    if frames > MAX_FRAMES or len(payload) != expected:
        raise UploadError(
            f"{path} doesn't look like a file exported from the web app "
            f"(header says {frames} frames, so expected {expected} bytes, got {len(payload)})."
        )
    return payload


def upload(screen: Screen, payload: bytes) -> None:
    """Same sequence as KeyboardScreen.uploadPayload() in src/protocol/hid.ts."""
    chunks = [
        payload[i : i + CHUNK_SIZE].ljust(CHUNK_SIZE, b"\xff") for i in range(0, len(payload), CHUNK_SIZE)
    ]

    screen.command("start", packet(0x04, 0x18))
    try:
        length = packet(0x04, 0x72, 0x02)
        length[8], length[9] = len(chunks) & 0xFF, (len(chunks) >> 8) & 0xFF
        screen.command("length", length)

        screen.drain_acks()
        for i, chunk in enumerate(chunks):
            if i > 0:
                time.sleep(CHUNK_PACING_S)
            screen.send_chunk(chunk)
            screen.wait_ack()
            print(f"\rUploading... {i + 1}/{len(chunks)} chunks", end="", flush=True)
        print()
    finally:
        # Always tell the device we're done, even after a failure or Ctrl+C, so
        # it isn't left waiting for chunks that are never coming.
        try:
            screen.command("end", packet(0x04, 0x02))
        except OSError:
            pass


def main() -> int:
    ap = argparse.ArgumentParser(description="Upload an exported .bin to the PLAY75 screen from Linux.")
    ap.add_argument("file", nargs="?", help=".bin file exported from the web app")
    ap.add_argument("--clock-only", action="store_true", help="only sync the screen clock")
    ap.add_argument("--no-clock", action="store_true", help="don't sync the clock before uploading")
    ap.add_argument("-v", "--verbose", action="store_true", help="print every control packet and reply")
    args = ap.parse_args()
    if not args.file and not args.clock_only:
        ap.error("give a .bin file to upload, or --clock-only")

    try:
        payload = load_payload(args.file) if args.file and not args.clock_only else None
        screen = Screen(args.verbose)
        try:
            if payload is not None:
                upload(screen, payload)
                print("Done. Check your keyboard's screen.")
            # After the upload, not before: a clock save immediately followed by
            # an upload start leaves the device ignoring the first data chunk.
            if not args.no_clock:
                try:
                    sync_clock(screen)
                except OSError as e:
                    # Non-critical, as in the web app.
                    print(f"Clock sync failed ({e}).", file=sys.stderr)
        finally:
            screen.close()
    except UploadError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"Error: {e}", file=sys.stderr)
        print("If the screen looks frozen or corrupted, unplug and replug the keyboard; that's a harmless reset.",
              file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
