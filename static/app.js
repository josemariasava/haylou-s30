// Haylou S30 panel — funziona in due modi:
//  - "server": pagina servita da server.py (Linux), comandi via /api
//  - "serial": pagina aperta da HTTPS (es. GitHub Pages) in Chrome/Edge, comandi via Web Serial

const SERVICE_UUID = "0000fd3d-0000-1000-8000-00805f9b34fb"; // JL_SPP, RFCOMM canale 10
const HEADER_TX = [0xaa, 0xbb, 0xcc, 0xc0];
const FOOTER = [0xdd, 0xee, 0xff];
const ANC_MODES = { off: 0x00, anc: 0x01, transparency: 0x02 };
const EQ_PRESETS = { default: 0x00, rock: 0x02, classic: 0x03, bass: 0x06, soft: 0x07 };
const FEATURE = { anc: 0x04, game: 0x05, multipoint: 0x09 };
const STORAGE_KEY = "haylou-s30-settings";

const $ = (id) => document.getElementById(id);
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---------- trasporto server (Linux) ----------

class ServerDevice {
  kind = "server";

  constructor(caps) { this.caps = caps; }

  async post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Errore " + r.status);
    return data.result;
  }
  async status() { return (await fetch("/api/status")).json(); }
  connect() { return this.post("/api/connect"); }
  disconnect() { return this.post("/api/disconnect"); }
  anc(mode) { return this.post("/api/anc", { mode }); }
  eq(preset) { return this.post("/api/eq", { preset }); }
  game(on) { return this.post("/api/game", { on }); }
  multipoint(on) { return this.post("/api/multipoint", { on }); }
  find(on) { return this.post("/api/find", { on }); }
  micTest() { return this.post("/api/mic-test"); }
}

// ---------- trasporto Web Serial (Chrome/Edge, anche Windows) ----------

class SerialDevice {
  kind = "serial";
  port = null;
  reader = null;
  loopDone = null;
  buf = [];
  waiters = [];
  queue = Promise.resolve();

  static supported() { return "serial" in navigator; }

  isOurs(port) { return port.getInfo().bluetoothServiceClassId === SERVICE_UUID; }

  // riapre una porta già autorizzata in passato, senza chiedere nulla
  async reconnect() {
    const ports = await navigator.serial.getPorts();
    const port = ports.find((p) => this.isOurs(p));
    if (!port) return false;
    try { await this.open(port); return true; } catch { return false; }
  }

  async connect() {
    const port = await navigator.serial.requestPort({
      filters: [{ bluetoothServiceClassId: SERVICE_UUID }],
      allowedBluetoothServiceClassIds: [SERVICE_UUID],
    });
    await this.open(port);
  }

  async open(port) {
    await port.open({ baudRate: 115200 });
    this.port = port;
    this.buf = [];
    this.loopDone = this.readLoop();
  }

  async disconnect() {
    const port = this.port;
    this.port = null;
    try { await this.reader?.cancel(); } catch {}
    await this.loopDone;
    try { await port?.close(); } catch {}
  }

  async readLoop() {
    const port = this.port;
    while (port.readable && this.port === port) {
      this.reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          this.buf.push(...value);
          this.extractFrames();
        }
      } catch {
        break;
      } finally {
        this.reader.releaseLock();
      }
    }
    if (this.port === port) {
      this.port = null;
      try { await port.close(); } catch {}
      onDisconnected();
    }
  }

  extractFrames() {
    for (;;) {
      let start = -1;
      for (let i = 0; i + 2 < this.buf.length; i++) {
        if (this.buf[i] === 0xaa && this.buf[i + 1] === 0xbb && this.buf[i + 2] === 0xcc) { start = i; break; }
      }
      if (start < 0 || this.buf.length < start + 7) return;
      const len = (this.buf[start + 5] << 8) | this.buf[start + 6];
      const total = 7 + len + FOOTER.length;
      if (this.buf.length < start + total) return;
      const frame = this.buf.slice(start, start + total);
      this.buf = this.buf.slice(start + total);
      // le risposte hanno header aabbcc00; i messaggi spontanei (aabbccc0) li ignoriamo
      if (frame[3] !== 0x00) continue;
      const i = this.waiters.findIndex((w) => w.opcode === frame[4]);
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(frame.slice(7, 7 + len));
    }
  }

  command(payload) {
    const run = async () => {
      if (!this.port) throw new Error("Cuffie non collegate");
      const response = new Promise((resolve, reject) => {
        const waiter = { opcode: payload[0], resolve };
        this.waiters.push(waiter);
        setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) { this.waiters.splice(i, 1); reject(new Error("Nessuna risposta dalle cuffie")); }
        }, 3000);
      });
      const writer = this.port.writable.getWriter();
      try { await writer.write(new Uint8Array([...HEADER_TX, ...payload, ...FOOTER])); }
      finally { writer.releaseLock(); }
      return response;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async expectOk(payload) {
    const resp = await this.command(payload);
    if (resp[0] !== 0 || resp[1] !== 0) throw new Error("Comando rifiutato dalle cuffie (" + hex(resp) + ")");
  }

  async info() {
    const resp = await this.command([0x02, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0x0f]);
    const fields = {};
    for (let i = 2; i < resp.length;) {
      const n = resp[i];
      if (!n || i + 1 + n > resp.length) break;
      fields[resp[i + 1]] = resp.slice(i + 2, i + 1 + n);
      i += 1 + n;
    }
    const battery = fields[2]?.[0];
    return {
      name: fields[0] ? new TextDecoder().decode(new Uint8Array(fields[0])) : "",
      firmware: fields[1] ? fields[1].map((b) => b.toString(16)).join(".") : null,
      battery: battery != null && battery <= 100 ? battery : null,
    };
  }

  async status() {
    const settings = loadLocalSettings();
    if (!this.port) return { connected: false, error: "Non collegate", settings };
    try { return { connected: true, ...(await this.info()), settings }; }
    catch (e) { return { connected: false, error: e.message, settings }; }
  }

  async setFeature(name, value) {
    await this.expectOk([0x08, 0x00, 0x04, 0x00, 0x02, FEATURE[name], value]);
  }
  async anc(mode) { await this.setFeature("anc", ANC_MODES[mode]); saveLocalSettings({ anc: mode }); }
  async game(on) { await this.setFeature("game", on ? 1 : 0); saveLocalSettings({ game: on }); }
  async multipoint(on) { await this.setFeature("multipoint", on ? 1 : 0); saveLocalSettings({ multipoint: on }); }
  async eq(preset) {
    await this.expectOk([0xf2, 0x00, 0x05, 0x00, 0x03, 0x00, 0x07, EQ_PRESETS[preset]]);
    saveLocalSettings({ eq: preset });
  }
  find(on) { return this.expectOk([0xf2, 0x00, 0x06, 0x00, 0x04, 0x00, 0x09, on ? 1 : 0, 0x03]); }
}

function loadLocalSettings() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; }
}
function saveLocalSettings(changes) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadLocalSettings(), ...changes })); } catch {}
}

// ---------- test microfono nel browser ----------

async function listMics() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput" && d.deviceId);
}

async function browserMicTest(deviceId, seconds, onLevel) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    },
  });
  const label = stream.getAudioTracks()[0]?.label || "";
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const chunks = [];
  const rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.start();

  const data = new Float32Array(analyser.fftSize);
  let peak = 0, sumSq = 0, count = 0;
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    analyser.getFloatTimeDomainData(data);
    let framePeak = 0;
    for (const v of data) {
      const a = Math.abs(v);
      if (a > framePeak) framePeak = a;
      sumSq += v * v;
    }
    count += data.length;
    peak = Math.max(peak, framePeak);
    onLevel?.(framePeak, 1 - (end - performance.now()) / (seconds * 1000));
    await new Promise((r) => setTimeout(r, 50));
  }
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  ctx.close();

  const db = (v) => (v > 0 ? Math.round(200 * Math.log10(v)) / 10 : -120);
  const peakDb = db(peak);
  return {
    peak_db: peakDb,
    rms_db: db(Math.sqrt(sumSq / Math.max(count, 1))),
    verdict: peak === 0 ? "silent" : peakDb < -45 ? "weak" : "ok",
    source: label,
    url: URL.createObjectURL(new Blob(chunks, { type: rec.mimeType })),
  };
}

// ---------- UI ----------

let dev = null;
let toastTimer;

function toast(msg, err = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "show" + (err ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = err ? "err" : ""), 2600);
}

function markActive(groupId, value) {
  for (const b of $(groupId).querySelectorAll("button")) b.classList.toggle("active", b.dataset.v === value);
}

function applySettings(s) {
  if (s.anc) markActive("anc", s.anc);
  if (s.eq) markActive("eq", s.eq);
  if (typeof s.game === "boolean") $("game").checked = s.game;
  if (typeof s.multipoint === "boolean") $("multipoint").checked = s.multipoint;
}

function setConnected(connected, text) {
  $("dot").className = "dot " + (connected ? "on" : "off");
  $("conn").textContent = text;
  $("connbtn").textContent = connected ? "Scollega" : "Collega";
  $("connbtn").dataset.connected = connected ? "1" : "";
  document.body.classList.toggle("disconnected", !connected);
}

async function refresh() {
  try {
    const s = await dev.status();
    applySettings(s.settings || {});
    if (s.connected) {
      $("name").textContent = s.name || "Haylou S30";
      $("meta").textContent = [s.mac, s.firmware && "FW " + s.firmware].filter(Boolean).join(" · ");
      setConnected(true, "Connesse");
      if (s.battery != null) {
        $("bat").textContent = s.battery + "%";
        $("batfill").style.width = s.battery + "%";
        $("batfill").style.background = s.battery <= 20 ? "var(--bad)" : s.battery <= 40 ? "var(--warn)" : "var(--ok)";
      }
    } else {
      setConnected(false, s.error || "Non connesse");
    }
  } catch {
    setConnected(false, "Server non raggiungibile");
  }
}

function onDisconnected() {
  setConnected(false, "Collegamento perso");
}

function bindGroup(groupId, method, label) {
  $(groupId).addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const buttons = $(groupId).querySelectorAll("button");
    buttons.forEach((x) => (x.disabled = true));
    try {
      await dev[method](b.dataset.v);
      markActive(groupId, b.dataset.v);
      toast(label + ": " + b.textContent);
    } catch (err) { toast(err.message, true); }
    buttons.forEach((x) => (x.disabled = false));
  });
}

function bindToggle(id, label) {
  $(id).addEventListener("change", async (e) => {
    const on = e.target.checked;
    e.target.disabled = true;
    try {
      await dev[id](on);
      toast(label + (on ? " attivo" : " disattivato"));
    } catch (err) { e.target.checked = !on; toast(err.message, true); }
    e.target.disabled = false;
  });
}

function showMicResult(r) {
  const verdicts = {
    ok: ["Il microfono funziona", "var(--ok)"],
    weak: ["Segnale molto debole", "var(--warn)"],
    silent: ["Nessun segnale: il microfono non registra", "var(--bad)"],
  };
  const [text, color] = verdicts[r.verdict];
  $("verdict").textContent = text;
  $("verdict").style.color = color;
  $("micmeter").style.width = Math.max(0, Math.min(100, ((r.peak_db + 60) / 60) * 100)) + "%";
  $("micmeter").style.background = color;
  $("micdb").textContent = `Picco ${r.peak_db} dBFS · media ${r.rms_db} dBFS · ${r.source || r.profile}`;
  $("micaudio").src = r.url || "data:audio/wav;base64," + r.wav;
  $("micres").style.display = "block";
}

async function fillMicSelect() {
  const sel = $("micsel");
  const mics = await listMics();
  const previous = sel.value;
  sel.innerHTML = "";
  for (const m of mics) {
    const o = document.createElement("option");
    o.value = m.deviceId;
    o.textContent = m.label || "Microfono " + (sel.length + 1);
    sel.append(o);
  }
  const preferred = mics.find((m) => m.deviceId === previous) ||
    mics.find((m) => /haylou|hands-free|headset|auricolare/i.test(m.label));
  if (preferred) sel.value = preferred.deviceId;
  $("micpick").style.display = mics.length ? "flex" : "none";
}

function bindMic() {
  const btn = $("mic");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Parla ora…";
    try {
      if (serverMic()) {
        showMicResult(await dev.micTest());
      } else {
        const r = await browserMicTest($("micsel").value, 4, (level, progress) => {
          $("micres").style.display = "block";
          $("verdict").textContent = "Registrazione… " + Math.round(progress * 100) + "%";
          $("verdict").style.color = "";
          $("micmeter").style.width = Math.min(100, level * 140) + "%";
          $("micmeter").style.background = "var(--accent)";
        });
        showMicResult(r);
        await fillMicSelect(); // dopo il permesso i nomi dei microfoni diventano visibili
      }
    } catch (err) {
      toast(err.name === "NotAllowedError" ? "Permesso microfono negato" : err.message, true);
    }
    btn.disabled = false;
    btn.textContent = "Avvia test";
  });
}

// su Linux il server cambia profilo Bluetooth e registra; altrove registra il browser
const serverMic = () => dev.kind === "server" && dev.caps.server_mic;

async function detectMode() {
  try {
    const r = await fetch("/api/ping", { cache: "no-store" });
    const caps = r.ok ? await r.json() : null;
    if (caps?.ok) return new ServerDevice(caps);
  } catch {}
  return new SerialDevice();
}

async function init() {
  dev = await detectMode();
  document.body.dataset.mode = dev.kind;
  document.body.classList.toggle("browser-mic", !serverMic());
  if (dev.kind === "server" && !dev.caps.bt_control) $("connbtn").style.display = "none";

  bindGroup("anc", "anc", "Modalità");
  bindGroup("eq", "eq", "Equalizzatore");
  bindToggle("game", "Game mode");
  bindToggle("multipoint", "Multipoint");
  bindMic();

  let finding = false;
  $("find").addEventListener("click", async () => {
    try {
      await dev.find(!finding);
      finding = !finding;
      $("find").textContent = finding ? "Ferma" : "Suona";
    } catch (err) { toast(err.message, true); }
  });

  $("connbtn").addEventListener("click", async () => {
    const btn = $("connbtn");
    const wasConnected = !!btn.dataset.connected;
    btn.disabled = true;
    try {
      if (wasConnected) await dev.disconnect();
      else await dev.connect();
      if (wasConnected) setConnected(false, "Scollegate");
      else if (dev.kind === "server") await new Promise((r) => setTimeout(r, 2500)); // tempo per il profilo seriale
      await refresh();
    } catch (err) {
      if (err.name !== "NotFoundError") toast(err.message, true); // NotFoundError = selezione annullata
    }
    btn.disabled = false;
  });

  if (dev.kind === "serial") {
    if (!SerialDevice.supported()) {
      $("unsupported").style.display = "block";
      $("connbtn").disabled = true;
    } else {
      navigator.serial.addEventListener("disconnect", (e) => {
        if (e.target === dev.port) { dev.port = null; onDisconnected(); }
      });
      await dev.reconnect();
    }
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  } else {
    setInterval(() => fetch("/api/ping").catch(() => {}), 20000);
  }

  if (!serverMic() && navigator.mediaDevices?.enumerateDevices) fillMicSelect().catch(() => {});

  await refresh();
  setInterval(refresh, 30000);
}

init();
