// Viewer-side additions for live.fbigh.com (the root server's /watch/:token page).
//
// Everything here is presentation or the new "Save for later" feature. The
// streaming engine (HLS proxy, status, heartbeat, replay endpoints, comments)
// is not modified by this module.

const crypto = require("crypto");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEWER_COOKIE = "fbi_live_viewer";
const MAX_SAVED = 200;

/* ------------------------------------------------------------------ */
/* Pieces spliced into the existing watch page template                */
/* (no backticks and no dollar-brace sequences: it lives in a template */
/*  literal in server.js)                                              */
/* ------------------------------------------------------------------ */

// Larger, more readable type on desktop/tablet, plus the new top bar and the
// Save / Share buttons. Phone layouts keep their existing rules untouched.
const WATCH_CSS = `
body{background:radial-gradient(circle at 50% -12%,rgba(70,82,120,.30),transparent 42%),#09090a}
.lv-topbar{position:sticky;top:0;z-index:30;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 18px;background:rgba(9,9,10,.86);backdrop-filter:blur(14px);border-bottom:1px solid #26262b}
.lv-brand{display:flex;align-items:center;gap:10px;color:#e8c448;font-weight:900;letter-spacing:.16em;font-size:12px;text-decoration:none}
.lv-brand i{display:grid;place-items:center;width:34px;height:28px;border:1px solid #5b4d1e;background:#17150b;font-style:normal;font-size:11px}
.lv-chip{display:inline-flex;align-items:center;gap:7px;padding:8px 14px;border-radius:999px;border:1px solid #2c2c33;background:#111114;color:#f6f6f7;font:inherit;font-size:13px;font-weight:700;text-decoration:none;cursor:pointer;transition:.15s}
.lv-chip:hover{border-color:#3d3d46;background:#18181c}
.lv-chip.on{border-color:rgba(232,196,72,.6);color:#e8c448;background:#1c180a}
.lv-chip:disabled{opacity:.6;cursor:default}
.head-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.lv-toast{position:fixed;left:50%;bottom:90px;transform:translate(-50%,16px);opacity:0;background:#1b1b20;border:1px solid #34343a;padding:11px 16px;border-radius:12px;font-size:13px;z-index:99998;transition:.2s;pointer-events:none;max-width:90vw}
.lv-toast.show{opacity:1;transform:translate(-50%,0)}
@media(min-width:601px){
 .head h1{font-size:clamp(26px,3.6vw,36px);letter-spacing:-.01em;margin:10px 0 6px}
 .brand{font-size:11px;letter-spacing:.16em;color:#e8c448}
 .head p{font-size:14px}
 .badge{font-size:12px;padding:6px 12px;font-weight:800;letter-spacing:.05em}
 .nowq{font-size:12px}
 .playerbar{padding:12px 16px}
 .comments-head{padding:16px}.comments-head h2{font-size:16px}
 .comment b{font-size:13px}.comment span{font-size:14px;line-height:1.5}.comment time{font-size:11px}
 .comment-form input,.comment-form textarea{font-size:14px;padding:11px}
 .comment-form button{font-size:14px}
 .statusline{font-size:12px}
 .foot{font-size:12px}
 .card{border-radius:20px}
}
@media(max-width:900px) and (orientation:landscape) and (pointer:coarse){.lv-topbar{display:none}}
@media(max-width:600px){.lv-topbar{padding:9px 12px}.lv-chip{padding:7px 12px;font-size:12px}.head-actions{gap:6px;margin-top:10px}.head-actions .lv-chip{flex:1;justify-content:center;min-width:0}.mobile-floating-comments{bottom:calc(142px + env(safe-area-inset-bottom));max-height:42%;right:72px}.mobile-reaction-floaters{bottom:118px}.mobile-reaction-rail{bottom:118px}}\n@media(max-width:900px) and (orientation:landscape) and (pointer:coarse){.lv-topbar{display:none}.wrap{padding:8px 12px}.head{padding:6px 4px 10px}.head h1{font-size:20px}.head-actions{margin-top:7px}.layout{gap:10px}}\n@media(max-width:380px){.mobile-floating-comments{bottom:calc(138px + env(safe-area-inset-bottom));right:66px;max-height:40%}.mobile-reaction-floaters{bottom:112px}.mobile-reaction-rail{bottom:112px}}
`;

const WATCH_TOPBAR =
  '<div class="lv-topbar"><a class="lv-brand" href="/library"><i>FBI</i>FBI LIVE</a>' +
  '<a class="lv-chip" href="/library">&#9733; My Saved</a></div>';

const WATCH_ACTIONS =
  '<div class="head-actions"><button type="button" class="lv-chip" id="lvSave" aria-pressed="false">&#9734; Save for later</button>' +
  '<button type="button" class="lv-chip" id="lvShare">Share</button></div>';

// Plays one specific saved recording when the page is opened as
// /watch/<token>?recording=<id>. Uses the existing replay/file endpoint. When
// the parameter is absent, pinnedPlay() returns false and nothing changes.
const PINNED_JS = `const pinnedRecording=(new URLSearchParams(location.search).get("recording")||"").trim();let pinnedStarted=false;
function pinnedPlay(){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pinnedRecording))return false;
  if(pinnedStarted)return true;
  pinnedStarted=true;replayMode=true;clearPlayer();offline.style.display="none";video.style.display="block";video.muted=false;
  video.src="/api/public/stream/"+encodeURIComponent(token)+"/replay/file?recordingId="+encodeURIComponent(pinnedRecording);
  video.load();statusEl.textContent="SAVED REPLAY";statusEl.className="badge live";viewers.textContent="Replay of a saved broadcast";streamState.textContent="Replay playback";
  video.play().catch(function(){});return true;
}
`;

// Second script block: the Save / Share buttons.
const SAVE_JS = `(function(){
var btn=document.getElementById("lvSave"),share=document.getElementById("lvShare"),vid=document.getElementById("video");
if(!btn||!vid)return;
var base="/api/public/stream/"+encodeURIComponent(token),saved=false,busy=false;
function toast(m){var t=document.getElementById("lvToast");if(!t){t=document.createElement("div");t.id="lvToast";t.className="lv-toast";t.setAttribute("role","status");document.body.appendChild(t)}t.textContent=m;t.classList.add("show");clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove("show")},2400)}
function currentRecording(){
  if(pinnedRecording)return pinnedRecording;
  var s=vid.getAttribute("src")||"",m=s.match(/recordingId=([0-9a-fA-F-]{36})/);return m?m[1]:"";
}
function q(){var r=currentRecording();return r?"?recordingId="+encodeURIComponent(r):""}
function paint(){btn.innerHTML=saved?"&#9733; Saved":"&#9734; Save for later";btn.classList.toggle("on",saved);btn.setAttribute("aria-pressed",saved?"true":"false")}
function check(){fetch(base+"/saved"+q(),{credentials:"same-origin",cache:"no-store"}).then(function(r){return r.json()}).then(function(d){saved=!!d.saved;paint()}).catch(function(){})}
btn.onclick=function(){
  if(busy)return;busy=true;btn.disabled=true;
  var r=currentRecording();
  fetch(base+"/save"+(saved?q():""),{method:saved?"DELETE":"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:saved?undefined:JSON.stringify({recordingId:r})})
  .then(function(res){return res.json().then(function(d){return {ok:res.ok,d:d}})})
  .then(function(x){if(!x.ok)throw new Error(x.d&&x.d.error||"");saved=!saved;paint();toast(saved?"Saved. Find it under My Saved.":"Removed from My Saved.")})
  .catch(function(e){toast(e.message||"Could not update your saved list. Try again.")})
  .then(function(){busy=false;btn.disabled=false});
};
share.onclick=function(){var url=location.href;try{if(navigator.share){navigator.share({title:document.title,url:url}).catch(function(){});return}navigator.clipboard.writeText(url).then(function(){toast("Link copied")})}catch(e){}};
vid.addEventListener("loadedmetadata",check);
check();setTimeout(check,4000);
})();`;

/* ------------------------------------------------------------------ */
/* /library page                                                       */
/* ------------------------------------------------------------------ */

const LIB_CSS = `
:root{--bg:#09090a;--panel:#101012;--line:#26262b;--text:#f6f6f7;--muted:#9b9ba4;--gold:#e8c448;--green:#4ade80;--radius:18px}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:radial-gradient(circle at 50% -12%,rgba(70,82,120,.30),transparent 42%),var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}button{font:inherit;cursor:pointer}
.top{position:sticky;top:0;z-index:20;padding:11px 18px;background:rgba(9,9,10,.86);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--gold);font-weight:900;letter-spacing:.16em;font-size:12px}
.brand i{display:grid;place-items:center;width:34px;height:28px;border:1px solid #5b4d1e;background:#17150b;font-style:normal;font-size:11px}
.wrap{max-width:1240px;margin:0 auto;padding:26px 18px 50px}
h1{font-size:clamp(26px,4vw,40px);margin:6px 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:14px;margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.card{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;transition:.15s}
.card:hover{border-color:#3a3a42;transform:translateY(-2px)}
.thumb{position:relative;display:grid;place-items:center;aspect-ratio:16/9;background:radial-gradient(circle at 50% 30%,#1d2028,#07080a);color:#4a5160;font-size:34px}
.pill{position:absolute;left:12px;top:12px;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.05em;border:1px solid var(--line);background:#0c0c0e;color:var(--muted)}
.pill.live{color:var(--green);border-color:rgba(74,222,128,.4)}
.pill.ready{color:var(--gold);border-color:rgba(232,196,72,.4)}
.info{padding:14px 16px 16px;display:grid;gap:6px}
.info b{font-size:16px;line-height:1.25}.info span{color:var(--muted);font-size:12px}
.row{display:flex;gap:8px;margin-top:8px}
.btn{flex:1;text-align:center;padding:9px 12px;border-radius:999px;border:1px solid #2c2c33;background:#141418;color:var(--text);font-size:13px;font-weight:700}
.btn.gold{background:var(--gold);border-color:var(--gold);color:#111}
.empty{grid-column:1/-1;text-align:center;padding:70px 20px;border:1px dashed var(--line);border-radius:var(--radius);color:var(--muted)}
.empty b{display:block;color:var(--text);font-size:18px;margin-bottom:6px}
.toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,16px);opacity:0;background:#1b1b20;border:1px solid #34343a;padding:11px 16px;border-radius:12px;font-size:13px;transition:.2s;pointer-events:none}.toast.show{opacity:1;transform:translate(-50%,0)}
`;

const LIB_JS = `
var grid=document.getElementById("grid");
function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]})}
function toast(m){var t=document.getElementById("toast");t.textContent=m;t.classList.add("show");clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove("show")},2200)}
function ago(iso){var s=Math.max(0,(Date.now()-new Date(iso).getTime())/1000);if(s<3600)return Math.max(1,Math.round(s/60))+" min ago";if(s<86400)return Math.round(s/3600)+" h ago";return Math.round(s/86400)+" d ago"}
function size(b){b=Number(b||0);if(b>=1073741824)return (b/1073741824).toFixed(1)+" GB";if(b>=1048576)return Math.round(b/1048576)+" MB";return ""}
function view(i){
  var t=encodeURIComponent(i.token);
  if(i.recording_id&&i.recording_status==="completed")return {href:"/watch/"+t+"?recording="+encodeURIComponent(i.recording_id),pill:'<span class="pill ready">REPLAY READY</span>',note:"Saved replay"+(size(i.size_bytes)?" \\u2022 "+size(i.size_bytes):"")};
  if(i.recording_id&&i.recording_status==="recording")return {href:"/watch/"+t,pill:i.live?'<span class="pill live">LIVE NOW</span>':'<span class="pill">PROCESSING</span>',note:i.live?"Live now. The replay will be ready when it ends.":"Replay is being prepared."};
  return {href:"/watch/"+t,pill:i.live?'<span class="pill live">LIVE NOW</span>':'<span class="pill">OFFLINE</span>',note:"Opens the broadcast page"};
}
async function load(){
  try{var r=await fetch("/api/public/saved",{credentials:"same-origin",cache:"no-store"}),d=await r.json();if(!r.ok)throw new Error();render(d.items||[])}
  catch(e){grid.innerHTML='<div class="empty"><b>Could not load your saved list</b>Please refresh the page.</div>'}
}
function render(items){
  if(!items.length){grid.innerHTML='<div class="empty"><b>Nothing saved yet</b>Open a broadcast or replay and tap \\u201cSave for later\\u201d.</div>';return}
  grid.innerHTML=items.map(function(i){var v=view(i);
    return '<article class="card"><a class="thumb" href="'+esc(v.href)+'">'+v.pill+'\\u25B6</a><div class="info"><b>'+esc(i.title||i.name)+'</b><span>'+esc(v.note)+' \\u2022 saved '+ago(i.saved_at)+'</span><div class="row"><a class="btn gold" href="'+esc(v.href)+'">Watch</a><button class="btn" type="button" data-rm="'+esc(i.id)+'">Remove</button></div></div></article>'}).join("");
  grid.querySelectorAll("[data-rm]").forEach(function(b){b.onclick=function(){
    b.disabled=true;
    fetch("/api/public/saved/"+encodeURIComponent(b.dataset.rm),{method:"DELETE",credentials:"same-origin"}).then(function(r){if(!r.ok)throw new Error();toast("Removed");load()}).catch(function(){b.disabled=false;toast("Could not remove. Try again.")})}})
}
load();setInterval(load,30000);
`;

function libraryPage() {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="theme-color" content="#09090a"><title>My Saved \u2022 FBI Live</title>' +
    "<style>" + LIB_CSS + "</style></head><body>" +
    '<header class="top"><span class="brand"><i>FBI</i>FBI LIVE</span></header>' +
    '<main class="wrap"><h1>My Saved</h1>' +
    '<div class="sub">Broadcasts and replays you saved to watch later. Saved on this device and browser.</div>' +
    '<div class="grid" id="grid"></div></main><div class="toast" id="toast" role="status"></div>' +
    "<script>" + LIB_JS + "</script></body></html>"
  );
}

/* ------------------------------------------------------------------ */
/* Database + routes                                                   */
/* ------------------------------------------------------------------ */

const SAVED_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS viewer_saved_videos(
  id uuid PRIMARY KEY,
  viewer_id text NOT NULL,
  stream_id uuid NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  recording_id uuid REFERENCES stream_recordings(id) ON DELETE CASCADE,
  saved_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_viewer_saved_videos ON viewer_saved_videos(viewer_id,stream_id,(COALESCE(recording_id,'00000000-0000-0000-0000-000000000000'::uuid)));
CREATE INDEX IF NOT EXISTS idx_viewer_saved_videos_viewer ON viewer_saved_videos(viewer_id,saved_at DESC);
`;

function registerViewerSave(app, { pool, publicStreamByToken, cookies }) {
  function viewerId(req, res) {
    let id = cookies(req)[VIEWER_COOKIE];
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(id || ""))) {
      id = crypto.randomBytes(24).toString("base64url");
      res.append(
        "Set-Cookie",
        VIEWER_COOKIE + "=" + id + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000"
      );
    }
    return id;
  }

  // Which recording does a save refer to? An explicit id wins (it must belong
  // to this stream). Otherwise the stream's newest recording: the one in
  // progress while live, or the last completed one when offline.
  async function resolveRecording(stream, raw) {
    const given = String(raw || "").trim();
    if (given) {
      if (!UUID.test(given)) return { error: "Invalid recording." };
      const q = await pool.query("SELECT id FROM stream_recordings WHERE id=$1 AND stream_id=$2", [given, stream.id]);
      return q.rowCount ? { id: q.rows[0].id } : { error: "Recording not found." };
    }
    const q = await pool.query(
      "SELECT id FROM stream_recordings WHERE stream_id=$1 ORDER BY created_at DESC LIMIT 1",
      [stream.id]
    );
    return { id: q.rows[0]?.id || null };
  }

  const MATCH =
    "viewer_id=$1 AND stream_id=$2 AND COALESCE(recording_id,'00000000-0000-0000-0000-000000000000'::uuid)=COALESCE($3::uuid,'00000000-0000-0000-0000-000000000000'::uuid)";

  async function target(req, res, raw) {
    const r = await publicStreamByToken(req.params.token);
    if (!r.rowCount) {
      res.status(404).json({ error: "Stream not found" });
      return null;
    }
    const stream = r.rows[0];
    const rec = await resolveRecording(stream, raw);
    if (rec.error) {
      res.status(400).json({ error: rec.error });
      return null;
    }
    return { stream, recordingId: rec.id, vid: viewerId(req, res) };
  }

  app.get("/api/public/stream/:token/saved", async (req, res) => {
    try {
      const t = await target(req, res, req.query.recordingId);
      if (!t) return;
      const q = await pool.query("SELECT 1 FROM viewer_saved_videos WHERE " + MATCH, [t.vid, t.stream.id, t.recordingId]);
      res.set("Cache-Control", "no-store").json({ saved: q.rowCount > 0 });
    } catch (e) {
      console.error("Saved check failed:", e?.message || e);
      res.status(500).json({ error: "Could not check saved status." });
    }
  });

  app.post("/api/public/stream/:token/save", async (req, res) => {
    try {
      const t = await target(req, res, req.body?.recordingId);
      if (!t) return;
      const c = await pool.query("SELECT count(*)::int AS c FROM viewer_saved_videos WHERE viewer_id=$1", [t.vid]);
      if (Number(c.rows[0]?.c || 0) >= MAX_SAVED) return res.status(400).json({ error: "Your saved list is full." });
      await pool.query(
        "INSERT INTO viewer_saved_videos(id,viewer_id,stream_id,recording_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [crypto.randomUUID(), t.vid, t.stream.id, t.recordingId]
      );
      res.json({ ok: true, saved: true });
    } catch (e) {
      console.error("Save failed:", e?.message || e);
      res.status(500).json({ error: "Could not save." });
    }
  });

  app.delete("/api/public/stream/:token/save", async (req, res) => {
    try {
      const t = await target(req, res, req.query.recordingId);
      if (!t) return;
      await pool.query("DELETE FROM viewer_saved_videos WHERE " + MATCH, [t.vid, t.stream.id, t.recordingId]);
      res.json({ ok: true, saved: false });
    } catch (e) {
      console.error("Unsave failed:", e?.message || e);
      res.status(500).json({ error: "Could not remove." });
    }
  });

  app.get("/api/public/saved", async (req, res) => {
    try {
      const q = await pool.query(
        `SELECT v.id,v.saved_at,s.name,s.title,s.viewer_token AS token,s.status,
                r.id AS recording_id,r.status AS recording_status,r.size_bytes,r.ended_at
         FROM viewer_saved_videos v
         JOIN streams s ON s.id=v.stream_id AND s.enabled=true AND s.shared=true
         LEFT JOIN stream_recordings r ON r.id=v.recording_id
         WHERE v.viewer_id=$1
         ORDER BY v.saved_at DESC LIMIT ${MAX_SAVED}`,
        [viewerId(req, res)]
      );
      res.set("Cache-Control", "no-store").json({
        items: q.rows.map((r) => ({
          id: r.id,
          name: r.name,
          title: r.title,
          token: r.token,
          live: r.status === "live",
          recording_id: r.recording_id,
          recording_status: r.recording_status,
          size_bytes: Number(r.size_bytes || 0),
          saved_at: r.saved_at,
        })),
      });
    } catch (e) {
      console.error("Saved list failed:", e?.message || e);
      res.status(500).json({ error: "Could not load saved list." });
    }
  });

  app.delete("/api/public/saved/:id", async (req, res) => {
    try {
      if (!UUID.test(String(req.params.id || ""))) return res.status(400).json({ error: "Invalid id." });
      await pool.query("DELETE FROM viewer_saved_videos WHERE id=$1 AND viewer_id=$2", [req.params.id, viewerId(req, res)]);
      res.json({ ok: true });
    } catch (e) {
      console.error("Saved remove failed:", e?.message || e);
      res.status(500).json({ error: "Could not remove." });
    }
  });

  app.get("/library", (req, res) => {
    res.set("Cache-Control", "no-store").type("html").send(libraryPage());
  });
}

module.exports = {
  WATCH_CSS,
  WATCH_TOPBAR,
  WATCH_ACTIONS,
  PINNED_JS,
  SAVE_JS,
  SAVED_SCHEMA_SQL,
  registerViewerSave,
};
