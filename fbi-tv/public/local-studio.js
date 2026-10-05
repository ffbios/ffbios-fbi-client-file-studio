(function(){
"use strict";

const localState={
  inputs:new Map(),
  previewId:"",
  programId:"",
  output:null,
  observer:null,
  panel:null,
  uiTimer:null
};
const OUTPUT_W=1920, OUTPUT_H=1080, FPS=30, TRANSITION_MS=650;

function apiLocal(url,opt={}){return window.api(url,opt)}
function escLocal(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function toastLocal(msg){
  if(typeof window.toast==="function"){window.toast(msg);return}
  let t=document.getElementById("localStudioToast");
  if(!t){t=document.createElement("div");t.id="localStudioToast";document.body.appendChild(t)}
  t.textContent=msg;t.style.cssText="position:fixed;right:20px;bottom:20px;z-index:1000;background:#171a20;color:#f5f6f8;border:1px solid #303640;border-radius:9px;padding:10px 13px;font:800 10px Inter,system-ui,sans-serif;box-shadow:0 15px 50px rgba(0,0,0,.5)";
  clearTimeout(t.__timer);t.__timer=setTimeout(()=>t.remove(),2400);
}

function injectStyles(){
  if(document.getElementById("localStudioStyles"))return;
  const s=document.createElement("style");s.id="localStudioStyles";
  s.textContent=`
.local-studio-panel{margin-top:12px;background:#0c0f13;border:1px solid #252a33;border-radius:12px;overflow:hidden}
.local-studio-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:12px 13px;border-bottom:1px solid #252a33}
.local-studio-head h2{font-size:13px;margin:4px 0 2px}.local-studio-head p{margin:0;color:#79818b;font-size:9px}
.local-studio-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.local-studio-actions button{border:1px solid #303640;background:#12151a;color:#e8ebef;border-radius:8px;padding:8px 10px;font-size:9px;font-weight:850;letter-spacing:.05em}
.local-studio-actions .gold{background:#e6c44c;border-color:#e6c44c;color:#111}
.local-studio-actions .danger{background:#351313;border-color:#6a2626;color:#ffb1b1}
.local-studio-grid{padding:10px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}
.local-tile{min-width:0;border:1px solid #292f37;background:#080a0d;border-radius:9px;overflow:hidden}
.local-tile.selected{border-color:#68a8ff;box-shadow:0 0 0 1px rgba(104,168,255,.12)}
.local-tile.program{border-color:#e6c44c;box-shadow:0 0 0 1px rgba(230,196,76,.12)}
.local-tile-screen{position:relative;aspect-ratio:16/9;background:#000;overflow:hidden}
.local-tile-screen video{width:100%;height:100%;display:block;object-fit:cover;background:#000}
.local-tile-label{position:absolute;left:6px;top:6px;right:6px;display:flex;justify-content:space-between;gap:5px;z-index:4}
.local-tile-label span{font-size:7px;padding:4px 5px;border-radius:4px;background:rgba(0,0,0,.62);color:#d7dce2;border:1px solid rgba(255,255,255,.1)}
.local-tile-body{padding:8px}.local-tile-name{font-size:9px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.local-tile-kind{font-size:7px;color:#727b85;margin-top:3px}
.local-tile-buttons{display:grid;grid-template-columns:1fr 1fr 34px;gap:5px;margin-top:7px}
.local-tile-buttons button{border:1px solid #2c323a;background:#13171c;color:#c9cfd6;border-radius:5px;padding:6px 5px;font-size:7px;font-weight:850}
.local-tile-buttons button.active{border-color:#b99a2c;background:#28230f;color:#e6c44c}
.local-tile-buttons .remove{color:#ffaaa0}
.local-studio-deck{display:grid;grid-template-columns:minmax(220px,1fr) 2fr;gap:10px;padding:10px;border-top:1px solid #252a33;background:#0a0d10}
.local-studio-status{border:1px solid #272d35;border-radius:8px;padding:9px;background:#080a0d}
.local-studio-status strong{display:block;font-size:9px}.local-studio-status span{display:block;font-size:7px;color:#727b85;margin-top:4px}
.local-tbar-box{border:1px solid #272d35;border-radius:8px;padding:9px;background:#080a0d}
.local-tbar-top{display:flex;justify-content:space-between;align-items:center;gap:8px}.local-tbar-top b{font-size:8px;letter-spacing:.12em}.local-tbar-top span{font-size:7px;color:#727b85}
.local-tbar{width:100%;margin:12px 0 7px;accent-color:#e6c44c}.local-tbar-scale{display:flex;justify-content:space-between;color:#69717a;font-size:7px}.local-studio-foot{padding:0 10px 10px;color:#59636e;font-size:7px}
.local-modal{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.76);display:grid;place-items:center;padding:18px}
.local-modal-card{width:min(620px,100%);max-height:min(760px,calc(100vh - 36px));overflow:auto;background:#0d1014;border:1px solid #303640;border-radius:12px;box-shadow:0 35px 100px rgba(0,0,0,.65)}
.local-modal-head{display:flex;justify-content:space-between;gap:8px;padding:11px 13px;border-bottom:1px solid #242a32}.local-modal-head b{font-size:11px}.local-modal-close{border:0;background:none;color:#87909a;font-size:20px}
.local-device-list{padding:12px;display:grid;gap:7px}.local-device{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid #292f37;background:#090b0e;border-radius:8px;padding:9px}.local-device-main{min-width:0}.local-device-main b{display:block;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.local-device-main span{display:block;color:#6f7882;font-size:7px;margin-top:3px}.local-device button{border:1px solid #303640;background:#171a20;color:#dbe0e6;border-radius:6px;padding:6px 8px;font-size:7px;font-weight:850}
@media(max-width:1100px){.local-studio-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:800px){.local-studio-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.local-studio-deck{grid-template-columns:1fr}.local-studio-head{flex-direction:column}.local-studio-actions{justify-content:flex-start}}
@media(max-width:520px){.local-studio-grid{grid-template-columns:1fr}}
`;
  document.head.appendChild(s);
}

function stopInput(source){
  if(!source)return;
  try{source.stream?.getTracks().forEach(t=>t.stop())}catch{}
  if(source.video){try{source.video.srcObject=null}catch{}}
  if(localState.output?.audioNodes?.has(source.id)){
    const node=localState.output.audioNodes.get(source.id);
    try{node.gain.gain.value=0;node.source.disconnect();node.gain.disconnect()}catch{}
    localState.output.audioNodes.delete(source.id);
  }
}

function activePreviewSource(){return localState.inputs.get(localState.previewId)||null}
function activeProgramSource(){return localState.inputs.get(localState.programId)||null}

function makeTile(source){
  const wrap=document.createElement("article");wrap.className="local-tile";
  const screen=document.createElement("div");screen.className="local-tile-screen";
  const v=document.createElement("video");v.autoplay=true;v.muted=true;v.playsInline=true;v.srcObject=source.stream;
  screen.appendChild(v);
  const labels=document.createElement("div");labels.className="local-tile-label";
  const a=document.createElement("span");a.textContent=source.kind.toUpperCase();
  const b=document.createElement("span");b.className="local-live-label";b.textContent="LOCAL";
  labels.append(a,b);screen.appendChild(labels);
  const body=document.createElement("div");body.className="local-tile-body";
  body.innerHTML='<div class="local-tile-name">'+escLocal(source.name)+'</div><div class="local-tile-kind">'+escLocal(source.detail)+'</div>';
  const buttons=document.createElement("div");buttons.className="local-tile-buttons";
  const prev=document.createElement("button");prev.textContent="PREVIEW";
  const take=document.createElement("button");take.textContent="TAKE";
  const remove=document.createElement("button");remove.className="remove";remove.textContent="×";
  buttons.append(prev,take,remove);body.appendChild(buttons);wrap.append(screen,body);
  source.el=wrap;source.tileVideo=v;source.previewBtn=prev;source.takeBtn=take;
  prev.onclick=()=>selectLocalPreview(source.id);
  take.onclick=()=>takeLocalSource(source.id);
  remove.onclick=()=>removeLocalSource(source.id);
  return wrap;
}

function renderLocalTiles(){
  const grid=document.getElementById("localStudioGrid");if(!grid)return;
  grid.innerHTML="";
  if(!localState.inputs.size){
    const empty=document.createElement("div");empty.style.cssText="grid-column:1/-1;padding:24px;text-align:center;color:#69727b;font-size:9px";
    empty.innerHTML="<b style='display:block;color:#b6bdc6;font-size:11px;margin-bottom:5px'>NO LOCAL INPUTS</b><span>Add a camera, USB capture card, screen or window to begin.</span>";
    grid.appendChild(empty);return;
  }
  localState.inputs.forEach(s=>grid.appendChild(makeTile(s)));
  updateLocalTileStates();
}
function updateLocalTileStates(){
  localState.inputs.forEach(s=>{
    if(!s.el)return;
    s.el.classList.toggle("selected",s.id===localState.previewId);
    s.el.classList.toggle("program",s.id===localState.programId);
    if(s.previewBtn)s.previewBtn.classList.toggle("active",s.id===localState.previewId);
    if(s.takeBtn)s.takeBtn.classList.toggle("active",s.id===localState.programId);
  });
}

function ensurePanel(){
  if(!document.getElementById("mcrRoot")?.querySelector(".mcr-bottom-panel"))return;
  if(document.getElementById("localStudioPanel")){renderLocalTiles();return}
  injectStyles();
  const panel=document.createElement("section");panel.id="localStudioPanel";panel.className="local-studio-panel";
  panel.innerHTML=
    '<div class="local-studio-head">'+
      '<div><div class="mcr-eyebrow">LOCAL STUDIO</div><h2>Camera, Capture Card & Screen Inputs</h2><p>Capture directly from this computer while keeping the existing RTMP/HLS engine unchanged.</p></div>'+
      '<div class="local-studio-actions">'+
        '<button id="addDeviceInput" class="gold">＋ CAMERA / CAPTURE CARD</button>'+
        '<button id="addScreenInput">＋ SCREEN / WINDOW</button>'+
        '<button id="stopLocalOutput" class="danger" disabled>STOP LOCAL OUTPUT</button>'+
      '</div>'+
    '</div>'+
    '<div id="localStudioGrid" class="local-studio-grid"></div>'+
    '<div class="local-studio-deck">'+
      '<div class="local-studio-status"><strong id="localStudioOutputState">LOCAL OUTPUT STANDBY</strong><span id="localStudioOutputText">Choose a local input, set it to Preview, then TAKE it to Program.</span></div>'+
      '<div class="local-tbar-box"><div class="local-tbar-top"><b>T-BAR</b><span id="localTbarLabel">PREVIEW → PROGRAM</span></div><input id="localTbar" class="local-tbar" type="range" min="0" max="100" value="0" step="1" disabled><div class="local-tbar-scale"><span>PREVIEW</span><span>CUT</span><span>PROGRAM</span></div></div>'+
    '</div>'+
    '<div class="local-studio-foot">Browser capture requires HTTPS and permission. USB capture cards normally appear as video devices when the operating system exposes them through the browser.</div>';
  const bottom=document.querySelector(".mcr-bottom-panel");
  bottom?.parentNode?.insertBefore(panel,bottom);
  localState.panel=panel;
  panel.querySelector("#addDeviceInput").onclick=openDevicePicker;
  panel.querySelector("#addScreenInput").onclick=addScreenInput;
  panel.querySelector("#stopLocalOutput").onclick=stopLocalOutput;
  panel.querySelector("#localTbar").oninput=handleTbar;
  renderLocalTiles();
  refreshPanelState();
}

async function ensureMediaPermission(){
  if(!navigator.mediaDevices?.getUserMedia)throw new Error("This browser does not support direct camera/device capture.");
  let temp=null;
  try{temp=await navigator.mediaDevices.getUserMedia({video:true,audio:false})}finally{try{temp?.getTracks().forEach(t=>t.stop())}catch{}}
}

async function openDevicePicker(){
  try{
    await ensureMediaPermission();
    const devices=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==="videoinput");
    if(!devices.length){toastLocal("No camera or capture-card device was found.");return}
    const modal=document.createElement("div");modal.className="local-modal";
    modal.innerHTML='<div class="local-modal-card"><div class="local-modal-head"><b>SELECT CAMERA / CAPTURE CARD</b><button class="local-modal-close">×</button></div><div class="local-device-list"></div></div>';
    document.body.appendChild(modal);
    const list=modal.querySelector(".local-device-list");
    devices.forEach((d,i)=>{
      const row=document.createElement("div");row.className="local-device";
      const main=document.createElement("div");main.className="local-device-main";
      main.innerHTML="<b>"+escLocal(d.label||("Video Device "+(i+1)))+"</b><span>Browser video input • "+escLocal(d.deviceId.slice(0,10))+"…</span>";
      const btn=document.createElement("button");btn.textContent="USE DEVICE";
      btn.onclick=async()=>{try{modal.remove();await addDeviceInput(d)}catch(e){toastLocal(e.message||"Could not open device")}};
      row.append(main,btn);list.appendChild(row);
    });
    modal.querySelector(".local-modal-close").onclick=()=>modal.remove();
    modal.onclick=e=>{if(e.target===modal)modal.remove()};
  }catch(e){toastLocal(e.message||"Device permission was not granted.")}
}

async function addDeviceInput(device){
  if(localState.inputs.size>=8)throw new Error("Maximum of 8 local inputs is supported.");
  const constraints={
    video:{
      deviceId:{exact:device.deviceId},
      width:{ideal:1920,max:3840},
      height:{ideal:1080,max:2160},
      frameRate:{ideal:30,max:60}
    },
    audio:true
  };
  const stream=await navigator.mediaDevices.getUserMedia(constraints);
  const n=localState.inputs.size+1;
  const source={id:"cam-"+crypto.randomUUID(),name:device.label||("Camera / Capture "+n),kind:"device",detail:"Camera / USB capture device",stream,createdAt:Date.now()};
  const vTracks=stream.getVideoTracks();if(!vTracks.length){stopInput(source);throw new Error("The selected device did not provide video.")}
  vTracks[0].onended=()=>removeLocalSource(source.id);
  localState.inputs.set(source.id,source);renderLocalTiles();refreshPanelState();
  toastLocal(source.name+" added");
}

async function addScreenInput(){
  if(localState.inputs.size>=8)throw new Error("Maximum of 8 local inputs is supported.");
  if(!navigator.mediaDevices?.getDisplayMedia)throw new Error("This browser does not support screen or window capture.");
  try{
    const stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:30,max:60}},audio:true});
    const n=[...localState.inputs.values()].filter(s=>s.kind==="screen").length+1;
    const source={id:"screen-"+crypto.randomUUID(),name:"Screen / Window "+n,kind:"screen",detail:"Desktop, window or browser tab",stream,createdAt:Date.now()};
    stream.getVideoTracks()[0].onended=()=>removeLocalSource(source.id);
    localState.inputs.set(source.id,source);renderLocalTiles();refreshPanelState();
    toastLocal(source.name+" added");
  }catch(e){
    if(e?.name!=="NotAllowedError")toastLocal(e.message||"Could not start screen capture.");
  }
}

function removeLocalSource(id){
  const source=localState.inputs.get(id);if(!source)return;
  if(localState.previewId===id){
    localState.previewId="";
    window.renderMcr?.();
  }
  if(localState.programId===id){
    localState.programId="";
    if(localState.output)stopLocalOutput();
  }
  stopInput(source);
  localState.inputs.delete(id);renderLocalTiles();refreshPanelState();
}

function replaceExistingPreviewWithLocal(source){
  const monitor=document.querySelector(".mcr-preview-monitor");
  const bus=document.querySelector(".mcr-side-panel .preview-bus .mcr-bus-source");
  if(!monitor)return;
  monitor.innerHTML="";
  const v=document.createElement("video");v.autoplay=true;v.muted=true;v.playsInline=true;v.srcObject=source.stream;monitor.appendChild(v);
  if(bus)bus.innerHTML="<b>"+escLocal(source.name)+"</b><span>"+escLocal(source.detail)+"</span>";
}

function selectLocalPreview(id){
  const source=localState.inputs.get(id);if(!source)return;
  localState.previewId=id;
  replaceExistingPreviewWithLocal(source);
  updateLocalTileStates();
  const t=document.getElementById("localTbar");if(t)t.value=0;
  refreshPanelState();
  toastLocal(source.name+" is ready in PREVIEW");
}

function getExistingProgramVideo(){
  const v=document.getElementById("mcrProgramVideo");
  return v&&v.readyState>=2?v:null;
}

function fitVideo(ctx,video,alpha=1){
  if(!video||video.readyState<2||!video.videoWidth||!video.videoHeight)return false;
  const sw=video.videoWidth,sh=video.videoHeight;
  const scale=Math.max(OUTPUT_W/sw,OUTPUT_H/sh);
  const dw=sw*scale,dh=sh*scale;
  const x=(OUTPUT_W-dw)/2,y=(OUTPUT_H-dh)/2;
  ctx.globalAlpha=alpha;ctx.drawImage(video,x,y,dw,dh);ctx.globalAlpha=1;
  return true;
}

function ensureAudioNode(out,source){
  if(!out?.audioCtx||!source?.stream?.getAudioTracks?.().length)return null;
  if(out.audioNodes.has(source.id))return out.audioNodes.get(source.id);
  try{
    const audioStream=new MediaStream(source.stream.getAudioTracks());
    const nodeSource=out.audioCtx.createMediaStreamSource(audioStream);
    const gain=out.audioCtx.createGain();gain.gain.value=0;
    nodeSource.connect(gain);gain.connect(out.audioDest);
    const node={source:nodeSource,gain};out.audioNodes.set(source.id,node);return node;
  }catch(e){console.warn("Local studio audio input:",e);return null}
}

function setAudioProgram(id){
  const out=localState.output;if(!out)return;
  const current=localState.inputs.get(id);
  localState.inputs.forEach((source,sid)=>{
    const node=ensureAudioNode(out,source);if(!node)return;
    const target=sid===id?1:0;
    try{node.gain.gain.setTargetAtTime(target,out.audioCtx.currentTime,.05)}catch{node.gain.gain.value=target}
  });
  if(current&&!current.stream.getAudioTracks().length){
    try{out.audioDest.disconnect?.()}catch{}
  }
}

function outputMime(){
  const types=[
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8",
    "video/webm"
  ];
  return types.find(t=>window.MediaRecorder?.isTypeSupported?.(t))||"";
}

function drawOutputFrame(){
  const out=localState.output;if(!out)return;
  const ctx=out.ctx;
  ctx.fillStyle="#000";ctx.fillRect(0,0,OUTPUT_W,OUTPUT_H);
  if(out.transition){
    const now=performance.now(),p=Math.max(0,Math.min(1,(now-out.transition.start)/out.transition.duration));
    const okFrom=fitVideo(ctx,out.transition.from,1-p);
    fitVideo(ctx,out.transition.to,p);
    if(p>=1){
      localState.programId=out.transition.toId||localState.programId;
      out.transition=null;
      setAudioProgram(localState.programId);
      updateLocalTileStates();refreshPanelState();
    }
  }else{
    const source=activeProgramSource();
    if(source)fitVideo(ctx,source.videoEl||source.tileVideo,1);
    else if(out.fallbackProgram)fitVideo(ctx,out.fallbackProgram,1);
  }
  out.raf=requestAnimationFrame(drawOutputFrame);
}

async function startLocalOutput(firstSource,fromVideo){
  if(localState.output?.ws?.readyState===WebSocket.OPEN)return localState.output;
  const d=await apiLocal("/api/local-studio/start",{method:"POST"});
  const ws=new WebSocket(d.ws_url);
  const canvas=document.createElement("canvas");canvas.width=OUTPUT_W;canvas.height=OUTPUT_H;
  const ctx=canvas.getContext("2d",{alpha:false});
  const audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  const audioDest=audioCtx.createMediaStreamDestination();
  const videoStream=canvas.captureStream(FPS);
  const tracks=[...videoStream.getVideoTracks(),...audioDest.stream.getAudioTracks()];
  const combined=new MediaStream(tracks);
  const mime=outputMime();
  if(!window.MediaRecorder||!mime)throw new Error("This browser cannot encode the local studio output.");
  const recorder=new MediaRecorder(combined,{mimeType:mime,videoBitsPerSecond:4_500_000,audioBitsPerSecond:128_000});
  const out={streamId:d.output_stream_id,ws,canvas,ctx,audioCtx,audioDest,audioNodes:new Map(),recorder,raf:0,fallbackProgram:fromVideo||null,transition:null};
  localState.output=out;
  ws.onopen=()=>{
    try{audioCtx.resume()}catch{}
    recorder.start(750);
    if(firstSource){
      const toVideo=firstSource.tileVideo;
      out.transition=fromVideo?{from:fromVideo,to:toVideo,toId:firstSource.id,start:performance.now(),duration:TRANSITION_MS}:null;
      localState.programId=firstSource.id;
      if(!out.transition)setAudioProgram(firstSource.id);
      drawOutputFrame();
    }
    refreshPanelState();
  };
  recorder.ondataavailable=e=>{
    if(e.data?.size&&ws.readyState===WebSocket.OPEN)ws.send(e.data);
  };
  recorder.onerror=e=>console.warn("Local studio MediaRecorder:",e);
  ws.onclose=()=>{if(localState.output===out){try{recorder.stop()}catch{}cancelAnimationFrame(out.raf);try{audioCtx.close()}catch{}localState.output=null;refreshPanelState()}};
  ws.onerror=()=>toastLocal("Local studio output connection failed.");
  return out;
}

async function takeLocalSource(id){
  const source=localState.inputs.get(id);if(!source)return;
  localState.previewId=id;replaceExistingPreviewWithLocal(source);
  const from=getExistingProgramVideo()||activeProgramSource()?.tileVideo||null;
  try{
    if(!localState.output){
      await startLocalOutput(source,from);
      await new Promise(r=>setTimeout(r,450));
      await apiLocal("/api/mcr/program",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({streamId:localState.output.streamId})});
    }else{
      const out=localState.output;
      out.fallbackProgram=null;
      out.transition=from&&from!==source.tileVideo?{from,to:source.tileVideo,toId:id,start:performance.now(),duration:TRANSITION_MS}:{from:null,to:source.tileVideo,toId:id,start:performance.now(),duration:1};
      localState.programId=id;
      setAudioProgram(id);
    }
    const t=document.getElementById("localTbar");if(t)t.value=0;
    updateLocalTileStates();refreshPanelState();
    toastLocal(source.name+" is now going to PROGRAM");
  }catch(e){toastLocal(e.message||"Could not take local source to Program.")}
}

async function stopLocalOutput(){
  try{await apiLocal("/api/local-studio/stop",{method:"POST"}).catch(()=>{})}finally{
    const out=localState.output;
    if(out){
      try{out.ws.close()}catch{}
      try{out.recorder.stop()}catch{}
      try{out.audioCtx.close()}catch{}
      cancelAnimationFrame(out.raf);
    }
    localState.output=null;localState.programId="";
    const t=document.getElementById("localTbar");if(t)t.value=0;
    window.renderMcr?.();
    refreshPanelState();
    toastLocal("Local studio output stopped");
  }
}

function handleTbar(){
  const slider=document.getElementById("localTbar");if(!slider)return;
  const n=Number(slider.value||0);
  const label=document.getElementById("localTbarLabel");if(label)label.textContent=n>=96?"TAKE TO PROGRAM":"PREVIEW → PROGRAM • "+n+"%";
  if(n>=96){
    slider.value=100;
    const source=activePreviewSource();
    if(source)takeLocalSource(source.id);
    setTimeout(()=>{if(slider.isConnected)slider.value=0;const l=document.getElementById("localTbarLabel");if(l)l.textContent="PREVIEW → PROGRAM"},250);
  }
}

function refreshPanelState(){
  const stateEl=document.getElementById("localStudioOutputState");
  const textEl=document.getElementById("localStudioOutputText");
  const stopBtn=document.getElementById("stopLocalOutput");
  const t=document.getElementById("localTbar");
  if(!stateEl)return;
  const out=localState.output;
  stateEl.textContent=out&&out.ws?.readyState===WebSocket.OPEN?"LOCAL OUTPUT LIVE":"LOCAL OUTPUT STANDBY";
  textEl.textContent=out
    ? "FBI TV Studio Output is feeding the existing live engine. Select another local source and TAKE to switch."
    : localState.previewId
      ? "Preview is ready. Move the T-bar to PROGRAM or press TAKE."
      : "Choose a local input, set it to Preview, then TAKE it to Program.";
  if(stopBtn)stopBtn.disabled=!out;
  if(t)t.disabled=!localState.previewId;
  updateLocalTileStates();
}

function boot(){
  injectStyles();
  const root=document.getElementById("mcrRoot");if(!root)return;
  const observer=new MutationObserver(()=>ensurePanel());
  observer.observe(root,{childList:true,subtree:true});
  localState.observer=observer;
  ensurePanel();
  clearInterval(localState.uiTimer);
  localState.uiTimer=setInterval(()=>{ensurePanel();refreshPanelState()},1000);
  window.addEventListener("beforeunload",()=>{try{navigator.sendBeacon?.("/api/local-studio/stop","")}catch{}});
}

if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
})();
