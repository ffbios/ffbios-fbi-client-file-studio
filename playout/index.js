// FBI TV 24/7 playout.
//
// Every few seconds it asks the live server what should be on air
// (/api/internal/playout/plan). When something should play and the studio
// (OBS) is not live, it plays that file from storage into the ingest as the
// channel's normal feed (encoded/<key>), so the watch page, IPTV apps, the
// adaptive-quality copies and the viewer report all work unchanged.
//
// One long-running "publisher" FFmpeg keeps the RTMP connection open; each
// programme is played by a short-lived "feeder" FFmpeg that encodes it with
// identical settings and continuous timestamps, so items change without the
// stream dropping. When OBS goes live the ingest replaces this feed; the
// publisher is then cut off and the playout waits until the studio is done.

const { spawn } = require("child_process");
const http = require("http");

const WEB = (process.env.WEB_BASE || "https://live.fbigh.com").replace(/\/+$/, "");
const TOKEN = process.env.PLAYOUT_TOKEN || "";
const RTMP = (process.env.INGEST_RTMP || "rtmp://fbi-live-ingest:1935").replace(/\/+$/, "");
const POLL_MS = 4000;
const KICK_BACKOFF_MS = 25000;   // after the studio takes over, don't fight it
// Channel logo ("bug") in the top-right corner of everything the playout airs.
// Set PLAYOUT_LOGO=off to hide it; LOGO_WIDTH (pixels on the 1920x1080 picture)
// and LOGO_OPACITY (0-1) adjust it.
const LOGO_FILE = require("path").join(__dirname, "logo.png");
const LOGO_ON = String(process.env.PLAYOUT_LOGO || "on").toLowerCase() !== "off" && require("fs").existsSync(LOGO_FILE);
const LOGO_WIDTH = Math.max(60, Math.min(600, Number(process.env.LOGO_WIDTH) || 200));
const LOGO_OPACITY = Math.max(0.1, Math.min(1, Number(process.env.LOGO_OPACITY) || 0.9));
const BASE_VF = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30";
// 48 px from the right and 40 px from the top: inside the safe area on TVs.
const VIDEO_FILTER = LOGO_ON
  ? "[in]" + BASE_VF + "[base];movie=" + LOGO_FILE + ":loop=0,setpts=N/30/TB,scale=" + LOGO_WIDTH + ":-1,format=rgba,colorchannelmixer=aa=" + LOGO_OPACITY +
    "[logo];[base][logo]overlay=W-w-48:40:format=auto:shortest=1,format=yuv420p[out]"
  : BASE_VF + ",format=yuv420p";

if (TOKEN.length < 24) { console.error("PLAYOUT_TOKEN is missing or too short; playout disabled."); }

let publisher = null, pubStart = 0, pubKey = "";
let feeder = null, current = null;      // current = {id, endsAt}
let lastKickAt = 0, stopping = false, polling = false;
let nextTs = 0;                         // output timestamps keep rising across items
let lastDone = null;                    // {id, at} of the item that just finished

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function api(path, body) {
  const r = await fetch(WEB + path, {
    method: body ? "POST" : "GET",
    headers: { "X-Playout-Token": TOKEN, "Content-Type": "application/json", "User-Agent": "fbi-tv-playout/1" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(path + " -> HTTP " + r.status);
  return r.json();
}

function startPublisher(key) {
  pubKey = key;
  pubStart = Date.now();
  nextTs = 0;
  const args = ["-hide_banner", "-loglevel", "warning", "-fflags", "+genpts", "-f", "mpegts", "-i", "pipe:0",
    "-c", "copy", "-f", "flv", RTMP + "/encoded/" + key];
  const p = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  p.stdin.on("error", () => {});
  p.stderr.on("data", (d) => process.stdout.write("[publisher] " + d));
  p.on("close", (code) => {
    if (publisher !== p) return;
    publisher = null;
    stopFeeder();
    if (!stopping) { lastKickAt = Date.now(); log("publisher ended (code " + code + ") — the studio may have taken over"); }
    stopping = false;
  });
  publisher = p;
  log("publisher connected to encoded/" + key);
}

function stopFeeder() {
  if (feeder) { try { feeder.kill("SIGKILL"); } catch {} }
  feeder = null;
  current = null;
}
function stopAll(reason) {
  if (!publisher && !feeder) return;
  log("stopping playout: " + reason);
  stopFeeder();
  if (publisher) { stopping = true; try { publisher.stdin.end(); publisher.kill("SIGTERM"); } catch {} }
}

function hasAudio(url) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", url], { stdio: ["ignore", "pipe", "ignore"] });
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 20000);
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => { clearTimeout(t); resolve(out.trim().length > 0); });
    p.on("error", () => { clearTimeout(t); resolve(true); });
  });
}

async function startFeeder(item) {
  const secs = Math.max(1, (new Date(item.endsAt).getTime() - Date.now()) / 1000);
  const audio = await hasAudio(item.url);
  const elapsed = (Date.now() - pubStart) / 1000;
  const tsStart = Math.max(elapsed, nextTs) + 0.1;
  const tsOffset = tsStart.toFixed(3);
  const startedAt = Date.now();
  const args = ["-hide_banner", "-loglevel", "warning", "-re", "-ss", String(item.offset || 0), "-i", item.url];
  if (!audio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push("-t", secs.toFixed(1), "-map", "0:v:0", "-map", audio ? "0:a:0" : "1:a:0",
    "-vf", VIDEO_FILTER,
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "main", "-level", "4.1",
    "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-b:v", "6M", "-maxrate", "6500k", "-bufsize", "12M",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-output_ts_offset", tsOffset, "-f", "mpegts", "pipe:1");
  const f = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  f.stderr.on("data", (d) => process.stdout.write("[feeder] " + d));
  // pass only whole 188-byte MPEG-TS packets, and only from the current
  // feeder, so a stopped item can never leave half a packet in the stream
  let rest = Buffer.alloc(0);
  f.stdout.on("data", (chunk) => {
    if (feeder !== f) return;
    const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const whole = buf.length - (buf.length % 188);
    rest = buf.subarray(whole);
    if (whole && publisher && publisher.stdin.writable) publisher.stdin.write(buf.subarray(0, whole));
  });
  f.on("close", (code) => {
    nextTs = Math.max(nextTs, tsStart + (Date.now() - startedAt) / 1000);
    if (feeder !== f) return;
    log("finished: " + item.title + (code ? " (exit " + code + ")" : ""));
    feeder = null; current = null;
    lastDone = { id: item.id, at: Date.now() };
    setTimeout(tick, 200);          // go straight to the next item
  });
  feeder = f;
  current = { id: item.id, endsAt: new Date(item.endsAt).getTime(), title: item.title };
  log("playing: " + item.title + (item.episode ? " ep " + item.episode : "") + " from " + item.offset + "s for " + secs.toFixed(0) + "s");
}

async function tick() {
  if (polling || TOKEN.length < 24) return;
  polling = true;
  try {
    const plan = await api("/api/internal/playout/plan");
    if (plan.studioLive) { stopAll("studio is live"); await api("/api/internal/playout/heartbeat", { onAir: false }).catch(() => {}); return; }
    if (!plan.item) { stopAll(plan.reason || "nothing to play"); await api("/api/internal/playout/heartbeat", { onAir: false }).catch(() => {}); return; }
    if (Date.now() - lastKickAt < KICK_BACKOFF_MS) return;
    if (publisher && pubKey !== plan.streamKey) stopAll("channel key changed");
    if (!publisher) startPublisher(plan.streamKey);
    const remaining = new Date(plan.item.endsAt).getTime() - Date.now();
    if (current && current.id === plan.item.id && Date.now() < current.endsAt + 2000) {
      // still playing the right thing
    } else if (!current && lastDone && lastDone.id === plan.item.id && remaining < 4000) {
      // this item just finished; its last seconds are rounding — wait for the next one
    } else {
      stopFeeder();
      await startFeeder(plan.item);
    }
    await api("/api/internal/playout/heartbeat", { onAir: true, title: plan.item.title }).catch(() => {});
  } catch (e) {
    log("plan error: " + (e.message || e));
  } finally {
    polling = false;
  }
}

// Railway health check
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, onAir: !!publisher, playing: current ? current.title : null }));
}).listen(Number(process.env.PORT || 8080), () => log("FBI TV playout running; web=" + WEB + " ingest=" + RTMP + " logo=" + (LOGO_ON ? "top-right" : "off")));

setInterval(tick, POLL_MS);
tick();
process.on("SIGTERM", () => { stopAll("shutting down"); api("/api/internal/playout/heartbeat", { onAir: false }).catch(() => {}).finally(() => setTimeout(() => process.exit(0), 500)); });
