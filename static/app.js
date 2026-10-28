// Haylou S30 panel — two modes:
//  - "server": page served by server.py / HaylouS30.exe, headphone commands via /api
//  - "web": static page (GitHub Pages): download links and in-browser mic test only.
//    The browser can't control the headphones: Chrome's Web Serial blocks their
//    Bluetooth service (UUID 0000fd3d-… on the SIG base).

const $ = (id) => document.getElementById(id);

// ---------- server transport ----------

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

// ---------- in-browser microphone test ----------

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
        await fillMicSelect(); // microphone names become visible after permission is granted
      }
    } catch (err) {
      toast(err.name === "NotAllowedError" ? "Permesso microfono negato" : err.message, true);
    }
    btn.disabled = false;
    btn.textContent = "Avvia test";
  });
}

// on Linux the server switches the Bluetooth profile and records; elsewhere the browser records
const serverMic = () => dev?.caps.server_mic;

async function detectMode() {
  try {
    const r = await fetch("/api/ping", { cache: "no-store" });
    const caps = r.ok ? await r.json() : null;
    if (caps?.ok) return new ServerDevice(caps);
  } catch {}
  return null;
}

async function init() {
  dev = await detectMode();
  document.body.dataset.mode = dev ? "server" : "web";
  document.body.classList.toggle("browser-mic", !serverMic());
  bindMic();
  if (!serverMic() && navigator.mediaDevices?.enumerateDevices) fillMicSelect().catch(() => {});
  if (!dev) return;

  if (!dev.caps.bt_control) $("connbtn").style.display = "none";
  bindGroup("anc", "anc", "Modalità");
  bindGroup("eq", "eq", "Equalizzatore");
  bindToggle("game", "Game mode");
  bindToggle("multipoint", "Multipoint");

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
      else await new Promise((r) => setTimeout(r, 2500)); // give the serial profile time to come up
      await refresh();
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
  });

  setInterval(() => fetch("/api/ping").catch(() => {}), 20000);
  await refresh();
  setInterval(refresh, 30000);
}

init();
