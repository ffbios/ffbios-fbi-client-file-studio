(()=>{
"use strict";

const A={
  sources:new Map(),
  selectedSource:"",
  selectedChannel:"",
  programChannel:"",
  localProgram:"",
  bridge:null,
  mv:null,
  obs:null,
  timer:null
};

const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
const api=async(url,options={})=>{const r=await fetch(url,options);let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||"Request failed");return d};
const activeChannelId=()=>document.querySelector("#channels .channel.active")?.dataset.id||"";
const toast=msg=>{let t=document.getElementById("fbiLiveToast");if(!t){t=document.createElement("div");t.id="fbiLiveToast";document.body.appendChild(t)}t.textContent=msg;t.style.cssText="position:fixed;right:18px;bottom:18px;z-index:10000;background:#151518;color:#f4f4f6;border:1px solid #37373d;border-radius:9px;padding:10px 13px;font:800 9px Inter,system-ui,sans-serif;box-shadow:0 20px 70px rgba(0,0,0,.65)";clearTimeout(t._t);t._t=setTimeout(()=>t.remove(),2400)};

function injectStyle(){
  if(document.getElementById("fbiLiveAddonStyle"))return;
  const s=document.createElement("style");s.id="fbiLiveAddonStyle";
  s.textContent=`
.fbi-addon-local{position:fixed;left:285px;right:18px;bottom:18px;z-index:5000;background:#0d0d10;border:1px solid #36363d;border-radius:13px;box-shadow:0 30px 110px rgba(0,0,0,.78);display:none;overflow:hidden}
.fbi-addon-local.open{display:block}.fbi-addon-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 13px;border-bottom:1px solid #28282e;background:#111114}.fbi-addon-head b{display:block;font-size:10px}.fbi-addon-head span{display:block;color:#787881;font-size:6px;margin-top:3px}.fbi-addon-actions{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}.fbi-addon-btn{border:1px solid #323238;background:#18181b;color:#ededf0;border-radius:7px;padding:7px 9px;font-size:7px;font-weight:850;cursor:pointer}.fbi-addon-btn.gold{background:#e7c44f;border-color:#e7c44f;color:#13130f}.fbi-addon-btn.danger{background:#321416;border-color:#68282b;color:#ffb2b9}.fbi-addon-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;padding:10px;max-height:42vh;overflow:auto}.fbi-addon-source{border:1px solid #29292f;background:#101013;border-radius:9px;overflow:hidden}.fbi-addon-source.preview{border-color:#65a7ff;box-shadow:0 0 0 1px rgba(101,167,255,.12)}.fbi-addon-source.program{border-color:#e7c44f;box-shadow:0 0 0 1px rgba(231,196,79,.12)}.fbi-addon-visual{aspect-ratio:16/9;background:#000;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center}.fbi-addon-visual video,.fbi-addon-visual img{width:100%;height:100%;display:block;object-fit:cover}.fbi-addon-special{color:#e7c44f;font-size:12px;font-weight:900}.fbi-addon-special span{display:block;margin-top:4px;font-size:6px;color:#777780;text-align:center}.fbi-addon-badge{position:absolute;top:5px;left:5px;padding:3px 5px;background:rgba(0,0,0,.7);border:1px solid rgba(255,255,255,.14);border-radius:4px;font-size:5px;color:#ddd}.fbi-addon-source-body{padding:7px}.fbi-addon-source-name{font-size:8px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fbi-addon-source-meta{font-size:6px;color:#75757d;margin-top:3px}.fbi-addon-source-actions{display:grid;grid-template-columns:1fr 1fr 28px;gap:4px;margin-top:6px}.fbi-addon-source-actions button{border:1px solid #303037;background:#18181b;color:#ededf0;border-radius:6px;padding:6px 5px;font-size:6px;font-weight:850;cursor:pointer}.fbi-addon-source-actions button.primary{background:#e7c44f;color:#14140f;border-color:#e7c44f}.fbi-addon-tbar{display:grid;grid-template-columns:minmax(180px,1fr) 2.5fr auto;gap:10px;align-items:center;padding:10px;border-top:1px solid #28282e;background:#09090c}.fbi-addon-status b{display:block;font-size:8px}.fbi-addon-status span{display:block;color:#73737b;font-size:6px;margin-top:3px;line-height:1.45}.fbi-addon-range{width:100%;accent-color:#e7c44f}.fbi-addon-range-label{display:flex;justify-content:space-between;color:#777780;font-size:6px}.fbi-addon-range-label b{color:#e7c44f}.fbi-addon-mv{position:fixed;inset:0;z-index:8000;background:rgba(0,0,0,.84);display:none;padding:18px}.fbi-addon-mv.open{display:grid;place-items:center}.fbi-addon-mv-card{width:min(1240px,100%);max-height:calc(100vh - 36px);overflow:auto;background:#0d0d10;border:1px solid #37373d;border-radius:13px;box-shadow:0 35px 120px rgba(0,0,0,.8)}.fbi-addon-mv-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:10px}.fbi-addon-mv-card-item{border:1px solid #2b2b31;border-radius:8px;overflow:hidden;background:#111114}.fbi-addon-mv-visual{aspect-ratio:16/9;background:#000;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}.fbi-addon-mv-visual video,.fbi-addon-mv-visual img{width:100%;height:100%;object-fit:cover}.fbi-addon-mv-body{padding:7px}.fbi-addon-mv-body b{display:block;font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fbi-addon-mv-body span{display:block;margin-top:3px;font-size:6px;color:#75757d}.fbi-addon-mv-actions{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:6px}.fbi-addon-mv-actions button{border:1px solid #303037;background:#18181b;color:#ececf0;border-radius:6px;padding:6px;font-size:6px;font-weight:850;cursor:pointer}.fbi-addon-mv-actions button.primary{background:#e7c44f;color:#14140f;border-color:#e7c44f}.fbi-addon-take{border-color:#d2b33e!important;background:#2a250f!important;color:#e7c44f!important}
@media(max-width:1000px){.fbi-addon-local{left:18px}.fbi-addon-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.fbi-addon-tbar{grid-template-columns:1fr}}@media(max-width:650px){.fbi-addon-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.fbi-addon-mv-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
  document.head.appendChild(s);
}

async function channel(id){return api("/api/live/streams/"+encodeURIComponent(id),{cache:"no-store"}).then(x=>x.stream)}
function hlsUrl(s){const token=s?.viewer_url?String(s.viewer_url).split("/watch/").pop().split(/[?#]/)[0]:"";return token?"/api/public/stream/"+encodeURIComponent(token)+"/hls/index.m3u8":""}
function destroyHls(v){
  if(!v)return;
  try{v.__fbiHls?.destroy?.()}catch{}
  v.__fbiHls=null;
}
function setHls(v,url){
  if(!v||!url)return;
  destroyHls(v);v.srcObject=null;v.removeAttribute("src");v.load();
  if(window.Hls&&window.Hls.isSupported()){
    const h=new Hls({enableWorker:true,lowLatencyMode:false,liveSyncDurationCount:3,liveMaxLatencyDurationCount:8,maxBufferLength:20,maxMaxBufferLength:45,backBufferLength:30,capLevelToPlayerSize:true,startLevel:-1,xhrSetup:x=>{x.withCredentials=true}});
    h.loadSource(url);h.attachMedia(v);h.on(Hls.Events.MANIFEST_PARSED,()=>v.play().catch(()=>{}));h.on(Hls.Events.ERROR,(e,d)=>{if(d?.fatal){try{h.destroy()}catch{}setTimeout(()=>setHls(v,url),1200)}});v.__fbiHls=h;
  }else{v.src=url;v.load();v.play().catch(()=>{})}
}

function selectedPreviewVideo(){
  const v=document.getElementById("previewVideo");return v||null
}
function programVideo(){
  return document.getElementById("programVideo")||null
}

async function putChannelInProgram(openWatch=true){
  const id=activeChannelId();if(!id){toast("Select a channel first.");return}
  let s;try{s=await channel(id)}catch(e){toast(e.message||"Could not load channel.");return}
  A.programChannel=id;A.localProgram="";
  const pv=programVideo();if(pv){pv.dataset.fbiProgram="channel";setHls(pv,hlsUrl(s))}
  const btn=document.getElementById("fbiTakeChannel");if(btn)btn.classList.add("fbi-addon-take");
  toast(s.name+" is now PROGRAM");
  if(openWatch&&s.viewer_url)window.open(s.viewer_url,"_blank","noopener");
}

function setLocalProgramVisual(src){
  const v=programVideo();if(!v||!src)return;
  destroyHls(v);v.removeAttribute("src");v.load();v.autoplay=true;v.muted=true;v.playsInline=true;v.srcObject=src.stream||null;v.dataset.fbiProgram="local";v.play().catch(()=>{});
}

function ensureAudio(out,src){
  if(!src?.stream?.getAudioTracks?.().length||out.nodes.has(src.id))return;
  try{
    const ms=new MediaStream(src.stream.getAudioTracks()),input=out.audio.createMediaStreamSource(ms),gain=out.audio.createGain();
    gain.gain.value=0;input.connect(gain);gain.connect(out.dest);out.nodes.set(src.id,{input,gain});
  }catch{}
}
function selectAudio(out,id){
  out.nodes.forEach((n,sid)=>{const v=sid===id?1:0;try{n.gain.gain.setTargetAtTime(v,out.audio.currentTime,.05)}catch{n.gain.gain.value=v}});
}
function makeProgramStream(){
  const c=document.createElement("canvas");c.width=1920;c.height=1080;
  const ctx=c.getContext("2d",{alpha:false});const video=c.captureStream(30);
  const AudioContext=window.AudioContext||window.webkitAudioContext;if(!AudioContext)throw new Error("Web Audio is not supported.");
  const audio=new AudioContext(),dest=audio.createMediaStreamDestination();
  const combined=new MediaStream([...video.getVideoTracks(),...dest.stream.getAudioTracks()]);
  const types=["video/webm;codecs=vp8,opus","video/webm;codecs=vp9,opus","video/webm;codecs=vp8","video/webm"];
  const mime=types.find(t=>MediaRecorder.isTypeSupported?.(t))||"";if(!mime)throw new Error("This browser cannot encode the Local Studio output.");
  const recorder=new MediaRecorder(combined,{mimeType:mime,videoBitsPerSecond:4500000,audioBitsPerSecond:128000});
  return {canvas:c,ctx,audio,dest,nodes:new Map(),recorder,raf:0};
}
function draw(out){
  if(!out)return;
  const ctx=out.ctx;ctx.fillStyle="#000";ctx.fillRect(0,0,1920,1080);
  const src=A.sources.get(A.localProgram);const v=src?.video;
  if(src?.kind!=="AUDIO"&&v&&v.readyState>=2&&v.videoWidth){
    const scale=Math.max(1920/v.videoWidth,1080/v.videoHeight),w=v.videoWidth*scale,h=v.videoHeight*scale;
    ctx.drawImage(v,(1920-w)/2,(1080-h)/2,w,h);
  }
  out.raf=requestAnimationFrame(()=>draw(out));
}

async function gatewayStart(src){
  const id=activeChannelId();if(!id)throw new Error("Select a live channel first.");
  const s=await channel(id);
  if(!s.rtmp_server||!s.stream_key)throw new Error("This channel does not have RTMP encoder details.");
  let status;
  try{status=await fetch("http://127.0.0.1:8765/status",{cache:"no-store"}).then(r=>r.json())}catch{throw new Error("Local Studio Encoder is not running. Start the FBI NDI Gateway on this production computer.")}
  if(!status)return;
  if(!A.bridge){
    const out=makeProgramStream();A.bridge={out,channelId:id,session:null};
    const start=await fetch("http://127.0.0.1:8765/local/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({rtmp_url:s.rtmp_server.replace(/\/$/,"")+"/"+s.stream_key})});
    const d=await start.json().catch(()=>({}));if(!start.ok||d.error){A.bridge=null;throw new Error(d.error||"Local Studio Encoder could not start.")}
    A.bridge.session=d.session;
    out.recorder.ondataavailable=async e=>{
      if(e.data?.size&&A.bridge?.session===d.session){
        try{
          const body=await e.data.arrayBuffer();
          const r=await fetch("http://127.0.0.1:8765/local/chunk?session="+encodeURIComponent(d.session),{method:"POST",headers:{"Content-Type":"application/octet-stream"},body});
          if(!r.ok)throw new Error();
        }catch{toast("Local Studio Encoder stopped receiving video.");stopGateway()}}
    };
    out.recorder.onstop=()=>{};
    await out.audio.resume().catch(()=>{});
    out.recorder.start(500);
    draw(out);
  }
  A.bridge.channelId=id;return A.bridge;
}
async function localTake(src){
  A.selectedSource=src.id;A.localProgram=src.id;
  try{
    const out=(await gatewayStart(src)).out;
    A.sources.forEach(x=>{if(x.stream)ensureAudio(out,x)});
    selectAudio(out,src.id);
    setLocalProgramVisual(src);
    const ch=await channel(activeChannelId());
    if(ch.viewer_url)window.open(ch.viewer_url,"_blank","noopener");
    refresh();toast(src.name+" is now PROGRAM / ON AIR");
  }catch(e){toast(e.message||"Could not put local source on air.")}
}
async function stopGateway(){
  const b=A.bridge;if(!b)return;
  try{if(b.session)await fetch("http://127.0.0.1:8765/local/stop?session="+encodeURIComponent(b.session),{method:"POST"})}catch{}
  try{b.out.recorder.stop()}catch{}cancelAnimationFrame(b.out.raf);try{b.out.audio.close()}catch{}A.bridge=null;A.localProgram="";
  restoreProgram();refresh();
}
function restoreProgram(){
  const v=programVideo();if(!v)return;
  destroyHls(v);v.srcObject=null;v.removeAttribute("src");v.load();
  if(A.programChannel){channel(A.programChannel).then(s=>{setHls(v,hlsUrl(s))}).catch(()=>{})}
}

async function addCamera(){
  if(!navigator.mediaDevices?.getUserMedia)throw new Error("Camera capture is not supported in this browser.");
  const p=await navigator.mediaDevices.getUserMedia({video:true,audio:false});p.getTracks().forEach(t=>t.stop());
  const ds=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==="videoinput");if(!ds.length)throw new Error("No camera or USB capture card found.");
  const modal=document.createElement("div");modal.className="channel-modal";modal.style.zIndex="9000";
  modal.innerHTML='<div class="channel-box"><div class="channel-head"><b>CAMERA / USB CAPTURE CARD</b><button class="channel-close" id="fbiCamClose">×</button></div><div class="channel-body"><p class="channel-help">Choose the video device to add to Local Studio.</p><div id="fbiCamList"></div></div></div>';
  document.body.appendChild(modal);const list=modal.querySelector("#fbiCamList");
  ds.forEach((d,i)=>{const row=document.createElement("div");row.style.cssText="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px;border:1px solid #29292f;border-radius:7px;margin-bottom:6px";row.innerHTML='<b style="font-size:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(d.label||("Video Device "+(i+1)))+'</b><button class="btn primary" style="font-size:7px">ADD</button>';row.querySelector("button").onclick=async()=>{modal.remove();const st=await navigator.mediaDevices.getUserMedia({video:{deviceId:{exact:d.deviceId},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}},audio:true});const src={id:"device-"+crypto.randomUUID(),name:d.label||("Camera / Capture "+(i+1)),kind:"DEVICE",detail:"Camera / USB capture",stream:st,video:document.createElement('video')};src.video.autoplay=true;src.video.muted=true;src.video.playsInline=true;src.video.srcObject=st;await src.video.play().catch(()=>{});st.getVideoTracks()[0].onended=()=>removeSource(src.id);A.sources.set(src.id,src);refresh();toast(src.name+" added")};list.appendChild(row)});
  modal.querySelector("#fbiCamClose").onclick=()=>modal.remove();modal.onclick=e=>{if(e.target===modal)modal.remove()};
}
async function addScreen(){
  if(!navigator.mediaDevices?.getDisplayMedia)throw new Error("Screen capture is not supported in this browser.");
  const st=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:30}},audio:true});
  const id="screen-"+crypto.randomUUID(),src={id,name:"Screen / Window "+([...A.sources.values()].filter(x=>x.kind==="SCREEN").length+1),kind:"SCREEN",detail:"Desktop / Window / Browser Tab",stream:st,video:document.createElement('video')};
  src.video.autoplay=true;src.video.muted=true;src.video.playsInline=true;src.video.srcObject=st;await src.video.play().catch(()=>{});st.getVideoTracks()[0].onended=()=>removeSource(id);A.sources.set(id,src);refresh();toast(src.name+" added");
}
async function addAudio(){
  if(!navigator.mediaDevices?.getUserMedia)throw new Error("Audio capture is not supported in this browser.");
  const st=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
  const id="audio-"+crypto.randomUUID(),src={id,name:"Audio Input "+([...A.sources.values()].filter(x=>x.kind==="AUDIO").length+1),kind:"AUDIO",detail:"Microphone / Line input",stream:st};
  st.getAudioTracks()[0].onended=()=>removeSource(id);A.sources.set(id,src);if(A.bridge)ensureAudio(A.bridge.out,src);refresh();toast(src.name+" added");
}
async function loadNdi(){
  try{const d=await fetch("http://127.0.0.1:8765/sources",{cache:"no-store"}).then(r=>r.json());const list=(d.sources||[]).map(String).filter(Boolean);if(!list.length)throw new Error("No NDI sources were discovered.");return list}catch{throw new Error("NDI Gateway is not available on this production computer.")}
}
async function addNdi(){
  const names=await loadNdi();const modal=document.createElement("div");modal.className="channel-modal";modal.style.zIndex="9000";
  modal.innerHTML='<div class="channel-box"><div class="channel-head"><b>NDI SOURCES</b><button class="channel-close" id="fbiNdiClose">×</button></div><div class="channel-body"><p class="channel-help">NDI sources are discovered automatically on the local network.</p><div id="fbiNdiList"></div></div></div>';document.body.appendChild(modal);const list=modal.querySelector("#fbiNdiList");
  names.forEach(name=>{const row=document.createElement("div");row.style.cssText="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px;border:1px solid #29292f;border-radius:7px;margin-bottom:6px";row.innerHTML='<b style="font-size:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(name)+'</b><button class="btn primary" style="font-size:7px">ADD</button>';row.querySelector("button").onclick=()=>{const id="ndi-"+crypto.randomUUID();A.sources.set(id,{id,name,kind:"NDI",detail:"NDI Gateway / LAN",ndiName:name});modal.remove();refresh();toast(name+" added")};list.appendChild(row)});
  modal.querySelector("#fbiNdiClose").onclick=()=>modal.remove();modal.onclick=e=>{if(e.target===modal)modal.remove()};
}
function removeSource(id){const s=A.sources.get(id);if(!s)return;try{s.stream?.getTracks?.().forEach(t=>t.stop())}catch{}if(A.bridge?.out?.nodes?.has(id)){const n=A.bridge.out.nodes.get(id);try{n.input.disconnect();n.gain.disconnect()}catch{}A.bridge.out.nodes.delete(id)}if(A.selectedSource===id)A.selectedSource="";if(A.localProgram===id){A.localProgram="";restoreProgram()}A.sources.delete(id);refresh()}
function selectPreview(id){const s=A.sources.get(id);if(!s)return;A.selectedSource=id;if(s.kind==="DEVICE"||s.kind==="SCREEN"){const v=selectedPreviewVideo();if(v){destroyHls(v);v.srcObject=s.stream;v.removeAttribute("src");v.load();v.play().catch(()=>{})}}refresh();toast(s.name+" selected in PREVIEW")}
function refresh(){
  const grid=document.getElementById("fbiLocalGrid");if(!grid)return;grid.innerHTML="";
  for(const s of A.sources.values()){
    const card=document.createElement("div");card.className="fbi-addon-source "+(s.id===A.selectedSource?"preview ":"")+(s.id===A.localProgram?"program":"");
    const visual=document.createElement("div");visual.className="fbi-addon-visual";
    if(s.kind==="DEVICE"||s.kind==="SCREEN"){const v=document.createElement("video");v.autoplay=true;v.muted=true;v.playsInline=true;v.srcObject=s.stream;v.play().catch(()=>{});visual.appendChild(v);s.galleryVideo=v}
    else if(s.kind==="NDI"){const img=document.createElement("img");img.src="http://127.0.0.1:8765/preview?source_name="+encodeURIComponent(s.ndiName||s.name)+"&t="+Date.now();visual.appendChild(img);const b=document.createElement("div");b.className="fbi-addon-badge";b.textContent="NDI";visual.appendChild(b)}
    else{visual.innerHTML='<div class="fbi-addon-special">AUDIO<span>Microphone / line input</span></div>'}
    const body=document.createElement("div");body.className="fbi-addon-source-body";body.innerHTML='<div class="fbi-addon-source-name">'+esc(s.name)+'</div><div class="fbi-addon-source-meta">'+esc(s.kind)+' • '+esc(s.detail)+'</div>';
    const acts=document.createElement("div");acts.className="fbi-addon-source-actions";
    const p=document.createElement("button");p.textContent="PREVIEW";p.className=s.id===A.selectedSource?"fbi-addon-take":"";
    const t=document.createElement("button");t.textContent=s.kind==="NDI"?"TAKE NDI":"TAKE";t.className="primary";t.onclick=()=>s.kind==="NDI"?takeNdi(s):localTake(s);
    const rm=document.createElement("button");rm.textContent="×";rm.onclick=()=>removeSource(s.id);
    p.onclick=()=>selectPreview(s.id);acts.append(p,t,rm);body.appendChild(acts);card.append(visual,body);grid.appendChild(card);
  }
  const stop=document.getElementById("fbiLocalStop");if(stop)stop.disabled=!A.bridge;
  const st=document.getElementById("fbiLocalState");if(st)st.textContent=A.bridge?"LOCAL OUTPUT LIVE":"LOCAL OUTPUT STANDBY";
  const tx=document.getElementById("fbiLocalText");if(tx)tx.textContent=A.bridge?"Local Studio is feeding the selected channel through the existing RTMP ingest.":"Select a source for Preview, then TAKE it to Program.";
}
async function takeNdi(s){
  const id=activeChannelId();if(!id){toast("Select a channel first.");return}
  try{const ch=await channel(id);await fetch("http://127.0.0.1:8765/input/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({source_name:s.ndiName,rtmp_server:ch.rtmp_server,stream_key:ch.stream_key})}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok||d.error)throw new Error(d.error||"NDI input failed")});A.localProgram=s.id;A.programChannel=id;window.open(ch.viewer_url,"_blank","noopener");setProgramNdi(s);refresh();toast(s.name+" is now PROGRAM / ON AIR")}catch(e){toast(e.message||"NDI input failed")}}
function setProgramNdi(s){const v=programVideo();if(!v)return;destroyHls(v);v.srcObject=null;v.removeAttribute("src");v.load();const img=document.createElement("img");img.style.cssText="width:100%;height:100%;object-fit:cover;display:block;background:#000";img.src="http://127.0.0.1:8765/preview?source_name="+encodeURIComponent(s.ndiName||s.name)+"&t="+Date.now();v.style.display="none";v.parentElement?.appendChild(img)}
function build(){
  injectStyle();
  if(document.getElementById("fbiLocalDrawer"))return;
  const d=document.createElement("section");d.id="fbiLocalDrawer";d.className="fbi-addon-local";
  d.innerHTML='<div class="fbi-addon-head"><div><b>LOCAL STUDIO INPUTS</b><span>Camera • USB Capture Card • Screen • Window • Audio • NDI</span></div><div class="fbi-addon-actions"><button class="fbi-addon-btn gold" id="fbiAddCam">＋ CAMERA / CAPTURE</button><button class="fbi-addon-btn" id="fbiAddScreen">＋ SCREEN / WINDOW</button><button class="fbi-addon-btn" id="fbiAddAudio">＋ AUDIO</button><button class="fbi-addon-btn" id="fbiAddNdi">＋ NDI</button><button class="fbi-addon-btn" id="fbiMulti">MULTIVIEW</button><button class="fbi-addon-btn danger" id="fbiLocalStop" disabled>STOP LOCAL OUTPUT</button><button class="fbi-addon-btn" id="fbiLocalClose">CLOSE</button></div></div><div id="fbiLocalGrid" class="fbi-addon-grid"></div><div class="fbi-addon-tbar"><div class="fbi-addon-status"><b id="fbiLocalState">LOCAL OUTPUT STANDBY</b><span id="fbiLocalText">Select a source for Preview, then TAKE it to Program.</span></div><div><input id="fbiLocalTbar" class="fbi-addon-range" type="range" min="0" max="100" value="0" step="1" disabled><div class="fbi-addon-range-label"><span>PREVIEW</span><b id="fbiLocalTbarValue">0%</b><span>PROGRAM</span></div></div><div><button class="fbi-addon-btn gold" id="fbiTakeLocal">TAKE PREVIEW TO PROGRAM</button></div></div>';
  document.body.appendChild(d);
  d.querySelector("#fbiAddCam").onclick=()=>addCamera().catch(e=>toast(e.message||"Could not open camera devices"));
  d.querySelector("#fbiAddScreen").onclick=()=>addScreen().catch(e=>toast(e.message||"Could not capture screen"));
  d.querySelector("#fbiAddAudio").onclick=()=>addAudio().catch(e=>toast(e.message||"Could not capture audio"));
  d.querySelector("#fbiAddNdi").onclick=()=>addNdi().catch(e=>toast(e.message||"NDI Gateway unavailable"));
  d.querySelector("#fbiMulti").onclick=openMultiView;
  d.querySelector("#fbiLocalStop").onclick=stopGateway;d.querySelector("#fbiLocalClose").onclick=()=>d.classList.remove("open");
  d.querySelector("#fbiTakeLocal").onclick=()=>{const s=A.sources.get(A.selectedSource);if(s)localTake(s);else toast("Select a local source for Preview first.")};
  const range=d.querySelector("#fbiLocalTbar");range.oninput=()=>{const n=Number(range.value);d.querySelector("#fbiLocalTbarValue").textContent=n+"%";if(n>=100){const s=A.sources.get(A.selectedSource);if(s)localTake(s);setTimeout(()=>{range.value=0;d.querySelector("#fbiLocalTbarValue").textContent="0%"},350)}};
}
function openLocal(){build();const id=activeChannelId();if(!id){toast("Select a live channel first.");return}A.selectedChannel=id;document.getElementById("fbiLocalDrawer").classList.add("open");refresh()}
function addControls(){
  const actions=document.querySelector(".top-actions");if(actions&&!document.getElementById("fbiLocalOpen")){const b=document.createElement("button");b.id="fbiLocalOpen";b.className="btn";b.textContent="LOCAL STUDIO";b.onclick=openLocal;actions.insertBefore(b,actions.firstChild)}
  const rack=document.querySelector("#studio .rack .panel .pb.grid2");if(rack&&!document.getElementById("fbiTakeChannel")){const b=document.createElement("button");b.className="rack-btn primary";b.id="fbiTakeChannel";b.textContent="TAKE";rack.insertBefore(b,rack.firstChild);b.onclick=()=>putChannelInProgram(true)}
  const ctrl=document.querySelector("#studio .controls .control-group");if(ctrl&&!document.getElementById("fbiTakeChannelBottom")){const b=document.createElement("button");b.className="smallbtn primary";b.id="fbiTakeChannelBottom";b.textContent="TAKE TO PROGRAM";ctrl.insertBefore(b,ctrl.firstChild);b.onclick=()=>putChannelInProgram(true)}
  build();
}
function protectProgram(){
  const id=activeChannelId();if(!id)return;
  const pv=selectedPreviewVideo(),pr=programVideo();
  if(A.localProgram)return;
  if(A.programChannel&&A.programChannel!==id){
    channel(A.programChannel).then(s=>{const v=programVideo();if(v){setHls(v,hlsUrl(s))}}).catch(()=>{});
  }
  if(!A.programChannel)A.programChannel=id;
  if(pv&&A.selectedSource&&A.sources.get(A.selectedSource)){const s=A.sources.get(A.selectedSource);if(s.kind==="DEVICE"||s.kind==="SCREEN"){try{destroyHls(pv);pv.srcObject=s.stream;pv.play().catch(()=>{})}catch{}}}
}
function openMultiView(){
  if(!A.mv){
    const m=document.createElement("div");m.id="fbiLocalMultiView";m.className="fbi-addon-mv";m.innerHTML='<div class="fbi-addon-mv-card"><div class="fbi-addon-head"><div><b>MULTIVIEW</b><span>All Local Studio sources</span></div><div class="fbi-addon-actions"><button class="fbi-addon-btn" id="fbiMvRefresh">REFRESH</button><button class="fbi-addon-btn danger" id="fbiMvClose">CLOSE</button></div></div><div class="fbi-addon-mv-grid" id="fbiMvGrid"></div></div>';document.body.appendChild(m);A.mv=m;m.querySelector("#fbiMvClose").onclick=()=>m.classList.remove("open");m.querySelector("#fbiMvRefresh").onclick=renderMultiView;m.onclick=e=>{if(e.target===m)m.classList.remove("open")}}
  A.mv.classList.add("open");renderMultiView();
}
function renderMultiView(){
  const g=document.getElementById("fbiMvGrid");if(!g)return;g.innerHTML="";
  for(const s of A.sources.values()){
    const c=document.createElement("div");c.className="fbi-addon-mv-card-item";const v=document.createElement("div");v.className="fbi-addon-mv-visual";
    if(s.kind==="DEVICE"||s.kind==="SCREEN"){const x=document.createElement("video");x.autoplay=true;x.muted=true;x.playsInline=true;x.srcObject=s.stream;x.play().catch(()=>{});v.appendChild(x)}
    else if(s.kind==="NDI"){const x=document.createElement("img");x.src="http://127.0.0.1:8765/preview?source_name="+encodeURIComponent(s.ndiName||s.name)+"&t="+Date.now();v.appendChild(x)}
    else{v.innerHTML='<div class="fbi-addon-special">AUDIO<span>Audio source</span></div>'}
    const body=document.createElement("div");body.className="fbi-addon-mv-body";body.innerHTML='<b>'+esc(s.name)+'</b><span>'+esc(s.kind)+' • '+esc(s.detail)+'</span>';const acts=document.createElement("div");acts.className="fbi-addon-mv-actions";const p=document.createElement("button");p.textContent="PREVIEW";p.onclick=()=>{selectPreview(s.id);A.mv.classList.remove("open")};const t=document.createElement("button");t.textContent=s.kind==="NDI"?"TAKE NDI":"TAKE";t.className="primary";t.onclick=()=>{A.mv.classList.remove("open");s.kind==="NDI"?takeNdi(s):localTake(s)};acts.append(p,t);body.appendChild(acts);c.append(v,body);g.appendChild(c);
  }
}
function watch(){
  if(A.timer)clearInterval(A.timer);
  A.timer=setInterval(()=>{addControls();protectProgram();if(document.getElementById("fbiLocalDrawer")?.classList.contains("open"))refresh()},1000);
}
function boot(){addControls();watch()}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
})();