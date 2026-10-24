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
//
// Smooth playback:
// - Files are downloaded to a local cache before they air, so a slow read from
//   storage can't starve the encoder mid-programme. (Until a file is cached it
//   is streamed from storage as before.)
// - A few seconds before an item ends, the playout asks what comes next
//   (?at=<end time>) and prepares it. Its feeder is started a fixed moment
//   before its first frame is due on the channel clock (any output that
//   arrives while the current item is still running is held back), and its
//   timestamps continue exactly where the current one stops, so there is no
//   gap or jump at the change and no drift over time.
// - Each feeder marks its first packets as a discontinuity, so the publisher
//   doesn't report the join between two feeders as corrupt.

const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const WEB = (process.env.WEB_BASE || "https://live.fbigh.com").replace(/\/+$/, "");
const TOKEN = process.env.PLAYOUT_TOKEN || "";
const RTMP = (process.env.INGEST_RTMP || "rtmp://fbi-live-ingest:1935").replace(/\/+$/, "");
const POLL_MS = 4000;
const KICK_BACKOFF_MS = 25000;   // after the studio takes over, don't fight it
const LOOKAHEAD_MS = 8000;       // ask for the next item this long before it is due
const PREROLL_MS = 1500;         // start the next feeder this long before its first frame is due
const HOLD_MAX = 16 * 1024 * 1024; // a prepared feeder pauses after this much output
// Channel logo ("bug") in the top-right corner of everything the playout airs.
// Set PLAYOUT_LOGO=off to hide it; LOGO_WIDTH (pixels on the 1920x1080 picture)
// and LOGO_OPACITY (0-1) adjust it.
const LOGO_FILE = path.join(__dirname, "logo.png");
const LOGO_ON = String(process.env.PLAYOUT_LOGO || "on").toLowerCase() !== "off" && fs.existsSync(LOGO_FILE);
const LOGO_WIDTH = Math.max(60, Math.min(600, Number(process.env.LOGO_WIDTH) || 200));
const LOGO_OPACITY = Math.max(0.1, Math.min(1, Number(process.env.LOGO_OPACITY) || 0.9));
const BASE_VF = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30";
// 48 px from the right and 40 px from the top: inside the safe area on TVs.
const VIDEO_FILTER = LOGO_ON
  ? "[in]" + BASE_VF + "[base];movie=" + LOGO_FILE + ":loop=0,setpts=N/30/TB,scale=" + LOGO_WIDTH + ":-1,format=rgba,colorchannelmixer=aa=" + LOGO_OPACITY +
    "[logo];[base][logo]overlay=W-w-48:40:format=auto:shortest=1,format=yuv420p[out]"
  : BASE_VF + ",format=yuv420p";

// Local media cache. PLAYOUT_CACHE_GB caps its size (default 4); PLAYOUT_CACHE=off disables it.
const CACHE_ON = String(process.env.PLAYOUT_CACHE || "on").toLowerCase() !== "off";
const CACHE_DIR = process.env.PLAYOUT_CACHE_DIR || "/tmp/fbi-tv-cache";
const CACHE_MAX = Math.max(0.5, Number(process.env.PLAYOUT_CACHE_GB) || 4) * 1024 ** 3;
const DISK_RESERVE = 1.5 * 1024 ** 3;   // always leave this much disk free
const CACHE_WAIT_MS = 3000;             // how long a start may wait for a download

if (TOKEN.length < 24) { console.error("PLAYOUT_TOKEN is missing or too short; playout disabled."); }

let publisher = null, pubStart = 0, pubKey = "";
let feeder = null, current = null;      // current = {id, endsAt, title, tsStart, secs}
let prepared = null;                    // next item, prepared ahead: {item, src, audio, proc, held, tsStart, secs}
let lookaheadTimer = null, prerollTimer = null;
let lastKickAt = 0, stopping = false, polling = false;
let nextTs = 0;                         // output timestamps keep rising across items
let lastDone = null;                    // {id, at} of the item that just finished

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function api(p, body) {
  const r = await fetch(WEB + p, {
    method: body ? "POST" : "GET",
    headers: { "X-Playout-Token": TOKEN, "Content-Type": "application/json", "User-Agent": "fbi-tv-playout/2" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(p + " -> HTTP " + r.status);
  return r.json();
}

// ---------- local media cache ----------

const downloads = new Map();            // key -> Promise<path|null>
const audioKnown = new Map();           // key -> boolean

function cacheKey(item) {
  let u = String(item.url || "");
  try { const x = new URL(u); u = x.origin + x.pathname; } catch {}
  return crypto.createHash("sha1").update(String(item.id) + "|" + u).digest("hex").slice(0, 24);
}
function cachePath(key) { return path.join(CACHE_DIR, key + ".media"); }

function cachedFile(key) {
  const p = cachePath(key);
  try { const st = fs.statSync(p); if (st.size > 0) { const t = new Date(); fs.utimesSync(p, t, t); return p; } } catch {}
  return null;
}

function cacheUsage() {
  let files = [];
  try {
    files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith(".media")).map((f) => {
      const p = path.join(CACHE_DIR, f); const st = fs.statSync(p);
      return { p, size: st.size, used: st.mtimeMs };
    });
  } catch {}
  return files;
}
function diskFree() {
  try { const s = fs.statfsSync(CACHE_DIR); return s.bavail * s.bsize; } catch { return 0; }
}
// Make room for `need` bytes, removing the least recently aired files first
// (never the ones in `keep`). Returns false if there still isn't room.
function makeRoom(need, keep) {
  const files = cacheUsage().sort((a, b) => a.used - b.used);
  let total = files.reduce((s, f) => s + f.size, 0);
  for (const f of files) {
    if (total + need <= CACHE_MAX && diskFree() - need > DISK_RESERVE) break;
    if (keep.has(f.p)) continue;
    try { fs.unlinkSync(f.p); total -= f.size; } catch {}
  }
  return total + need <= CACHE_MAX && diskFree() - need > DISK_RESERVE;
}

function download(item) {
  const key = cacheKey(item);
  if (downloads.has(key)) return downloads.get(key);
  const job = (async () => {
    const dest = cachePath(key), part = dest + "." + process.pid + ".part";
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const r = await fetch(item.url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
      if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
      const size = Number(r.headers.get("content-length") || 0);
      const keep = new Set([current && current.src, prepared && prepared.src].filter(Boolean));
      if (!size || !makeRoom(size, keep)) { try { await r.body.cancel(); } catch {} log("cache: no room for " + item.title + " — streaming it from storage"); return null; }
      const t0 = Date.now();
      // Storage drops long transfers part-way, so resume with Range requests
      // instead of starting over (or giving up and airing from storage).
      let body = r.body, tries = 0;
      for (;;) {
        try {
          await pipeline(Readable.fromWeb(body), fs.createWriteStream(part, { flags: tries ? "a" : "w" }));
        } catch (e) { log("cache: transfer of " + item.title + " interrupted: " + (e.message || e)); }
        const have = fs.statSync(part).size;
        if (have >= size) break;
        if (++tries > 20) throw new Error("gave up after " + tries + " resumes at " + have + "/" + size + " bytes");
        await new Promise((res) => setTimeout(res, Math.min(10000, 1000 * tries)));
        const rr = await fetch(item.url, { headers: { Range: "bytes=" + have + "-" }, signal: AbortSignal.timeout(30 * 60 * 1000) });
        if (rr.status !== 206 || !rr.body) { try { rr.body && await rr.body.cancel(); } catch {} throw new Error("storage refused resume (HTTP " + rr.status + ")"); }
        body = rr.body;
      }
      fs.renameSync(part, dest);
      log("cache: stored " + item.title + " (" + (size / 1048576).toFixed(0) + " MB in " + ((Date.now() - t0) / 1000).toFixed(1) + "s)");
      return dest;
    } catch (e) {
      try { fs.unlinkSync(part); } catch {}
      log("cache: download failed for " + item.title + ": " + (e.message || e));
      return null;
    } finally {
      downloads.delete(key);
    }
  })();
  downloads.set(key, job);
  return job;
}

// Where to read an item from: the local copy when there is one (waiting up to
// `waitMs` for a download in progress), otherwise straight from storage.
async function sourceFor(item, waitMs) {
  if (!CACHE_ON) return item.url;
  const key = cacheKey(item);
  const have = cachedFile(key);
  if (have) return have;
  const job = download(item);
  const got = await Promise.race([job, new Promise((r) => setTimeout(() => r(null), waitMs))]);
  return got || item.url;
}

function probeAudio(src) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", src], { stdio: ["ignore", "pipe", "ignore"] });
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 20000);
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => { clearTimeout(t); resolve(out.trim().length > 0); });
    p.on("error", () => { clearTimeout(t); resolve(true); });
  });
}
async function hasAudio(item, src) {
  const key = cacheKey(item);
  if (audioKnown.has(key)) return audioKnown.get(key);
  const a = await probeAudio(src);
  audioKnown.set(key, a);
  return a;
}

// ---------- publisher / feeders ----------

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

function clearTimers() {
  clearTimeout(lookaheadTimer); clearTimeout(prerollTimer);
  lookaheadTimer = prerollTimer = null;
}
function dropPrepared() {
  if (prepared && prepared.proc) { try { prepared.proc.kill("SIGKILL"); } catch {} }
  prepared = null;
}
function stopFeeder() {
  clearTimers();
  dropPrepared();
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

// Returns false when the publisher wants the writer to wait for "drain".
function writeToPublisher(buf) {
  if (buf.length && publisher && publisher.stdin.writable) return publisher.stdin.write(buf);
  return true;
}
// Back-pressure: pause the on-air feeder until the publisher has caught up.
function waitForDrain(slot) {
  if (slot.waiting || !publisher) return;
  slot.waiting = true;
  slot.proc.stdout.pause();
  publisher.stdin.once("drain", () => { slot.waiting = false; if (feeder === slot.proc) slot.proc.stdout.resume(); });
}

// Spawn the FFmpeg for one item. Its output is held in `slot.held` until the
// slot becomes the on-air feeder (see goLive), so it can start early.
function spawnFeeder(slot) {
  const { item, src, audio, secs, tsStart } = slot;
  const args = ["-hide_banner", "-loglevel", "warning"];
  // Not cached yet and reading straight from storage: reconnect where the
  // transfer dropped instead of ending the programme early.
  if (/^https?:\/\//i.test(src)) args.push("-reconnect", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "5");
  args.push("-re", "-ss", String(item.offset || 0), "-i", src);
  if (!audio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push("-t", secs.toFixed(3), "-map", "0:v:0", "-map", audio ? "0:a:0" : "1:a:0",
    "-vf", VIDEO_FILTER,
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "main", "-level", "4.1",
    "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-b:v", "6M", "-maxrate", "6500k", "-bufsize", "12M",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-output_ts_offset", tsStart.toFixed(3), "-mpegts_flags", "+initial_discontinuity", "-f", "mpegts", "pipe:1");
  const f = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  f.stderr.on("data", (d) => process.stdout.write("[feeder] " + d));
  slot.proc = f;
  slot.spawnedAt = Date.now();
  slot.held = [];
  slot.heldBytes = 0;
  slot.rest = Buffer.alloc(0);
  // pass only whole 188-byte MPEG-TS packets, so a stopped item can never
  // leave half a packet in the stream
  f.stdout.on("data", (chunk) => {
    const buf = slot.rest.length ? Buffer.concat([slot.rest, chunk]) : chunk;
    const whole = buf.length - (buf.length % 188);
    slot.rest = buf.subarray(whole);
    if (!whole) return;
    const packets = buf.subarray(0, whole);
    if (feeder === f) { if (!writeToPublisher(packets)) waitForDrain(slot); }
    else if (slot.held) {
      slot.held.push(packets); slot.heldBytes += packets.length;
      if (slot.heldBytes > HOLD_MAX) f.stdout.pause();
    }
  });
  f.on("close", (code) => onFeederClosed(slot, code));
  return f;
}

// Wall-clock time at which a stream timestamp is due (stream time 0 = publisher start).
function wallOf(ts) { return pubStart + ts * 1000; }

function goLive(slot) {
  feeder = slot.proc;
  current = { id: slot.item.id, endsAt: wallOf(slot.tsStart + slot.secs), schedEnd: new Date(slot.item.endsAt).getTime(),
    title: slot.item.title, src: slot.src, tsStart: slot.tsStart, secs: slot.secs };
  let ok = true;
  if (slot.held) { for (const b of slot.held) ok = writeToPublisher(b) && ok; }
  slot.held = null;
  if (!ok) waitForDrain(slot); else slot.proc.stdout.resume();
  nextTs = slot.tsStart + slot.secs;
  log("playing: " + slot.item.title + (slot.item.episode ? " ep " + slot.item.episode : "") + " from " + (slot.item.offset || 0) + "s for " + slot.secs.toFixed(1) + "s" + (slot.src === slot.item.url ? " (from storage)" : ""));
  scheduleLookahead();
}

function onFeederClosed(slot, code) {
  const f = slot.proc;
  if (prepared === slot) { prepared = null; return; }       // a prepared item that was dropped
  if (feeder !== f) return;
  log("finished: " + slot.item.title + (code ? " (exit " + code + ")" : ""));
  feeder = null; current = null;
  lastDone = { id: slot.item.id, at: Date.now() };
  clearTimeout(lookaheadTimer); lookaheadTimer = null;
  if (prepared && publisher && prepared.proc) {
    const next = prepared; prepared = null;
    clearTimeout(prerollTimer); prerollTimer = null;
    goLive(next);
  } else if (prepared && publisher && prerollTimer) {
    // the next item is ready and starts on time (see prepareNext) — the
    // current one only finished early because FFmpeg sends its opening
    // half-second at once
  } else {
    dropPrepared();
    setTimeout(tick, 100);          // nothing prepared: ask what's next now
  }
}

// When the current item is near its end, find out what follows and get it ready.
function scheduleLookahead() {
  clearTimers();
  if (!current) return;
  const endsAt = current.endsAt;
  const lookIn = Math.max(0, endsAt - Date.now() - LOOKAHEAD_MS);
  lookaheadTimer = setTimeout(() => prepareNext(endsAt).catch((e) => log("look-ahead failed: " + (e.message || e))), lookIn);
}

async function prepareNext(endsAt) {
  if (!current || current.endsAt !== endsAt || prepared) return;
  // ask what the schedule has on just after this item's scheduled end
  const atMs = current.schedEnd + 100;
  const plan = await api("/api/internal/playout/plan?at=" + encodeURIComponent(new Date(atMs).toISOString()));
  if (!current || current.endsAt !== endsAt || !plan.item || plan.studioLive || plan.streamKey !== pubKey) return;
  const item = plan.item;
  // play it from this item's scheduled end to its own, so the channel clock
  // stays in step with the schedule however long it runs
  const secs = Math.max(1, (new Date(item.endsAt).getTime() - current.schedEnd) / 1000);
  const cur = current;
  const tsStart = cur.tsStart + cur.secs;
  const src = await sourceFor(item, Math.max(0, wallOf(tsStart) - Date.now() - PREROLL_MS - 500));
  const audio = await hasAudio(item, src);
  if (current !== cur) return;
  prepared = { item, src, audio, secs, tsStart, proc: null };
  const slot = prepared;
  // start it a little before it is due; its output is held until the current item ends
  const prerollIn = Math.max(0, wallOf(tsStart) - Date.now() - PREROLL_MS);
  prerollTimer = setTimeout(() => {
    prerollTimer = null;
    if (prepared !== slot || slot.proc || !publisher) return;
    spawnFeeder(slot);
    if (!feeder) { prepared = null; goLive(slot); }   // current already done: go straight on air
  }, prerollIn);
}

async function startNow(item) {
  const interrupted = !!current;  // cutting an item short: its tail may still be queued
  stopFeeder();
  const secs = Math.max(1, (new Date(item.endsAt).getTime() - Date.now()) / 1000);
  const src = await sourceFor(item, CACHE_WAIT_MS);
  const audio = await hasAudio(item, src);
  if (!publisher) return;
  const elapsed = (Date.now() - pubStart) / 1000;
  const remaining = Math.max(1, (new Date(item.endsAt).getTime() - Date.now()) / 1000);
  const slot = { item, src, audio, secs: Math.min(secs, remaining), tsStart: interrupted ? Math.max(elapsed + 1.5, 0.1) : Math.max(elapsed, nextTs) + 0.1, proc: null };
  spawnFeeder(slot);
  goLive(slot);
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
    const now = Date.now();
    const remaining = new Date(plan.item.endsAt).getTime() - now;
    if (current && current.id === plan.item.id && now < current.endsAt + 3000) {
      // still playing the right thing
    } else if (prepared && (prepared.item.id === plan.item.id || (current && current.id === plan.item.id) || (lastDone && lastDone.id === plan.item.id)) &&
               (current ? now < current.endsAt + 3000 : !!prerollTimer)) {
      // the next item is prepared and about to follow on
    } else if (lastDone && lastDone.id === plan.item.id && remaining < 4000 && now - lastDone.at < 6000) {
      // this item just finished a moment ahead of the schedule — the next one is (or will be) on
    } else {
      await startNow(plan.item);
    }
    // keep the local cache warm for what's on air
    if (CACHE_ON && !cachedFile(cacheKey(plan.item))) download(plan.item);
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
  res.end(JSON.stringify({ ok: true, onAir: !!publisher, playing: current ? current.title : null, next: prepared ? prepared.item.title : null }));
}).listen(Number(process.env.PORT || 8080), () => log("FBI TV playout running; web=" + WEB + " ingest=" + RTMP + " logo=" + (LOGO_ON ? "top-right" : "off") + " cache=" + (CACHE_ON ? CACHE_DIR + " (" + (CACHE_MAX / 1024 ** 3).toFixed(1) + " GB max)" : "off")));

setInterval(tick, POLL_MS);
tick();
process.on("SIGTERM", () => { stopAll("shutting down"); api("/api/internal/playout/heartbeat", { onAir: false }).catch(() => {}).finally(() => setTimeout(() => process.exit(0), 500)); });
