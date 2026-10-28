# Haylou S30 panel

Control panel for the **Haylou S30 ANC** headphones on a computer, since the official
app only exists for phones.

| | How | Requirements |
|---|---|---|
| **Windows** | download `HaylouS30.exe` from [Releases](../../releases/latest) and run it | none |
| **Linux** | `python3 server.py --open` | Python 3.9+, BlueZ, PipeWire/PulseAudio |

It opens a panel in the browser at http://127.0.0.1:8730. The headphones must already be
paired and connected to the computer.

The [web page](https://josemariasava.github.io/haylou-s30/) only has the download links and
the microphone test: a browser can't control the headphones, because Chrome/Edge block
Bluetooth services with SIG-base UUIDs in Web Serial, including theirs (`0000fd3d-…`).

## Features
- Audio mode: ANC / transparency / off
- Equalizer presets
- Game mode, multipoint, find headphones
- Battery, firmware
- Microphone test: records 4 s, measures the level and plays it back.
  On Windows and on the web page you pick the microphone: the one used for calls is the
  **Headset / Hands-Free** device.
- Linux only: Connect/Disconnect the headphones (to hand them over to another computer)

## Linux
`server.py` uses only the standard library. It serves http://127.0.0.1:8730 and exits by itself
~90 s after the page is closed. For a menu entry copy `linux/haylou-s30.desktop` to
`~/.local/share/applications/` (adjust the path in `Exec`).
The microphone test temporarily switches to the HFP profile with `pactl`, then back to A2DP.

## Build
- Push to `main` touching `static/` → publishes the page to GitHub Pages.
- Tag `v*` → GitHub Actions builds `HaylouS30.exe` with PyInstaller, smoke-tests it and attaches
  it to the release.

## Protocol
Bluetooth serial on service `0000fd3d-0000-1000-8000-00805f9b34fb` (JL_SPP, RFCOMM channel 10;
JieLi chip). Same protocol as the Haylou S35 ANC supported by
[Gadgetbridge](https://codeberg.org/Freeyourgadget/Gadgetbridge/pulls/6407).
The standard Serial Port service (RFCOMM channel 1) does not answer these commands.

- Command: `aabbccc0` + payload + `ddeeff`
- Response: `aabbcc00` + opcode + length (2 bytes) + payload + `ddeeff`; status `0000` = ok
- Unsolicited messages from the headphones: header `aabbccc0`
- Info: `02 0005 00 <32-bit mask>` → TLV entries (len, type, value): 0 name, 1 firmware, 2 battery
- Features: `08 0004 00 02 <feature> <value>` — 04 ANC (0 off, 1 ANC, 2 transparency), 05 game, 09 multipoint
- EQ: `f2 0005 00 03 00 07 <preset>` (0 default, 2 rock, 3 classical, 6 bass, 7 soft)
- Find headphones: `f2 0006 00 04 00 09 <0/1> 03`

The headphones don't report their current settings: the panel shows the last ones chosen
(stored in `~/.config/haylou-s30/state.json`, `%APPDATA%\haylou-s30` on Windows).
