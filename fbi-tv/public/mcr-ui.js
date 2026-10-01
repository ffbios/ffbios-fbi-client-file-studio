(function(){
const state={sources:[],preview:null,program:null,players:new Map(),timer:null};
const MAX_TILES=12;

function fmtTime(){return new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"})}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function toast(msg){const old=document.getElementById("mcrToast");if(old)old.remove();const t=document.createElement("div");t.id="mcrToast";t.className="mcr-toast";t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),2200)}
function copyText(v){if(!v)return;if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(v).then(()=>toast("Copied")).catch(()=>toast("Copy failed"))}else{const ta=document.createElement("textarea");ta.value=v;document.body.appendChild(ta);ta.select();document.execCommand("copy");ta.remove();toast("Copied")}}
async function ensureHls(){if(window.Hls)return window.Hls;if(window.__mcrHls)return window.__mcrHls;window.__mcrHls=new Promise((resolve,reject)=>{const s=document.createElement("script");s.src="https://cdn.jsdelivr.net/npm/hls.js@latest";s.onload=()=>resolve(window.Hls);s.onerror=reject;document.head.appendChild(s)});return window.__mcrHls}
async function attach(video,url){
  if(!video||!url)return;
  const old=video.__mcrPlayer;if(old){try{old.destroy()}catch{}video.__mcrPlayer=null}
  if(video.canPlayType("application/vnd.apple.mpegurl")){video.src=url;video.play().catch(()=>{});return}
  try{const H=await ensureHls();if(!H||!H.isSupported())throw new Error("HLS not supported");const h=new H({enableWorker:true,lowLatencyMode:false,liveSyncDurationCount:3,liveMaxLatencyDurationCount:6,maxLiveSyncPlaybackRate:1.15,maxBufferLength:20,maxMaxBufferLength:40,backBufferLength:30,capLevelToPlayerSize:true,startLevel:-1});video.__mcrPlayer=h;h.on(H.Events.MANIFEST_PARSED,()=>video.play().catch(()=>{}));h.on(H.Events.ERROR,(_,d)=>{if(d&&d.fatal){try{h.destroy()}catch{}video.__mcrPlayer=null;setTimeout(()=>attach(video,url),1500)}});h.loadSource(url);h.attachMedia(video)}catch(e){const note=video.parentElement?.querySelector(".mcr-video-status");if(note)note.textContent="Preview unavailable"}}

function sourceById(id){return state.sources.find(s=>s.id===id)||null}
function stopPlayers(){state.players.forEach(v=>{try{v.__mcrPlayer?.destroy()}catch{}v.__mcrPlayer=null;v.removeAttribute("src");v.load()});state.players.clear()}

function sourceTile(s,i){
  const live=s.status==="live";
  return '<div class="mcr-tile '+(s.is_program?"program":"")+' '+(s.is_preview?"preview":"")+'" data-source="'+esc(s.id)+'">'+
    '<div class="mcr-tile-screen">'+
      (live?'<video class="mcr-source-video" muted playsinline autoplay></video>':'<div class="mcr-no-signal"><b>NO SIGNAL</b><span>RTMP input offline</span></div>')+
      '<div class="mcr-tile-top"><span class="mcr-chan">IN '+String(i+1).padStart(2,"0")+'</span><span class="mcr-live '+(live?"on":"")+'">'+(live?"● LIVE":"OFF")+'</span></div>'+
      '<div class="mcr-tile-bottom"><div><b>'+esc(s.name)+'</b><span>'+esc(s.title||"FBI TV input")+'</span></div><div class="mcr-route-tags">'+(s.is_preview?"PREVIEW ":"")+(s.is_program?"PROGRAM":"")+'</div></div>'+
    '</div>'+
    '<div class="mcr-tile-controls"><button class="mcr-small '+(s.is_preview?"active":"")+'" data-preview="'+esc(s.id)+'">PREVIEW</button><button class="mcr-small '+(s.is_program?"active":"")+'" data-take="'+esc(s.id)+'">TAKE</button><button class="mcr-small" data-setup="'+esc(s.id)+'">SETUP</button></div>'+
  '</div>'
}

function render(){
  stopPlayers();
  const root=document.getElementById("mcrRoot");
  const liveCount=state.sources.filter(s=>s.status==="live").length;
  const program=state.program, preview=state.preview;
  root.innerHTML=
    '<div class="mcr-shell">'+
      '<header class="mcr-header">'+
        '<div class="mcr-brand"><div class="mcr-logo-mark">FBI</div><div><div class="mcr-brand-name">FBI TV</div><div class="mcr-brand-sub">MASTER CONTROL • MULTI-INPUT BROADCAST</div></div></div>'+
        '<div class="mcr-head-status"><span class="mcr-dot '+(program?"green":"amber")+'"></span><span>PROGRAM '+(program?"ACTIVE":"NOT ROUTED")+'</span><span class="mcr-divider"></span><span>'+liveCount+' INPUT'+(liveCount===1?"":"S")+' LIVE</span><span class="mcr-divider"></span><span id="mcrClock">'+fmtTime()+'</span></div>'+
        '<div class="mcr-head-actions"><button class="mcr-btn ghost" id="programLink">PROGRAM LINK</button><button class="mcr-btn gold" id="newInput">＋ NEW ENCODER</button><button class="mcr-btn ghost" id="logoutMcr">LOGOUT</button></div>'+
      '</header>'+
      '<div class="mcr-main-grid">'+
        '<section class="mcr-multiview-panel">'+
          '<div class="mcr-section-head"><div><div class="mcr-eyebrow">MULTIVIEW</div><h2>Incoming Sources</h2><p>All encoder feeds are monitored independently. Select any source for Preview or Take.</p></div><div class="mcr-head-badges"><span>'+state.sources.length+' CHANNELS</span><span>'+liveCount+' LIVE</span></div></div>'+
          '<div class="mcr-multiview">'+(state.sources.length?state.sources.slice(0,MAX_TILES).map(sourceTile).join(""):'<div class="mcr-empty"><b>NO ENCODERS CONFIGURED</b><span>Create an encoder channel to receive the first RTMP input.</span><button class="mcr-btn gold" id="newInputEmpty">＋ CREATE ENCODER</button></div>')+'</div>'+
        '</section>'+
        '<aside class="mcr-side-panel">'+
          '<div class="mcr-bus-card"><div class="mcr-bus-head"><span class="mcr-bus-label">PROGRAM</span><span class="mcr-onair '+(program?"on":"")+'">'+(program?"● ON AIR":"STANDBY")+'</span></div><div class="mcr-big-monitor">'+(program&&program.status==="live"?'<video id="mcrProgramVideo" muted playsinline autoplay></video>':'<div class="mcr-monitor-empty"><b>'+(!program?"NO PROGRAM SOURCE":"WAITING FOR PROGRAM INPUT")+'</b><span>Select a live source and press TAKE.</span></div>')+'</div><div class="mcr-bus-source">'+(program?'<b>'+esc(program.name)+'</b><span>'+esc(program.title||"")+'</span>':'<b>No source selected</b><span>The public program output is idle.</span>')+'</div></div>'+
          '<div class="mcr-bus-card preview-bus"><div class="mcr-bus-head"><span class="mcr-bus-label">PREVIEW</span><span class="mcr-preview-state">'+(preview?"READY":"SELECT SOURCE")+'</span></div><div class="mcr-preview-monitor">'+(preview&&preview.status==="live"?'<video id="mcrPreviewVideo" muted playsinline autoplay></video>':'<div class="mcr-monitor-empty"><b>'+(!preview?"NO PREVIEW":"SOURCE OFFLINE")+'</b><span>Select a source from the multiview.</span></div>')+'</div><div class="mcr-bus-source">'+(preview?'<b>'+esc(preview.name)+'</b><span>'+esc(preview.title||"")+'</span>':'<b>No source selected</b><span>Preview bus is waiting.</span>')+'</div></div>'+
          '<div class="mcr-take-deck"><div class="mcr-take-title">PROGRAM ROUTER</div><div class="mcr-route-info"><div><span>PREVIEW</span><b>'+(preview?esc(preview.name):"—")+'</b></div><div class="arrow">→</div><div><span>PROGRAM</span><b>'+(program?esc(program.name):"—")+'</b></div></div><div class="mcr-route-buttons"><button class="mcr-btn gold wide" id="takePreview" '+(preview?"":"disabled")+'>TAKE PREVIEW TO PROGRAM</button><button class="mcr-btn red wide" id="clearProgram" '+(program?"":"disabled")+'>CLEAR PROGRAM</button></div></div>'+
          '<div class="mcr-program-link"><span>PUBLIC PROGRAM OUTPUT</span><div><input readonly value="'+esc(location.origin+"/watch/program")+'"><button class="mcr-small" id="copyProgram">COPY</button></div></div>'+
        '</aside>'+
      '</div>'+
      '<section class="mcr-bottom-panel">'+
        '<div class="mcr-section-head compact"><div><div class="mcr-eyebrow">ENCODER MATRIX</div><h2>RTMP Inputs & Routing</h2></div><div class="mcr-bottom-note">Every encoder has a unique stream key. All inputs may remain connected while only the selected source goes to Program.</div></div>'+
        '<div class="mcr-encoder-table"><div class="mcr-tr mcr-th"><span>INPUT</span><span>STATUS</span><span>RTMP SERVER</span><span>STREAM KEY</span><span>VIEWER / PREVIEW</span><span>ROUTE</span><span></span></div>'+
        (state.sources.length?state.sources.map((s,i)=>'<div class="mcr-tr"><span><b>IN '+String(i+1).padStart(2,"0")+'</b> '+esc(s.name)+'</span><span><i class="mcr-status-dot '+(s.status==="live"?"live":"offline")+'"></i>'+s.status.toUpperCase()+'</span><span class="mcr-code">'+esc(s.rtmp_server||"")+'</span><span class="mcr-code key">'+esc(s.stream_key||"")+'</span><span><button class="mcr-small" data-copy-watch="'+esc(s.viewer_url||"")+'">WATCH</button> <button class="mcr-small" data-copy-ingest="'+esc(s.rtmp_url||"")+'">COPY RTMP</button></span><span><button class="mcr-small '+(s.is_preview?"active":"")+'" data-preview="'+esc(s.id)+'">PREVIEW</button> <button class="mcr-small '+(s.is_program?"active":"")+'" data-take="'+esc(s.id)+'">TAKE</button></span><span><button class="mcr-small" data-setup="'+esc(s.id)+'">⋯</button></span></div>').join(""):'<div class="mcr-empty-row">No encoder inputs yet.</div>')+
        '</div>'+
      '</section>'+
    '</div>';

  bind();
  if(preview?.status==="live")attach(document.getElementById("mcrPreviewVideo"),preview.hls_url);
  if(program?.status==="live")attach(document.getElementById("mcrProgramVideo"),program.hls_url);
  document.getElementById("mcrClock").textContent=fmtTime();
}
function bind(){
  document.querySelectorAll("[data-preview]").forEach(b=>b.onclick=()=>setPreview(b.dataset.preview));
  document.querySelectorAll("[data-take]").forEach(b=>b.onclick=()=>takeSource(b.dataset.take));
  document.querySelectorAll("[data-setup]").forEach(b=>b.onclick=()=>setupModal(b.dataset.setup));
  document.querySelectorAll("[data-copy-watch]").forEach(b=>b.onclick=()=>copyText(b.dataset.copyWatch));
  document.querySelectorAll("[data-copy-ingest]").forEach(b=>b.onclick=()=>copyText(b.dataset.copyIngest));
  const ni=document.getElementById("newInput"),ne=document.getElementById("newInputEmpty");if(ni)ni.onclick=()=>encoderModal();if(ne)ne.onclick=()=>encoderModal();
  document.getElementById("takePreview").onclick=()=>{if(state.preview)takeSource(state.preview.id)};
  document.getElementById("clearProgram").onclick=()=>setProgram("");
  document.getElementById("programLink").onclick=()=>{window.open(location.origin+"/watch/program","_blank","noopener")};
  document.getElementById("copyProgram").onclick=()=>copyText(location.origin+"/watch/program");
  document.getElementById("logoutMcr").onclick=async()=>{await api("/api/auth/logout",{method:"POST"});location.reload()};
}
async function setPreview(id){
  try{
    await api("/api/mcr/preview",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({streamId:id})});
    await refresh();
    toast("Preview source selected");
  }catch(e){toast(e.message)}
}
async function takeSource(id){
  try{
    const s=sourceById(id);if(!s)return;
    if(s.status!=="live"){toast("This input is offline");return}
    await api("/api/mcr/program",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({streamId:id})});
    await refresh();
    toast(s.name+" is now PROGRAM");
  }catch(e){toast(e.message)}
}
async function setProgram(id){
  try{await api("/api/mcr/program",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({streamId:id||null})});await refresh();toast(id?"Program updated":"Program cleared")}catch(e){toast(e.message)}
}

function modalShell(title,body,actions){const m=document.createElement("div");m.className="mcr-modal";m.innerHTML='<div class="mcr-modal-card"><div class="mcr-modal-head"><b>'+title+'</b><button class="mcr-modal-close">×</button></div><div class="mcr-modal-body">'+body+'</div><div class="mcr-modal-foot">'+actions+'</div></div>';document.body.appendChild(m);m.querySelector(".mcr-modal-close").onclick=()=>m.remove();m.onclick=e=>{if(e.target===m)m.remove()};return m}
function encoderModal(){
  const m=modalShell("Create Encoder Input",'<div class="mcr-form-grid"><label>Name<input id="encName" placeholder="e.g. Camera 1 / vMix Main"></label><label>On-screen Title<input id="encTitle" placeholder="Program source title"></label><label class="full">Description<textarea id="encDesc" placeholder="Optional source description"></textarea></label></div>','<button class="mcr-btn ghost mcr-cancel">Cancel</button><button class="mcr-btn gold mcr-create">CREATE INPUT</button>');
  m.querySelector(".mcr-cancel").onclick=()=>m.remove();m.querySelector(".mcr-create").onclick=async()=>{try{const name=m.querySelector("#encName").value.trim();if(!name){toast("Input name is required");return}const d=await api("/api/streams",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,title:m.querySelector("#encTitle").value,description:m.querySelector("#encDesc").value})});m.remove();await refresh();await setupModal(d.stream.id)}catch(e){toast(e.message)}};
}
async function setupModal(id){
  const s=sourceById(id)||state.sources.find(x=>x.id===id);if(!s)return;
  const m=modalShell("Encoder Setup • "+s.name,
    '<div class="mcr-form-grid">'+
      '<label>Input Name<input id="setName" value="'+esc(s.name)+'"></label>'+
      '<label>On-screen Title<input id="setTitle" value="'+esc(s.title||"")+'"></label>'+
      '<label class="full">Description<textarea id="setDesc">'+esc(s.description||"")+'</textarea></label>'+
      '<div class="full mcr-credential-card"><span>RTMP Publish URL</span><div><input readonly value="'+esc(s.rtmp_url||"")+'"><button class="mcr-small" id="copyPublish">COPY</button></div></div>'+
      '<div class="full mcr-credential-card"><span>RTMP Server</span><div><input readonly value="'+esc(s.rtmp_server||"")+'"><button class="mcr-small" id="copyServer">COPY</button></div></div>'+
      '<div class="full mcr-credential-card"><span>Stream Key</span><div><input id="setKey" readonly type="password" value="'+esc(s.stream_key||"")+'"><button class="mcr-small" id="showKey">SHOW</button><button class="mcr-small" id="copyKey">COPY</button></div></div>'+
      '<div class="full mcr-credential-card"><span>Viewer / Preview URL</span><div><input readonly value="'+esc(s.viewer_url||"")+'"><button class="mcr-small" id="copyViewer">COPY</button></div></div>'+
      '<label class="toggle"><input id="setShared" type="checkbox" '+(s.shared?"checked":"")+'> Allow public viewer</label>'+
      '<label class="toggle"><input id="setRecord" type="checkbox" '+(s.record_enabled?"checked":"")+'> Record this input</label>'+
    '</div>',
    '<button class="mcr-btn ghost mcr-close">CLOSE</button><button class="mcr-btn red mcr-delete">DELETE INPUT</button><button class="mcr-btn gold mcr-save">SAVE CHANGES</button><button class="mcr-btn ghost mcr-regen">REGENERATE KEY</button>');
  m.querySelector(".mcr-close").onclick=()=>m.remove();
  m.querySelector("#copyPublish").onclick=()=>copyText(s.rtmp_url);m.querySelector("#copyServer").onclick=()=>copyText(s.rtmp_server);m.querySelector("#copyKey").onclick=()=>copyText(s.stream_key);m.querySelector("#copyViewer").onclick=()=>copyText(s.viewer_url);
  m.querySelector("#showKey").onclick=function(){const x=m.querySelector("#setKey");x.type=x.type==="password"?"text":"password";this.textContent=x.type==="password"?"SHOW":"HIDE"};
  m.querySelector(".mcr-save").onclick=async()=>{try{await api("/api/streams/"+s.id,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:m.querySelector("#setName").value,title:m.querySelector("#setTitle").value,description:m.querySelector("#setDesc").value,shared:m.querySelector("#setShared").checked,record_enabled:m.querySelector("#setRecord").checked})});m.remove();await refresh();toast("Encoder settings saved")}catch(e){toast(e.message)}};
  m.querySelector(".mcr-regen").onclick=async()=>{if(!confirm("Regenerate this encoder key? The current encoder will disconnect."))return;try{await api("/api/streams/"+s.id+"/regenerate-key",{method:"POST"});m.remove();await refresh();toast("Stream key regenerated")}catch(e){toast(e.message)}};
  m.querySelector(".mcr-delete").onclick=async()=>{if(!confirm("Delete this encoder input?"))return;try{await api("/api/streams/"+s.id,{method:"DELETE"});m.remove();await refresh();toast("Encoder input deleted")}catch(e){toast(e.message)}};
}
async function refresh(){
  try{
    const d=await api("/api/mcr/overview");
    state.sources=d.sources||[];state.preview=d.preview||null;state.program=d.program||null;
    render();
  }catch(e){const root=document.getElementById("mcrRoot");root.innerHTML='<div class="mcr-error">'+esc(e.message||"MCR unavailable")+'</div>'}
}
window.renderMcr=refresh;
window.startMcr=()=>{refresh();clearInterval(state.timer);state.timer=setInterval(refresh,4000);setInterval(()=>{const c=document.getElementById("mcrClock");if(c)c.textContent=fmtTime()},1000)};
})();