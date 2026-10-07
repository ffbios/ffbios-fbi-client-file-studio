const { page, topbar } = require("./shared");

const CSS = `
h1{font-size:clamp(24px,4vw,38px);margin:8px 0 6px;font-weight:850}
.eyebrow{color:var(--gold);font-size:11px;font-weight:900;letter-spacing:.18em;text-transform:uppercase}
.meta{display:flex;gap:10px;align-items:center;color:var(--muted);font-size:13px;margin-bottom:16px}
.player{position:relative;background:#000;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;box-shadow:0 30px 90px rgba(0,0,0,.55)}
.player video{width:100%;display:block;aspect-ratio:16/9;background:#000}
.overlay{position:absolute;inset:0;display:grid;place-items:center;align-content:center;gap:8px;text-align:center;padding:24px;background:radial-gradient(circle at 50% 35%,#171a21,#050607);color:var(--muted)}
.overlay h2{margin:0;color:var(--text);font-size:20px}
.hidden{display:none!important}
`;

function programPage() {
  const body = `${topbar("")}
<main class="wrap">
  <div class="eyebrow">Film Beyond Imagination &bull; FBI TV</div>
  <h1>Program</h1>
  <div class="meta"><span class="badge" id="badge">Connecting&hellip;</span><span id="name"></span></div>
  <section class="player">
    <video id="video" controls autoplay muted playsinline></video>
    <div class="overlay" id="overlay"><h2>Connecting&hellip;</h2><span>Checking the program output.</span></div>
  </section>
  <div class="foot">FBI TV &bull; Official program output</div>
</main>`;
  // Same playback and polling logic as before the redesign.
  const script = `
var video=document.getElementById("video"),overlay=document.getElementById("overlay"),badge=document.getElementById("badge"),nameEl=document.getElementById("name"),hls=null,current="";
function show(t,p){overlay.classList.remove("hidden");overlay.innerHTML="<h2></h2><span></span>";overlay.firstChild.textContent=t;overlay.lastChild.textContent=p;video.style.visibility="hidden"}
function stop(){if(hls){try{hls.destroy()}catch(e){}hls=null}video.pause();video.removeAttribute("src");video.load()}
function start(url){stop();overlay.classList.add("hidden");video.style.visibility="visible";
 if(window.Hls&&Hls.isSupported()){hls=new Hls({enableWorker:true,lowLatencyMode:false,liveSyncDurationCount:3,liveMaxLatencyDurationCount:6,maxBufferLength:30,maxMaxBufferLength:60,backBufferLength:90});
  hls.loadSource(url);hls.attachMedia(video);
  hls.on(Hls.Events.MANIFEST_PARSED,function(){video.play().catch(function(){})});
  hls.on(Hls.Events.ERROR,function(_,d){if(d&&d.fatal){setTimeout(function(){if(current)start(url)},1500)}})}
 else{video.src=url;video.play().catch(function(){})}}
async function refresh(){
 try{
  var r=await fetch("/api/public/program/status",{cache:"no-store"}),d=await r.json();
  badge.textContent=d.program?(d.live?"LIVE":"OFFLINE"):"NO SOURCE";badge.className="badge"+(d.live?" live":"");
  nameEl.textContent=d.program?(d.program.title||d.program.name||""):"";
  if(d.live){if(current!==d.program.id){current=d.program.id;start(d.hls_url)}}
  else{if(current){current="";stop()}show(d.program?"Program is offline":"No program selected",d.program?"It will resume automatically.":"No program source is currently selected.")}
 }catch(e){badge.textContent="UNAVAILABLE";badge.className="badge";show("Program unavailable","Retrying automatically\\u2026")}
}
refresh();setInterval(refresh,5000);
`;
  return page({ title: "Program • FBI TV", body, css: CSS, script, withHls: true });
}

module.exports = { programPage };
