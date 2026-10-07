const { page, topbar } = require("./shared");

const CSS = `
.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.eyebrow{color:var(--gold);font-size:11px;font-weight:900;letter-spacing:.18em;text-transform:uppercase}
h1{font-size:clamp(24px,4vw,38px);line-height:1.1;margin:8px 0 6px;font-weight:850;letter-spacing:-.01em}
.meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--muted);font-size:13px}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.player{position:relative;background:#000;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;box-shadow:0 30px 90px rgba(0,0,0,.55)}
.player video{width:100%;display:block;aspect-ratio:16/9;background:#000}
.overlay{position:absolute;inset:0;display:grid;place-items:center;align-content:center;gap:10px;text-align:center;padding:24px;background:radial-gradient(circle at 50% 35%,#171a21,#050607)}
.overlay h2{margin:0;font-size:20px}
.overlay p{margin:0;color:var(--muted);font-size:14px;max-width:420px}
.spinner{width:28px;height:28px;border-radius:50%;border:3px solid #2a2f39;border-top-color:var(--gold);animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.hidden{display:none!important}
.unmute{position:absolute;left:14px;bottom:62px;z-index:5}
.about{margin-top:16px;padding:16px 18px;background:var(--panel);border:1px solid var(--line);border-radius:14px;color:#c4c9d1;font-size:14px;line-height:1.6;white-space:pre-wrap}
@media(max-width:600px){.hero{align-items:flex-start}.actions{width:100%}.actions .chip{flex:1;justify-content:center}}
`;

function watchPage({ token, title, description }) {
  const body = `${topbar("")}
<main class="wrap">
  <section class="hero">
    <div>
      <div class="eyebrow">Film Beyond Imagination &bull; FBI TV</div>
      <h1>${title}</h1>
      <div class="meta"><span class="badge" id="badge">Checking&hellip;</span><span id="viewers"></span></div>
    </div>
    <div class="actions">
      <button class="chip" id="saveBtn" type="button" aria-pressed="false">&#9734; Save for later</button>
      <button class="chip" id="shareBtn" type="button">Share</button>
    </div>
  </section>
  <section class="player">
    <video id="video" controls playsinline autoplay muted></video>
    <button class="chip gold unmute hidden" id="unmute" type="button">&#128263; Tap to unmute</button>
    <div class="overlay" id="overlay"><div class="spinner" id="spin"></div><h2 id="ovTitle">Connecting&hellip;</h2><p id="ovText">Checking the broadcast status.</p></div>
  </section>
  ${description ? `<div class="about">${description}</div>` : ""}
  <div class="foot">FBI TV &bull; Live broadcast</div>
</main>`;

  // Playback logic below is the same as before the redesign: same status poll,
  // same HLS settings, same retry behaviour. Only the surrounding UI changed.
  const script = `
var token=${JSON.stringify(token)},video=document.getElementById("video"),overlay=document.getElementById("overlay"),
badge=document.getElementById("badge"),viewers=document.getElementById("viewers"),
ovTitle=document.getElementById("ovTitle"),ovText=document.getElementById("ovText"),spin=document.getElementById("spin"),
unmute=document.getElementById("unmute"),saveBtn=document.getElementById("saveBtn"),shareBtn=document.getElementById("shareBtn");
var player=null,live=false,saved=false;
function showOverlay(t,p,busy){overlay.classList.remove("hidden");ovTitle.textContent=t;ovText.textContent=p;spin.classList.toggle("hidden",!busy);video.style.visibility="hidden"}
function hideOverlay(){overlay.classList.add("hidden");video.style.visibility="visible"}
function stop(){if(player){try{player.destroy()}catch(e){}player=null}video.pause();video.removeAttribute("src");video.load()}
function start(url){stop();hideOverlay();
 if(window.Hls&&Hls.isSupported()){
  player=new Hls({enableWorker:true,lowLatencyMode:false,liveSyncDurationCount:3,liveMaxLatencyDurationCount:6,maxBufferLength:30,maxMaxBufferLength:60,backBufferLength:90});
  player.on(Hls.Events.ERROR,function(_,d){if(d&&d.fatal){setTimeout(function(){if(live)start(url)},1800)}});
  player.loadSource(url);player.attachMedia(video);
  player.on(Hls.Events.MANIFEST_PARSED,function(){video.play().catch(function(){})});return}
 video.src=url;video.play().catch(function(){})}
video.addEventListener("playing",function(){unmute.classList.toggle("hidden",!video.muted)});
video.addEventListener("volumechange",function(){if(!video.muted)unmute.classList.add("hidden")});
unmute.onclick=function(){video.muted=false;video.volume=1;unmute.classList.add("hidden")};
async function refresh(){
 try{
  var r=await fetch("/api/public/watch/"+encodeURIComponent(token)+"/status",{cache:"no-store"}),d=await r.json();
  if(!r.ok)throw new Error(d.error);
  badge.textContent=d.live?"LIVE":"OFFLINE";badge.className="badge"+(d.live?" live":"");
  viewers.textContent=d.live&&d.current_viewers?d.current_viewers+" watching":"";
  if(d.live){if(!live){live=true;start(d.hls_url+"index.m3u8")}}
  else{if(live){live=false;stop()}showOverlay("Waiting for the broadcast","This page checks automatically and will start playing the moment we go live.",true)}
 }catch(e){badge.textContent="UNAVAILABLE";badge.className="badge";showOverlay("Stream unavailable","We could not reach the broadcast. Retrying automatically\\u2026",true)}
}
refresh();setInterval(refresh,8000);

function paintSaved(){saveBtn.textContent=saved?"\\u2605 Saved":"\\u2606 Save for later";saveBtn.classList.toggle("on",saved);saveBtn.setAttribute("aria-pressed",saved?"true":"false")}
fetch("/api/public/watch/"+encodeURIComponent(token)+"/saved",{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(d){saved=!!d.saved;paintSaved()}).catch(function(){});
saveBtn.onclick=async function(){
 saveBtn.disabled=true;
 try{
  var r=await fetch("/api/public/watch/"+encodeURIComponent(token)+"/save",{method:saved?"DELETE":"POST",credentials:"same-origin"});
  if(!r.ok)throw new Error();
  saved=!saved;paintSaved();toast(saved?"Saved. Find it under My Saved.":"Removed from My Saved.")
 }catch(e){toast("Could not update your saved list. Try again.")}
 saveBtn.disabled=false};
shareBtn.onclick=async function(){
 var url=location.href;
 try{if(navigator.share){await navigator.share({title:document.title,url:url});return}await navigator.clipboard.writeText(url);toast("Link copied")}catch(e){}};
`;
  return page({ title: `${title} • FBI TV`, body, css: CSS, script, withHls: true });
}

module.exports = { watchPage };
