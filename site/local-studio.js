(function(){
  "use strict";

  const S={
    inputs:new Map(),
    previewId:"",
    output:null,
    drawer:null,
    channelId:"",
    observer:null
  };

  function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
  function toast(msg){
    const old=document.getElementById("localStudioToast");if(old)old.remove();
    const t=document.createElement("div");t.id="localStudioToast";t.textContent=msg;
    t.style.cssText="position:fixed;right:18px;bottom:18px;z-index:9999;background:#17171a;color:#f4f4f7;border:1px solid #34343b;border-radius:9px;padding:10px 13px;font:800 9px Inter,system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.65)";
    document.body.appendChild(t);setTimeout(()=>t.remove(),2200);
  }

  function injectStyles(){
    if(document.getElementById("localStudioStyles"))return;
    const s=document.createElement("style");s.id="localStudioStyles";
    s.textContent=`
#localStudioOpen{display:inline-flex}
.local-drawer{position:fixed;inset:auto 18px 18px 268px;z-index:5000;background:#0d0d0f;border:1px solid #34343b;border-radius:14px;box-shadow:0 30px 100px rgba(0,0,0,.72);overflow:hidden;display:none}
.local-drawer.open{display:block}
.local-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 13px;border-bottom:1px solid #29292f;background:#111113}
.local-drawer-title b{display:block;font-size:10px}.local-drawer-title span{display:block;margin-top:3px;color:#787881;font-size:7px}
.local-drawer-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.local-drawer-actions button,.local-source button{border:1px solid #303037;background:#18181b;color:#ececf0;border-radius:7px;padding:7px 9px;font-size:7px;font-weight:850;cursor:pointer}.local-drawer-actions .gold{background:#e7c44f;color:#13130f;border-color:#e7c44f}.local-drawer-actions .danger{color:#ffb1b1;border-color:#6a2929;background:#321414}
.local-source-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px;padding:10px}
.local-source{min-width:0;border:1px solid #29292f;border-radius:9px;background:#101012;overflow:hidden}
.local-source.preview{border-color:#6aa8ff;box-shadow:0 0 0 1px rgba(106,168,255,.15)}.local-source.live{border-color:#e7c44f;box-shadow:0 0 0 1px rgba(231,196,79,.12)}
.local-source-video{display:block;width:100%;aspect-ratio:16/9;background:#000;object-fit:cover}
.local-source-body{padding:7px}.local-source-name{font-size:8px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.local-source-meta{margin-top:3px;color:#74747d;font-size:6px}.local-source-actions{display:grid;grid-template-columns:1fr 1fr 28px;gap:4px;margin-top:6px}.local-source-actions button.active{border-color:#d2b23f;background:#28230f;color:#e7c44f}
.local-no-inputs{padding:18px;text-align:center;color:#777780;font-size:8px;grid-column:1/-1}
.local-tbar-wrap{display:grid;grid-template-columns:minmax(180px,1fr) 2.4fr auto;gap:10px;align-items:center;padding:10px;border-top:1px solid #29292f;background:#0a0a0c}
.local-output-state b{display:block;font-size:8px}.local-output-state span{display:block;margin-top:3px;color:#71717a;font-size:6px;line-height:1.4}
.local-tbar{width:100%;accent-color:#e7c44f}.local-tbar-label{display:flex;justify-content:space-between;color:#73737c;font-size:6px}.local-tbar-label b{color:#ddd}
.local-program-note{padding:0 10px 9px;color:#5f5f67;font-size:6px}
@media(max-width:1000px){.local-drawer{left:18px;right:18px}.local-source-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.local-tbar-wrap{grid-template-columns:1fr}}
@media(max-width:650px){.local-source-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
    document.head.appendChild(s);
  }

  function currentChannelId(){
    const active=document.querySelector("#channels .channel.active");
    return active?.dataset.id||"";
  }

  function openDrawer(){
    const d=S.drawer;if(!d){return}
    const id=currentChannelId();
    if(!id){toast("Select a live channel first.");return}
    S.channelId=id;d.classList.add("open");renderSources();refreshDrawer();
  }
  function closeDrawer(){S.drawer?.classList.remove("open")}

  function stopInput(src){
    if(!src)return;
    try{src.stream.getTracks().forEach(t=>t.stop())}catch{}
    if(src.videoEl){try{src.videoEl.srcObject=null}catch{}}
  }

  async function addCamera(){
    if(!navigator.mediaDevices?.getUserMedia)throw new Error("This browser does not support camera or capture-card input.");
    const permission=await navigator.mediaDevices.getUserMedia({video:true,audio:false});
    try{permission.getTracks().forEach(t=>t.stop())}catch{}
    const devices=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==="videoinput");
    if(!devices.length)throw new Error("No camera or capture-card input was found.");
    showDevicePicker(devices);
  }

  function showDevicePicker(devices){
    const modal=document.createElement("div");modal.className="channel-modal";modal.style.zIndex="6000";
    modal.innerHTML='<div class="channel-box"><div class="channel-head"><b>CAMERA / CAPTURE CARD INPUT</b><button class="channel-close" id="localPickerClose">×</button></div><div class="channel-body"><p class="channel-help">Choose the camera or USB capture device that should appear in the Local Studio source tray.</p><div id="localDeviceList"></div></div></div>';
    document.body.appendChild(modal);
    const list=modal.querySelector("#localDeviceList");
    devices.forEach((d,i)=>{
      const row=document.createElement("div");row.style.cssText="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px;border:1px solid #2a2a30;background:#111113;border-radius:8px;margin-bottom:6px";
      row.innerHTML='<div style="min-width:0"><b style="display:block;font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(d.label||("Video Device "+(i+1)))+'</b><span style="display:block;color:#73737c;font-size:6px;margin-top:3px">Browser video input</span></div><button class="btn primary" style="font-size:7px">USE</button>';
      row.querySelector("button").onclick=async()=>{modal.remove();await addDevice(d)};
      list.appendChild(row);
    });
    modal.querySelector("#localPickerClose").onclick=()=>modal.remove();modal.onclick=e=>{if(e.target===modal)modal.remove()};
  }

  async function addDevice(device){
    if(S.inputs.size>=8)throw new Error("Up to 8 local inputs can be added.");
    const stream=await navigator.mediaDevices.getUserMedia({
      video:{deviceId:{exact:device.deviceId},width:{ideal:1920,max:3840},height:{ideal:1080,max:2160},frameRate:{ideal:30,max:60}},
      audio:true
    });
    const source={id:"device-"+crypto.randomUUID(),name:device.label||("Camera / Capture "+(S.inputs.size+1)),kind:"DEVICE",detail:"Camera / USB capture input",stream};
    stream.getVideoTracks()[0].onended=()=>removeSource(source.id);
    S.inputs.set(source.id,source);renderSources();refreshDrawer();toast(source.name+" added");
  }

  async function addScreen(){
    if(!navigator.mediaDevices?.getDisplayMedia)throw new Error("This browser does not support screen/window capture.");
    try{
      const stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:30,max:60}},audio:true});
      const source={id:"screen-"+crypto.randomUUID(),name:"Screen / Window "+([...S.inputs.values()].filter(x=>x.kind==="SCREEN").length+1),kind:"SCREEN",detail:"Desktop, window or browser tab",stream};
      stream.getVideoTracks()[0].onended=()=>removeSource(source.id);
      S.inputs.set(source.id,source);renderSources();refreshDrawer();toast(source.name+" added");
    }catch(e){if(e?.name!=="NotAllowedError")toast(e.message||"Screen capture could not be started.")}
  }

  function removeSource(id){
    const src=S.inputs.get(id);if(!src)return;
    if(S.previewId===id){S.previewId="";resetLocalPreview();}
    stopInput(src);S.inputs.delete(id);renderSources();refreshDrawer();
  }

  function localPreviewElement(src){
    const view=document.querySelector("#studio .views .view:first-child");if(!view)return null;
    let video=document.getElementById("previewVideo");
    if(video){
      try{window.__studioHls?.destroy?.()}catch{}
      window.__studioHls=null;
      video.removeAttribute("src");video.load();video.srcObject=src.stream;video.autoplay=true;video.muted=true;video.playsInline=true;video.play().catch(()=>{});
      video.dataset.localPreview="1";return video;
    }
    view.querySelector(".placeholder")?.remove();
    video=document.createElement("video");video.id="previewVideo";video.className="frame";video.autoplay=true;video.muted=true;video.playsInline=true;video.srcObject=src.stream;
    view.appendChild(video);video.dataset.localPreview="1";return video;
  }

  function resetLocalPreview(){delete document.getElementById("previewVideo")?.dataset.localPreview;window.__studioHls=null}
  function selectPreview(id){
    const src=S.inputs.get(id);if(!src)return;
    S.previewId=id;localPreviewElement(src);renderSources();refreshDrawer();toast(src.name+" selected in PREVIEW");
  }

  function fit(ctx,video,alpha){
    if(!video||video.readyState<2||!video.videoWidth||!video.videoHeight)return false;
    const sw=video.videoWidth,sh=video.videoHeight,scale=Math.max(1920/sw,1080/sh),dw=sw*scale,dh=sh*scale;
    ctx.globalAlpha=alpha;ctx.drawImage(video,(1920-dw)/2,(1080-dh)/2,dw,dh);ctx.globalAlpha=1;return true;
  }

  function mime(){
    return ["video/webm;codecs=vp8,opus","video/webm;codecs=vp9,opus","video/webm;codecs=vp8","video/webm"].find(x=>MediaRecorder?.isTypeSupported?.(x))||"";
  }

  function connectAudio(out,src){
    if(!src?.stream?.getAudioTracks?.().length||out.audioNodes.has(src.id))return;
    try{
      const ms=new MediaStream(src.stream.getAudioTracks()),input=out.audioCtx.createMediaStreamSource(ms),gain=out.audioCtx.createGain();
      gain.gain.value=0;input.connect(gain);gain.connect(out.audioDest);out.audioNodes.set(src.id,{input,gain});
    }catch(e){console.warn("Local Studio audio input:",e)}
  }
  function selectAudio(out,id){
    out.audioNodes.forEach((node,sid)=>{const v=sid===id?1:0;try{node.gain.gain.setTargetAtTime(v,out.audioCtx.currentTime,.04)}catch{node.gain.gain.value=v}});
  }

  function frameLoop(){
    const out=S.output;if(!out)return;
    const ctx=out.ctx;ctx.fillStyle="#000";ctx.fillRect(0,0,1920,1080);
    const now=performance.now();
    if(out.transition){
      const p=Math.max(0,Math.min(1,(now-out.transition.start)/out.transition.ms));
      fit(ctx,out.transition.from,1-p);fit(ctx,out.transition.to,p);
      if(p>=1){out.transition=null;selectAudio(out,out.programId||"")}
    }else{
      const src=S.inputs.get(out.programId||"");
      if(src)fit(ctx,src.videoEl||src.previewEl,1);
      else if(out.fallback)fit(ctx,out.fallback,1);
    }
    out.raf=requestAnimationFrame(frameLoop);
  }

  async function startOutput(src){
    if(S.output)return S.output;
    if(!S.channelId)throw new Error("Select a live channel first.");
    const session=await fetch("/api/live/streams/"+encodeURIComponent(S.channelId)+"/local-studio/session",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin"});
    const data=await session.json();if(!session.ok)throw new Error(data.error||"Could not start local studio output.");
    const WS=window.WebSocket;if(!WS)throw new Error("WebSocket is not supported by this browser.");
    const ws=new WS(data.ws_url),canvas=document.createElement("canvas");canvas.width=1920;canvas.height=1080;
    const ctx=canvas.getContext("2d",{alpha:false});const videoStream=canvas.captureStream(30);
    const audioCtx=new (window.AudioContext||window.webkitAudioContext)(),audioDest=audioCtx.createMediaStreamDestination();
    const combined=new MediaStream([...videoStream.getVideoTracks(),...audioDest.stream.getAudioTracks()]);
    const recMime=mime();if(!recMime)throw new Error("This browser cannot encode the local studio output.");
    const recorder=new MediaRecorder(combined,{mimeType:recMime,videoBitsPerSecond:4500000,audioBitsPerSecond:128000});
    const fallback=document.getElementById("programVideo");
    const out={ws,canvas,ctx,audioCtx,audioDest,audioNodes:new Map(),recorder,raf:0,programId:src.id,fallback: fallback&&fallback.readyState>=2?fallback:null,transition:null};
    S.inputs.forEach(x=>{x.previewEl=x.videoEl||null;connectAudio(out,x)});
    S.output=out;

    ws.onopen=()=>{
      try{audioCtx.resume()}catch{}
      recorder.start(750);
      out.transition=out.fallback?{from:out.fallback,to:src.videoEl||src.startVideo,start:performance.now(),ms:650}:null;
      if(!out.transition)selectAudio(out,src.id);
      frameLoop();
      refreshDrawer();
    };
    recorder.ondataavailable=e=>{if(e.data?.size&&ws.readyState===WS.OPEN)ws.send(e.data)};
    ws.onerror=()=>toast("Local Studio output connection failed.");
    ws.onclose=()=>{if(S.output===out){try{recorder.stop()}catch{}cancelAnimationFrame(out.raf);try{audioCtx.close()}catch{}S.output=null;refreshDrawer()}};
    return out;
  }

  async function take(id){
    const src=S.inputs.get(id);if(!src)return;
    const v=src.videoEl||document.createElement("video");v.autoplay=true;v.muted=true;v.playsInline=true;v.srcObject=src.stream;src.videoEl=v;try{await v.play()}catch{}
    S.previewId=id;localPreviewElement(src);
    try{
      if(!S.output)await startOutput(src);
      else{
        const out=S.output,current=S.inputs.get(out.programId||"");
        out.transition={from:current?.videoEl||document.getElementById("programVideo"),to:v,start:performance.now(),ms:650};
        out.programId=id;S.output.programId=id;selectAudio(out,id);
      }
      refreshDrawer();toast(src.name+" taken to PROGRAM");
    }catch(e){toast(e.message||"Could not take local input to Program")}
  }

  async function stopOutput(){
    const out=S.output;
    try{await fetch("/api/live/streams/"+encodeURIComponent(S.channelId)+"/local-studio/stop",{method:"POST",credentials:"same-origin"}).catch(()=>{})}catch{}
    if(out){
      try{out.ws.close()}catch{}try{out.recorder.stop()}catch{}try{out.audioCtx.close()}catch{}cancelAnimationFrame(out.raf)
    }
    S.output=null;refreshDrawer();toast("Local Studio output stopped");
  }

  function handleTbar(){
    const t=document.getElementById("localTbar");if(!t)return;
    const pct=Number(t.value||0),label=document.getElementById("localTbarValue");if(label)label.textContent=pct>=100?"TAKE TO PROGRAM":pct+"%";
    if(pct>=100){const src=S.inputs.get(S.previewId);if(src)take(src.id);setTimeout(()=>{if(t.isConnected)t.value=0;if(label)label.textContent="0%"},300)}
  }

  function renderSources(){
    const grid=document.getElementById("localSourceGrid");if(!grid)return;
    grid.innerHTML="";
    if(!S.inputs.size){grid.innerHTML='<div class="local-no-inputs">No local inputs yet. Add a camera, USB capture card, screen, or window.</div>';return}
    S.inputs.forEach(src=>{
      const card=document.createElement("div");card.className="local-source "+(src.id===S.previewId?"preview ":"")+(src.id===S.output?.programId?"live":"");
      const v=document.createElement("video");v.className="local-source-video";v.autoplay=true;v.muted=true;v.playsInline=true;v.srcObject=src.stream;src.videoEl=v;
      const body=document.createElement("div");body.className="local-source-body";
      body.innerHTML='<div class="local-source-name">'+esc(src.name)+'</div><div class="local-source-meta">'+esc(src.kind)+" • "+esc(src.detail)+"</div>";
      const actions=document.createElement("div");actions.className="local-source-actions";
      const p=document.createElement("button");p.textContent="PREVIEW";p.className=src.id===S.previewId?"active":"";
      const tk=document.createElement("button");tk.textContent="TAKE";tk.className=src.id===S.output?.programId?"active":"";
      const rm=document.createElement("button");rm.textContent="×";
      p.onclick=()=>selectPreview(src.id);tk.onclick=()=>take(src.id);rm.onclick=()=>removeSource(src.id);
      actions.append(p,tk,rm);body.appendChild(actions);card.append(v,body);grid.appendChild(card);
    });
    refreshDrawer();
  }

  function refreshDrawer(){
    const st=document.getElementById("localOutputState"),tx=document.getElementById("localOutputText"),stop=document.getElementById("localStop"),t=document.getElementById("localTbar");
    if(!st)return;
    const live=!!S.output;
    st.textContent=live?"LOCAL OUTPUT LIVE":"LOCAL OUTPUT STANDBY";
    tx.textContent=live?"Local Studio is feeding the selected FBI Live channel through the existing RTMP/HLS engine.":"Select a local source for Preview, then press TAKE or move the T-bar to 100%.";
    if(stop)stop.disabled=!live;if(t)t.disabled=!S.previewId;
    const c=currentChannelId();if(c&&S.channelId&&c!==S.channelId&&live)stopOutput();
  }

  function createDrawer(){
    if(document.getElementById("localStudioDrawer"))return;
    injectStyles();
    const d=document.createElement("div");d.id="localStudioDrawer";d.className="local-drawer";
    d.innerHTML='<div class="local-drawer-head"><div class="local-drawer-title"><b>LOCAL STUDIO INPUTS</b><span>Camera • USB Capture Card • Screen • Window • Browser Tab</span></div><div class="local-drawer-actions"><button class="gold" id="addLocalCamera">＋ CAMERA / CAPTURE</button><button id="addLocalScreen">＋ SCREEN / WINDOW</button><button class="danger" id="localStop" disabled>STOP LOCAL OUTPUT</button><button id="localClose">CLOSE</button></div></div><div id="localSourceGrid" class="local-source-grid"></div><div class="local-tbar-wrap"><div class="local-output-state"><b id="localOutputState">LOCAL OUTPUT STANDBY</b><span id="localOutputText">Select a local source for Preview, then press TAKE or move the T-bar to 100%.</span></div><div><input id="localTbar" class="local-tbar" type="range" min="0" max="100" value="0" step="1" disabled><div class="local-tbar-label"><span>PREVIEW</span><b id="localTbarValue">0%</b><span>PROGRAM</span></div></div><div><button class="btn primary" id="localTakeSelected" style="font-size:8px">TAKE PREVIEW TO PROGRAM</button></div></div><div class="local-program-note">The existing streaming engine is not replaced. Local Studio encodes the selected source in the browser and publishes it into the same channel input path already used by OBS/vMix.</div>';
    document.body.appendChild(d);S.drawer=d;
    d.querySelector("#addLocalCamera").onclick=()=>addCamera().catch(e=>toast(e.message||"Could not open video devices"));
    d.querySelector("#addLocalScreen").onclick=()=>addScreen().catch(e=>toast(e.message||"Could not start screen capture"));
    d.querySelector("#localStop").onclick=stopOutput;d.querySelector("#localClose").onclick=closeDrawer;
    d.querySelector("#localTbar").oninput=handleTbar;d.querySelector("#localTakeSelected").onclick=()=>{const s=S.inputs.get(S.previewId);if(s)take(s.id)};
  }

  function addOpenButton(){
    const actions=document.querySelector(".top-actions");if(!actions||document.getElementById("localStudioOpen"))return;
    const btn=document.createElement("button");btn.className="btn";btn.id="localStudioOpen";btn.textContent="LOCAL STUDIO";btn.onclick=openDrawer;actions.insertBefore(btn,actions.firstChild);
  }

  function keepPreviewMounted(){
    const src=S.inputs.get(S.previewId);if(!src)return;
    const video=document.getElementById("previewVideo");
    if(video?.dataset?.localPreview==="1")return;
    localPreviewElement(src);
  }

  function boot(){
    createDrawer();addOpenButton();keepPreviewMounted();renderSources();refreshDrawer();
    const root=document.getElementById("studio");
    if(root){
      S.observer=new MutationObserver(()=>{addOpenButton();keepPreviewMounted();refreshDrawer()});
      S.observer.observe(root,{childList:true,subtree:true});
    }
    setInterval(()=>{addOpenButton();keepPreviewMounted();refreshDrawer()},1500);
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
})();
