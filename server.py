#!/usr/bin/env python3
"""Pannello web locale per le cuffie Haylou S30 ANC.

Parla con le cuffie via RFCOMM (canale 10) usando il protocollo Haylou
(lo stesso delle S35 ANC supportate da Gadgetbridge) e serve una pagina
su http://127.0.0.1:8730. Solo libreria standard.
Gira su Linux (BlueZ + PipeWire) e su Windows (anche come .exe PyInstaller).
"""

import argparse
import base64
import io
import json
import math
import os
import re
import socket
import struct
import subprocess
import sys
import threading
import time
import wave
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

PORT = 8730
RFCOMM_CHANNEL = 10
NAME_HINT = "HAYLOU"
IDLE_EXIT_SECONDS = 90

IS_WINDOWS = sys.platform == "win32"
IS_LINUX = sys.platform.startswith("linux")
FROZEN = getattr(sys, "frozen", False)  # eseguibile PyInstaller

HERE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
STATIC = HERE / "static"
CONFIG_DIR = Path(os.environ.get("APPDATA", Path.home())) / "haylou-s30" if IS_WINDOWS \
    else Path.home() / ".config" / "haylou-s30"
STATE_FILE = CONFIG_DIR / "state.json"

HEADER_TX = bytes.fromhex("aabbccc0")
HEADER_RX = bytes.fromhex("aabbcc00")
FOOTER = bytes.fromhex("ddeeff")

ANC_MODES = {"off": 0x00, "anc": 0x01, "transparency": 0x02}
EQ_PRESETS = {"default": 0x00, "rock": 0x02, "classic": 0x03, "bass": 0x06, "soft": 0x07}
FEATURE_ANC, FEATURE_GAME, FEATURE_MULTIPOINT = 0x04, 0x05, 0x09


class DeviceError(Exception):
    pass


def find_headphones():
    """Restituisce (mac, nome) delle cuffie Haylou connesse."""
    if IS_WINDOWS:
        return find_headphones_windows()
    out = subprocess.run(["bluetoothctl", "devices", "Connected"],
                         capture_output=True, text=True, timeout=5).stdout
    for line in out.splitlines():
        parts = line.split(" ", 2)
        if len(parts) == 3 and NAME_HINT in parts[2].upper():
            return parts[1], parts[2]
    raise DeviceError("Cuffie Haylou non connesse via Bluetooth")


def find_headphones_windows():
    """Su Windows il MAC sta nell'InstanceId del dispositivo Bluetooth (es. BTHENUM\\...\\..._04349563CE5D)."""
    ps = ("Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -like '*" + NAME_HINT + "*' } | "
          "ForEach-Object { $_.FriendlyName + '|' + $_.InstanceId }")
    out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True,
                         timeout=15, creationflags=subprocess.CREATE_NO_WINDOW).stdout
    for line in out.splitlines():
        name, _, instance = line.partition("|")
        m = re.search(r"(?<![0-9A-F-])([0-9A-F]{12})(?![0-9A-F])", instance.upper())
        if m:
            mac = ":".join(m.group(1)[i:i + 2] for i in range(0, 12, 2))
            return mac, name.strip()
    raise DeviceError("Cuffie Haylou non trovate: accoppiale e collegale da Impostazioni → Bluetooth")


def bluetoothctl(action, mac):
    out = subprocess.run(["bluetoothctl", action, mac], capture_output=True, text=True, timeout=20)
    if out.returncode != 0:
        raise DeviceError(f"bluetoothctl {action} fallito: {(out.stdout + out.stderr).strip().splitlines()[-1:]}")


class Headphones:
    def __init__(self):
        self.lock = threading.Lock()
        self.sock = None
        self.mac = None
        self.buf = b""

    def _connect(self):
        self.mac, _ = find_headphones()
        s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
        s.settimeout(5)
        try:
            s.connect((self.mac, RFCOMM_CHANNEL))
        except OSError as e:
            s.close()
            raise DeviceError(f"Connessione RFCOMM fallita: {e}")
        self.sock, self.buf = s, b""

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None

    def _read_frame(self, deadline):
        """Legge un frame completo (header ... footer) dal socket."""
        while True:
            start = self.buf.find(b"\xaa\xbb\xcc")
            if start >= 0:
                end = self.buf.find(FOOTER, start + 7)
                if end >= 0:
                    frame, self.buf = self.buf[start:end + 3], self.buf[end + 3:]
                    return frame
            remaining = deadline - time.time()
            if remaining <= 0:
                raise DeviceError("Nessuna risposta dalle cuffie")
            self.sock.settimeout(remaining)
            try:
                chunk = self.sock.recv(1024)
            except socket.timeout:
                raise DeviceError("Nessuna risposta dalle cuffie")
            if not chunk:
                raise DeviceError("Connessione chiusa dalle cuffie")
            self.buf += chunk

    def command(self, payload: bytes):
        """Invia un comando e restituisce il payload della risposta con lo stesso opcode."""
        with self.lock:
            for attempt in range(2):
                try:
                    if self.sock is None:
                        self._connect()
                    self.sock.sendall(HEADER_TX + payload + FOOTER)
                    deadline = time.time() + 3
                    while True:
                        frame = self._read_frame(deadline)
                        # i frame spontanei delle cuffie hanno header aabbccc0: li ignoriamo
                        if frame[:4] == HEADER_RX and frame[4] == payload[0]:
                            length = struct.unpack(">H", frame[5:7])[0]
                            return frame[7:7 + length]
                except (OSError, DeviceError):
                    self.close()
                    if attempt == 1:
                        raise
        raise DeviceError("Errore sconosciuto")

    def expect_ok(self, payload: bytes):
        resp = self.command(payload)
        if resp[:2] != b"\x00\x00":
            raise DeviceError(f"Comando rifiutato dalle cuffie ({resp.hex()})")

    def info(self):
        resp = self.command(bytes.fromhex("020005000000000f"))
        fields, i = {}, 2
        while i < len(resp):
            n = resp[i]
            if n == 0 or i + 1 + n > len(resp):
                break
            fields[resp[i + 1]] = resp[i + 2:i + 1 + n]
            i += 1 + n
        name = fields.get(0, b"").decode(errors="replace")
        fw = fields.get(1, b"")
        battery = fields.get(2, b"\xff")[0]
        return {
            "name": name,
            "firmware": ".".join(f"{b:x}" for b in fw) if fw else None,
            "battery": None if battery > 100 else battery,
            "mac": self.mac,
        }

    def set_feature(self, feature, value):
        self.expect_ok(bytes([0x08, 0x00, 0x04, 0x00, 0x02, feature, value]))

    def set_eq(self, preset):
        self.expect_ok(bytes([0xF2, 0x00, 0x05, 0x00, 0x03, 0x00, 0x07, preset]))

    def find(self, start):
        self.expect_ok(bytes([0xF2, 0x00, 0x06, 0x00, 0x04, 0x00, 0x09, 1 if start else 0, 0x03]))


# --- test microfono (via PipeWire/PulseAudio, profilo HFP) ---

def pactl_json(*args):
    out = subprocess.run(["pactl", "-f", "json", *args], capture_output=True, text=True, timeout=5)
    return json.loads(out.stdout or "[]")


def mic_test(mac, seconds=4):
    card_name = "bluez_card." + mac.replace(":", "_")
    card = next((c for c in pactl_json("list", "cards") if c["name"] == card_name), None)
    if card is None:
        raise DeviceError("Scheda audio Bluetooth delle cuffie non trovata")
    previous = card["active_profile"]
    profiles = card.get("profiles", {})
    target = next((p for p in ("headset-head-unit-msbc", "headset-head-unit", "headset-head-unit-cvsd")
                   if p in profiles and profiles[p].get("available", True)), None)
    if target is None:
        raise DeviceError("Profilo cuffia+microfono (HFP) non disponibile")

    rate = 16000
    try:
        if previous != target:
            subprocess.run(["pactl", "set-card-profile", card_name, target], check=True, timeout=5)
        source = None
        for _ in range(20):
            for s in pactl_json("list", "sources"):
                props = s.get("properties", {})
                if props.get("api.bluez5.address", "").upper() == mac.upper() and \
                        not s["name"].endswith(".monitor"):
                    source = s["name"]
            if source:
                break
            time.sleep(0.25)
        if source is None:
            raise DeviceError("Ingresso microfono delle cuffie non trovato")
        time.sleep(0.5)  # lascia stabilizzare il collegamento SCO
        proc = subprocess.Popen(["parec", "-d", source, "--raw", "--format=s16le",
                                 f"--rate={rate}", "--channels=1"], stdout=subprocess.PIPE)
        time.sleep(seconds)
        proc.terminate()
        raw = proc.communicate(timeout=5)[0]
    finally:
        if previous != target:
            subprocess.run(["pactl", "set-card-profile", card_name, previous], timeout=5)

    samples = struct.unpack(f"<{len(raw) // 2}h", raw[:len(raw) // 2 * 2])
    if not samples:
        raise DeviceError("Nessun dato registrato dal microfono")
    peak = max(abs(s) for s in samples)
    rms = math.sqrt(sum(s * s for s in samples) / len(samples))
    db = lambda v: round(20 * math.log10(v / 32768), 1) if v > 0 else -120.0

    wav = io.BytesIO()
    with wave.open(wav, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(raw)

    peak_db = db(peak)
    if peak == 0:
        verdict = "silent"
    elif peak_db < -45:
        verdict = "weak"
    else:
        verdict = "ok"
    return {"peak_db": peak_db, "rms_db": db(rms), "verdict": verdict, "profile": target,
            "wav": base64.b64encode(wav.getvalue()).decode()}


# --- stato locale (le cuffie non riportano le impostazioni correnti) ---

def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return {}


def save_state(**changes):
    state = load_state()
    state.update(changes)
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))
    return state


# --- HTTP ---

device = Headphones()
last_request = time.time()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        global last_request
        last_request = time.time()
        if self.path == "/api/status":
            try:
                info = device.info()
                if load_state().get("mac") != info["mac"]:
                    save_state(mac=info["mac"])
                self._send(200, {"connected": True, **info, "settings": load_state()})
            except DeviceError as e:
                self._send(200, {"connected": False, "error": str(e), "settings": load_state()})
            return
        if self.path == "/api/ping":
            # la pagina usa queste info per scegliere test microfono e pulsante Collega
            self._send(200, {"ok": True, "platform": sys.platform,
                             "server_mic": IS_LINUX, "bt_control": IS_LINUX})
            return
        name = "index.html" if self.path in ("/", "/index.html") else self.path.lstrip("/")
        path = (STATIC / name).resolve()
        if STATIC not in path.parents or not path.is_file():
            self._send(404, {"error": "not found"})
            return
        ctype = {".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png",
                 ".js": "text/javascript; charset=utf-8",
                 ".webmanifest": "application/manifest+json"}.get(path.suffix, "application/octet-stream")
        self._send(200, path.read_bytes(), ctype)

    def do_POST(self):
        global last_request
        last_request = time.time()
        # accetta solo richieste dalla pagina stessa
        origin = self.headers.get("Origin")
        if origin and origin not in (f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"):
            self._send(403, {"error": "origin non consentita"})
            return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if self.path == "/api/anc":
                device.set_feature(FEATURE_ANC, ANC_MODES[body["mode"]])
                result = save_state(anc=body["mode"])
            elif self.path == "/api/game":
                device.set_feature(FEATURE_GAME, 1 if body["on"] else 0)
                result = save_state(game=bool(body["on"]))
            elif self.path == "/api/multipoint":
                device.set_feature(FEATURE_MULTIPOINT, 1 if body["on"] else 0)
                result = save_state(multipoint=bool(body["on"]))
            elif self.path == "/api/eq":
                device.set_eq(EQ_PRESETS[body["preset"]])
                result = save_state(eq=body["preset"])
            elif self.path == "/api/find":
                device.find(bool(body["on"]))
                result = {"ok": True}
            elif self.path in ("/api/disconnect", "/api/connect") and not IS_LINUX:
                raise DeviceError("Collega/scollega le cuffie dalle impostazioni Bluetooth del sistema")
            elif self.path == "/api/disconnect":
                mac = device.mac or find_headphones()[0]
                device.close()
                bluetoothctl("disconnect", mac)
                result = {"ok": True}
            elif self.path == "/api/connect":
                mac = load_state().get("mac")
                if not mac:
                    raise DeviceError("Cuffie mai viste: collegale una volta dalle impostazioni Bluetooth")
                bluetoothctl("connect", mac)
                result = {"ok": True}
            elif self.path == "/api/mic-test":
                mac = device.mac or find_headphones()[0]
                result = mic_test(mac)
            else:
                self._send(404, {"error": "not found"})
                return
            self._send(200, {"ok": True, "result": result})
        except (KeyError, ValueError) as e:
            self._send(400, {"error": f"richiesta non valida: {e}"})
        except (DeviceError, subprocess.SubprocessError, OSError) as e:
            self._send(503, {"error": str(e)})


def idle_watchdog(server):
    while True:
        time.sleep(10)
        if time.time() - last_request > IDLE_EXIT_SECONDS:
            device.close()
            server.shutdown()
            return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--open", action="store_true", help="apri il browser all'avvio")
    ap.add_argument("--no-idle-exit", action="store_true", help="non chiudere il server a pagina chiusa")
    args = ap.parse_args()
    if FROZEN:
        args.open = True  # doppio clic sull'.exe: apri subito la pagina
    url = f"http://127.0.0.1:{PORT}/"

    try:
        server = HTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        # già in esecuzione: apri solo la pagina
        if args.open:
            webbrowser.open(url)
        return

    if not args.no_idle_exit:
        threading.Thread(target=idle_watchdog, args=(server,), daemon=True).start()
    if args.open:
        threading.Timer(0.3, webbrowser.open, args=(url,)).start()
    print(f"Haylou S30 panel su {url}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        device.close()


if __name__ == "__main__":
    os.chdir(HERE)
    main()
