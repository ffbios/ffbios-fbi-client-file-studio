(()=>{
"use strict";

const A={
  sources:new Map(),
  selectedSource:"",
  selectedChannel:"",
  programChannel:"",
  channelData:null,
  localProgram:"",
  bridge:null,
  mv:null,
  obs:null,
  timer:null
};

const svg=p=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+p+'</svg>';
const ICON={
  cam:svg('<rect x="3" y="7" width="13" height="10" rx="2"/><path d="m16 11 5-3v8l-5-3"/>'),
  screen:svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  audio:svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  ndi:svg('<circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>'),
  grid:svg('<rect x="3" y="4" width="8" height="7" rx="1"/><rect x="13" y="4" width="8" height="7" rx="1"/><rect x="3" y="13" width="8" height="7" rx="1"/><rect x="13" y="13" width="8" height="7" rx="1"/>'),
  capture:svg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h3v4H7zM14 10h3M14 14h3"/>'),
  meet:svg('<path d="M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4z"/><path d="m16 10 4-3v10l-4-3"/><path d="M8 12h4"/>'),
  zoom:svg('<rect x="3" y="4" width="18" height="16" rx="5"/><path d="M7 9h6a1 1 0 0 1 1 1v5H8a1 1 0 0 1-1-1z"/><path d="m14 11 3-2v6l-3-2"/>'),
  plus:svg('<path d="M12 5v14M5 12h14"/>'),
  min:svg('<path d="M6 12h12"/>'),max:svg('<path d="m6 15 6-6 6 6"/>'),close:svg('<path d="M6 6l12 12M18 6 6 18"/>')
};
const KIND={CHANNEL:"Channel",DEVICE:"Camera",CAPTURE:"Capture card",SCREEN:"Screen",MEET:"Google Meet",ZOOM:"Zoom",AUDIO:"Audio",NDI:"NDI"};
const isLocalVideo=s=>!!s&&["DEVICE","CAPTURE","SCREEN","MEET","ZOOM"].includes(s.kind);
const CAPTURE_RX=/capture|hdmi|sdi|elgato|cam ?link|game ?capture|hd60|4k ?x|avermedia|live gamer|blackmagic|decklink|ultrastudio|intensity|magewell|ezcap|mirabox|usb video|uvc|video capture|ms2109|macrosilicon|razer ripsaw|epiphan|atem/i;
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
const api=async(url,options={})=>{const r=await fetch(url,options);let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||"Request failed");return d};
const activeChannelId=()=>document.querySelector("#channels .channel.active")?.dataset.id||"";
const toast=msg=>{let t=document.getElementById("fbiLiveToast");if(!t){t=document.createElement("div");t.id="fbiLiveToast";document.body.appendChild(t)}t.textContent=msg;t.style.cssText="position:fixed;right:18px;top:18px;z-index:10000;background:#151518;color:#f4f4f6;border:1px solid #37373d;border-radius:9px;padding:10px 13px;font:600 13px Inter,system-ui,sans-serif;box-shadow:0 20px 70px rgba(0,0,0,.65)";clearTimeout(t._t);t._t=setTimeout(()=>t.remove(),2400)};

function injectStyle(){
  if(document.getElementById("fbiLiveAddonStyle"))return;
  const s=document.createElement("style");s.id="fbiLiveAddonStyle";
  s.textContent=`
.fbi-ls,.fbi-ls-modal,.fbi-addon-mv{--ls-bg:#0d1014;--ls-panel:#12161c;--ls-raise:#171c23;--ls-line:#232a33;--ls-line2:#2f3742;--ls-text:#eef0f4;--ls-muted:#8d95a2;--ls-gold:#e8c85a;--ls-pgm:#e8402f;--ls-pvw:#36d278;}
.fbi-ls{
  position:fixed;left:300px;right:14px;bottom:14px;z-index:5000;display:none;flex-direction:column;max-height:min(62vh,640px);background:var(--ls-bg);border:1px solid var(--ls-line2);border-radius:16px;box-shadow:0 -10px 60px rgba(0,0,0,.55),0 30px 90px rgba(0,0,0,.6);color:var(--ls-text);font:14px/1.4 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:visible;transform-origin:50% 100%}
.fbi-ls.open{display:flex;animation:fbiLsIn .28s cubic-bezier(.2,.8,.2,1)}
@keyframes fbiLsIn{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
.fbi-ls-head{display:flex;align-items:center;gap:16px;padding:14px 16px;border-radius:15px 15px 0 0;border-bottom:1px solid var(--ls-line);background:linear-gradient(180deg,#141920,#10141a)}
.fbi-ls-title{display:flex;align-items:center;gap:12px;flex:1;min-width:0}
.fbi-ls-title>div{min-width:0}
.fbi-ls-pill{flex:none}
.fbi-ls-title h2{margin:0;font-size:16px;font-weight:750;letter-spacing:-.01em}
.fbi-ls-title p{margin:2px 0 0;font-size:12.5px;color:var(--ls-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fbi-ls-pill{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 12px;border-radius:999px;border:1px solid var(--ls-line2);background:#0b0e12;font-size:12.5px;font-weight:650;white-space:nowrap}
.fbi-ls-pill i{width:9px;height:9px;border-radius:50%;background:#59616d}
.fbi-ls-pill.ready i{background:var(--ls-pvw);box-shadow:0 0 10px rgba(54,210,120,.7)}
.fbi-ls-pill.onair{border-color:rgba(232,64,47,.55);background:rgba(232,64,47,.12)}.fbi-ls-pill.onair i{background:var(--ls-pgm);box-shadow:0 0 12px rgba(232,64,47,.85);animation:fbiLsPulse 1.6s ease-in-out infinite}
@keyframes fbiLsPulse{50%{opacity:.4}}
.fbi-ls-add{display:flex;align-items:center;border:1px solid var(--ls-line2);border-radius:11px;overflow:hidden;background:var(--ls-panel)}
.fbi-ls-add span{padding:0 12px;font-size:12px;color:var(--ls-muted);border-right:1px solid var(--ls-line)}
.fbi-ls-add button{display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 11px;border:0;border-right:1px solid var(--ls-line);background:none;color:var(--ls-text);font-weight:600;font-size:13px;font-family:inherit;cursor:pointer}
.fbi-ls-add button:last-child{border-right:0}.fbi-ls-add button:hover{background:var(--ls-raise)}
.fbi-ls-add svg,.fbi-ls-btn svg{width:16px;height:16px;flex:none}
.fbi-ls-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:36px;padding:0 13px;border:1px solid var(--ls-line2);border-radius:10px;background:var(--ls-panel);color:var(--ls-text);font-weight:600;font-size:13px;font-family:inherit;cursor:pointer;white-space:nowrap}
.fbi-ls-btn:hover{background:var(--ls-raise)}.fbi-ls-btn:disabled{opacity:.4;cursor:not-allowed}
.fbi-ls-btn.icon{width:36px;padding:0}
.fbi-ls-btn.danger{border-color:rgba(232,64,47,.45);color:#ffb3aa;background:rgba(232,64,47,.08)}.fbi-ls-btn.danger:hover:not(:disabled){background:rgba(232,64,47,.18)}
.fbi-ls-btn.take{height:52px;padding:0 26px;border:0;border-radius:12px;background:var(--ls-pgm);color:#fff;font-size:15px;font-weight:750;letter-spacing:.02em;box-shadow:0 8px 24px rgba(232,64,47,.3)}
.fbi-ls-btn.take:hover:not(:disabled){filter:brightness(1.08);background:var(--ls-pgm)}
.fbi-ls-btn:focus-visible,.fbi-ls-add button:focus-visible,.fbi-ls-src button:focus-visible,.fbi-ls-range:focus-visible{outline:2px solid var(--ls-gold);outline-offset:2px}
.fbi-ls-bus{flex:1;min-height:0;overflow:auto;padding:14px 16px;scrollbar-width:thin;scrollbar-color:#2a303b transparent}
.fbi-ls-bus-label{display:flex;justify-content:space-between;align-items:baseline;margin:0 2px 10px;font-size:12.5px;color:var(--ls-muted)}
.fbi-ls-bus-label kbd{font-weight:600;font-size:11px;font-family:inherit;padding:1px 6px;border:1px solid var(--ls-line2);border-bottom-width:2px;border-radius:5px;color:var(--ls-text);background:var(--ls-panel)}
.fbi-ls-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
.fbi-ls-src{position:relative;border:2px solid var(--ls-line);border-radius:12px;background:var(--ls-panel);overflow:hidden;transition:border-color .15s,box-shadow .15s}
.fbi-ls-src:hover{border-color:var(--ls-line2)}
.fbi-ls-src.preview{border-color:var(--ls-pvw);box-shadow:0 0 0 3px rgba(54,210,120,.14)}
.fbi-ls-src.program{border-color:var(--ls-pgm);box-shadow:0 0 0 3px rgba(232,64,47,.16)}
.fbi-ls-vis{position:relative;aspect-ratio:16/9;background:#000;display:grid;place-items:center;overflow:hidden;cursor:pointer}
.fbi-ls-vis video,.fbi-ls-vis img{width:100%;height:100%;object-fit:cover;display:block}
.fbi-ls-num{position:absolute;top:8px;left:8px;min-width:24px;height:24px;padding:0 6px;display:grid;place-items:center;border-radius:6px;background:rgba(0,0,0,.72);border:1px solid rgba(255,255,255,.16);font-size:12px;font-weight:700}
.fbi-ls-tally{position:absolute;top:8px;right:8px;height:24px;padding:0 8px;display:none;align-items:center;border-radius:6px;font-size:11.5px;font-weight:750;letter-spacing:.04em;color:#fff}
.fbi-ls-src.preview .fbi-ls-tally{display:inline-flex;background:var(--ls-pvw);color:#062312}
.fbi-ls-src.program .fbi-ls-tally{display:inline-flex;background:var(--ls-pgm)}
.fbi-ls-kind{position:absolute;bottom:8px;left:8px;height:22px;padding:0 7px;display:inline-flex;align-items:center;border-radius:5px;background:rgba(0,0,0,.7);font-size:11px;color:#d5d9df}
.fbi-ls-audio{display:grid;place-items:center;gap:8px;color:var(--ls-gold);font-size:13px;font-weight:650}
.fbi-ls-audio svg{width:30px;height:30px}
.fbi-ls-body{display:grid;gap:9px;padding:10px 12px 12px}
.fbi-ls-name{flex:1;min-width:0}
.fbi-ls-name b{display:block;font-size:13.5px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fbi-ls-name span{display:block;margin-top:1px;font-size:12px;color:var(--ls-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fbi-ls-src .fbi-ls-acts{display:grid;grid-template-columns:1fr 1fr 32px;gap:6px}
.fbi-ls-src .fbi-ls-acts button{height:32px;padding:0 11px;border-radius:8px;border:1px solid var(--ls-line2);background:var(--ls-raise);color:var(--ls-text);font-weight:650;font-size:12.5px;font-family:inherit;cursor:pointer}
.fbi-ls-src .fbi-ls-acts button[data-act=take]{background:rgba(232,64,47,.14);border-color:rgba(232,64,47,.5);color:#ffc2bb}
.fbi-ls-src .fbi-ls-acts button[data-act=take]:hover:not(:disabled){background:var(--ls-pgm);color:#fff}
.fbi-ls-src .fbi-ls-acts button[data-act=remove]{width:32px;padding:0;color:var(--ls-muted)}
.fbi-ls-src .fbi-ls-acts button:disabled{opacity:.35;cursor:not-allowed}
.fbi-ls-ghost{display:grid;place-items:center;gap:6px;min-height:100%;aspect-ratio:auto;border:2px dashed var(--ls-line2);border-radius:12px;color:var(--ls-muted);font-size:13px;text-align:center;padding:18px;cursor:pointer;background:none;font-family:inherit}
.fbi-ls-ghost:hover{border-color:var(--ls-gold);color:var(--ls-text)}
.fbi-ls-ghost b{display:block;font-size:14px;color:var(--ls-text)}
.fbi-ls-foot{border-radius:0 0 15px 15px;display:grid;grid-template-columns:minmax(200px,1fr) minmax(260px,2.2fr) auto;gap:20px;align-items:center;padding:14px 16px;border-top:1px solid var(--ls-line);background:#0a0d11}
.fbi-ls-status b{display:block;font-size:14px;font-weight:700}
.fbi-ls-status span{display:block;margin-top:3px;font-size:12.5px;color:var(--ls-muted);line-height:1.45}
.fbi-ls-tbar{display:grid;gap:6px}
.fbi-ls-range{-webkit-appearance:none;appearance:none;width:100%;height:12px;border-radius:999px;background:linear-gradient(90deg,var(--ls-pvw) 0%,#2a313b 0%);outline:none;cursor:pointer}
.fbi-ls-range:disabled{opacity:.45;cursor:not-allowed}
.fbi-ls-range::-webkit-slider-thumb{-webkit-appearance:none;width:30px;height:30px;border-radius:8px;background:#dfe3e8;border:3px solid #0a0d11;box-shadow:0 2px 10px rgba(0,0,0,.6)}
.fbi-ls-range::-moz-range-thumb{width:26px;height:26px;border-radius:8px;background:#dfe3e8;border:3px solid #0a0d11}
.fbi-ls-range-label{display:flex;justify-content:space-between;font-size:12px;color:var(--ls-muted)}
.fbi-ls-range-label b{color:var(--ls-text);font-variant-numeric:tabular-nums}
.fbi-ls.min .fbi-ls-foot{border-radius:0 0 15px 15px}.fbi-ls.min .fbi-ls-bus,.fbi-ls.min .fbi-ls-addwrap{display:none}
.fbi-ls-pick{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;border:1px solid #29303a;border-radius:10px;margin-bottom:8px;background:#11151b}
.fbi-ls-pick b{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fbi-ls-pick button{height:34px;padding:0 14px;border:0;border-radius:8px;background:#e8c85a;color:#1a1606;font:700 13px Inter,system-ui,sans-serif;cursor:pointer}
.fbi-addon-mv{position:fixed;inset:0;z-index:8000;background:rgba(5,7,10,.86);display:none;padding:22px}.fbi-addon-mv.open{display:grid;place-items:center}
.fbi-addon-mv-card{width:min(1320px,100%);max-height:calc(100vh - 44px);overflow:auto;background:#0d1014;border:1px solid #2f3742;border-radius:16px;box-shadow:0 35px 120px rgba(0,0,0,.8);color:#eef0f4;font:14px/1.4 Inter,system-ui,sans-serif}
.fbi-addon-mv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;padding:16px}
.fbi-addon-mv-card-item{border:2px solid #232a33;border-radius:12px;overflow:hidden;background:#12161c}
.fbi-addon-mv-visual{aspect-ratio:16/9;background:#000;display:grid;place-items:center;position:relative;overflow:hidden}
.fbi-addon-mv-visual video,.fbi-addon-mv-visual img{width:100%;height:100%;object-fit:cover}
.fbi-addon-mv-body{padding:10px 12px}.fbi-addon-mv-body b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fbi-addon-mv-body span{display:block;margin-top:2px;font-size:12px;color:#8d95a2}
.fbi-addon-mv-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.fbi-addon-mv-actions button{height:34px;border:1px solid #2f3742;background:#171c23;color:#eef0f4;border-radius:8px;font:650 13px Inter,system-ui,sans-serif;cursor:pointer}
.fbi-addon-mv-actions button.primary{background:#e8402f;border-color:#e8402f;color:#fff}
#fbiLocalOpen.is-open{border-color:#e8c85a;color:#e8c85a}
.fbi-ls-btn.gold{background:var(--ls-gold);border-color:var(--ls-gold);color:#1a1606}.fbi-ls-btn.gold:hover{background:#f0d36b}
.fbi-ls-addwrap{position:relative}
.fbi-ls-menu{position:absolute;right:0;top:calc(100% + 10px);z-index:6000;width:320px;padding:6px;border:1px solid var(--ls-line2);border-radius:14px;background:#12161c;box-shadow:0 24px 70px rgba(0,0,0,.7)}
.fbi-ls-menu[hidden]{display:none}
.fbi-ls-menu button{display:flex;align-items:center;gap:12px;width:100%;padding:9px 10px;border:0;border-radius:10px;background:none;color:var(--ls-text);text-align:left;font-family:inherit;cursor:pointer}
.fbi-ls-menu button:hover,.fbi-ls-menu button:focus-visible{background:var(--ls-raise);outline:none}
.fbi-ls-mi{display:grid;place-items:center;width:34px;height:34px;flex:none;border-radius:9px;background:#0b0e12;border:1px solid var(--ls-line);color:var(--ls-gold)}
.fbi-ls-mi svg{width:18px;height:18px}
.fbi-ls-menu b{display:block;font-size:13.5px;font-weight:650}.fbi-ls-menu small{display:block;font-size:12px;color:var(--ls-muted)}
.fbi-ls-modal{max-width:560px}
.fbi-ls-pick-main{display:grid;gap:6px;min-width:0;flex:1}
.fbi-ls-pick-main label{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#8d95a2}
.fbi-ls-pick-main select{flex:1;min-width:0;height:32px;border-radius:8px;border:1px solid #2f3742;background:#0b0e12;color:#eef0f4;padding:0 8px;font:13px Inter,system-ui,sans-serif}
.fbi-ls-chip{justify-self:start;padding:2px 8px;border-radius:999px;background:rgba(232,200,90,.14);color:#e8c85a;font-size:11.5px;font-weight:650}
.fbi-ls-steps{margin:0 0 16px;padding-left:20px;display:grid;gap:8px;color:#c9ced6;font-size:13.5px;line-height:1.5}
.fbi-ls-steps b{color:#eef0f4}
.fbi-ls-modal-acts{display:flex;flex-wrap:wrap;gap:8px}
.fbi-ls-modal-acts .fbi-ls-btn.take{height:42px;font-size:14px;background:#e8c85a;color:#1a1606;box-shadow:none}
.fbi-ls-modal-acts .fbi-ls-btn{height:42px;font-size:13.5px}
.fbi-ls-note{margin:14px 0 0;font-size:12.5px;color:#8d95a2;line-height:1.5}
@media(max-width:1500px){.fbi-ls-title p{display:none}}@media(max-width:1280px){.fbi-ls-add>span{display:none}.fbi-ls-btn .t{display:none}}
@media(max-width:1000px){.fbi-ls{left:12px;right:12px;bottom:12px}.fbi-ls-head{flex-wrap:wrap}.fbi-ls-foot{grid-template-columns:1fr}.fbi-ls-btn.take{width:100%}}
@media(max-width:620px){.fbi-ls-add button .t{display:none}.fbi-ls-grid{grid-template-columns:1fr 1fr}.fbi-ls-src .fbi-ls-acts button[data-act=preview]{display:none}}
@media (prefers-reduced-motion:reduce){.fbi-ls.open,.fbi-ls-pill.onair i{animation:none}}
`;
  document.head.appendChild(s);
}

async function channel(id){return api("/api/live/streams/"+encodeURIComponent(id),{cache:"no-store"}).then(x=>x.stream)}
function hlsUrl(s){const token=s?.viewer_url?String(s.viewer_url).split("/watch/").pop().split(/[?#]/)[0]:"";return token?"/api/public/stream/"+encodeURIComponent(token)+"/hls/index.m3u8":""}
function inputHlsUrl(s){const u=hlsUrl(s);return u?(u+(u.includes("?")?"&":"?")+"source=input"):""}
function destroyHls(v){
  if(!v)return;
  try{v.__fbiHls?.destroy?.()}catch{}
  v.__fbiHls=null;
}
function setHls(v,url){
  if(!v||!url)return;
  if(v.__fbiHlsUrl===url)return;
  destroyHls(v);v.srcObject=null;v.removeAttribute("src");v.load();
  if(window.Hls&&window.Hls.isSupported()){
    const h=new Hls({enableWorker:true,lowLatencyMode:false,liveSyncDurationCount:3,liveMaxLatencyDurationCount:8,maxBufferLength:20,maxMaxBufferLength:45,backBufferLength:30,capLevelToPlayerSize:true,startLevel:-1,xhrSetup:x=>{x.withCredentials=true}});
    h.loadSource(url);h.attachMedia(v);h.on(Hls.Events.MANIFEST_PARSED,()=>v.play().catch(()=>{}));h.on(Hls.Events.ERROR,(e,d)=>{if(d?.fatal){try{h.destroy()}catch{}v.__fbiHls=null;setTimeout(()=>setHls(v,url),1200)}});
    v.__fbiHls=h;
  }else{v.src=url;v.load();v.play().catch(()=>{})}
  v.__fbiHlsUrl=url;
}
function selectedPreviewVideo(){
  const v=document.getElementById("previewVideo");return v||null
}
function programVideo(){
  return document.getElementById("programVideo")||null
}

function makeProgramStream(){
  const canvas=document.createElement("canvas");canvas.width=1920;canvas.height=1080;
  const ctx=canvas.getContext("2d",{alpha:false});const videoStream=canvas.captureStream(30);
  const AudioContext=window.AudioContext||window.webkitAudioContext;
  if(!AudioContext)throw new Error("Web Audio is not supported.");
  const audio=new AudioContext(),dest=audio.createMediaStreamDestination();
  const finalStream=new MediaStream([...videoStream.getVideoTracks(),...dest.stream.getAudioTracks()]);
  const types=["video/webm;codecs=vp8,opus","video/webm;codecs=vp9,opus","video/webm;codecs=vp8","video/webm"];
  const mime=types.find(t=>MediaRecorder.isTypeSupported?.(t))||"";
  if(!mime)throw new Error("This browser cannot encode the Local Studio output.");
  const recorder=new MediaRecorder(finalStream,{mimeType:mime,videoBitsPerSecond:4500000,audioBitsPerSecond:128000});
  return {canvas,ctx,videoStream,audio,dest,nodes:new Map(),channelAudioNode:null,recorder,raf:0,sendChain:Promise.resolve(),transition:null};
}

function drawSource(ctx,src){
  if(!src)return false;
  if(src.kind==="NDI"){
    const img=src.image;
    if(!img||!img.complete||!img.naturalWidth)return false;
    const w=img.naturalWidth,h=img.naturalHeight;
    const scale=Math.max(1920/w,1080/h),dw=w*scale,dh=h*scale;
    ctx.drawImage(img,(1920-dw)/2,(1080-dh)/2,dw,dh);
    return true;
  }
  const v=src.video;
  if(!v||v.readyState<2||!v.videoWidth||!v.videoHeight)return false;
  const scale=Math.max(1920/v.videoWidth,1080/v.videoHeight),dw=v.videoWidth*scale,dh=v.videoHeight*scale;
  ctx.drawImage(v,(1920-dw)/2,(1080-dh)/2,dw,dh);
  return true;
}

function draw(out){
  if(!out)return;
  const ctx=out.ctx;ctx.fillStyle="#000";ctx.fillRect(0,0,1920,1080);
  const tr=out.transition;
  if(tr){
    const p=Math.max(0,Math.min(1,(performance.now()-tr.started)/tr.duration));
    const from=A.sources.get(tr.fromId),to=A.sources.get(tr.toId);
    if(from) {ctx.save();ctx.globalAlpha=1-p;drawSource(ctx,from);ctx.restore()}
    if(to) {ctx.save();ctx.globalAlpha=p;drawSource(ctx,to);ctx.restore()}
    if(p>=1)out.transition=null;
  }else{
    const src=A.sources.get(A.localProgram)||A.sources.get("channel");
    if(src?.kind!=="AUDIO")drawSource(ctx,src);
  }
  out.raf=requestAnimationFrame(()=>draw(out));
}

function ensureChannelSource(s){
  if(!s)return;
  let v=document.getElementById("fbiLocalChannelFeed");
  if(!v){
    v=document.createElement("video");
    v.id="fbiLocalChannelFeed";
    v.playsInline=true;v.autoplay=true;v.controls=false;
    v.style.cssText="position:fixed;left:-10000px;top:-10000px;width:2px;height:2px;opacity:0;pointer-events:none";
    document.body.appendChild(v);
  }
  v.volume=0;v.muted=false;
  setHls(v,inputHlsUrl(s));
  const prev=A.sources.get("channel");
  if(prev){prev.name=s.name||"Channel Feed";prev.video=v;prev.audioElement=v;const nb=prev.card?.querySelector(".fbi-ls-name b");if(nb)nb.textContent=prev.name;return}
  A.sources.set("channel",{id:"channel",name:s.name||"Channel Feed",kind:"CHANNEL",detail:"Your OBS or vMix feed",video:v,audioElement:v});
}

async function refreshChannelSource(){
  const id=activeChannelId();
  if(!id)return;
  try{
    const s=await channel(id);
    A.selectedChannel=id;A.programChannel=id;A.channelData=s;
    ensureChannelSource(s);
    const pv=selectedPreviewVideo();
    if(pv&&A.selectedSource==="channel"&&!A.bridge){destroyHls(pv);pv.srcObject=null;pv.removeAttribute("src");pv.load();setHls(pv,hlsUrl(s))}
  }catch{}
}

async function putChannelInProgram(openWatch=false){
  const id=activeChannelId();if(!id){toast("Select a channel first.");return}
  await refreshChannelSource();
  if(A.bridge)await stopGateway();
  A.programChannel=id;A.localProgram="";A.selectedSource="channel";
  const pv=selectedPreviewVideo();if(pv&&A.channelData){destroyHls(pv);pv.srcObject=null;pv.removeAttribute("src");pv.load();setHls(pv,inputHlsUrl(A.channelData))}
  restoreProgram();
  refresh();
  toast((A.channelData?.name||"Channel Feed")+" is back on PROGRAM");
  if(openWatch&&A.channelData?.viewer_url)window.open(A.channelData.viewer_url,"_blank","noopener");
}

function setProgramMonitor(out){
  const v=programVideo();if(!v||!out)return;
  destroyHls(v);v.srcObject=out.videoStream||null;v.removeAttribute("src");v.load();
  v.autoplay=true;v.muted=true;v.playsInline=true;v.style.display="block";v.dataset.fbiProgram="local";
  v.play().catch(()=>{});
}

function ensureAudio(out,src){
  if(!out||!src)return null;
  if(src.kind==="CHANNEL"&&src.audioElement&&out.channelAudioNode)return out.channelAudioNode;
  if(src.kind==="CHANNEL"&&src.audioElement){
    try{
      const input=out.audio.createMediaElementSource(src.audioElement);
      const gain=out.audio.createGain();gain.gain.value=0;input.connect(gain);gain.connect(out.dest);
      out.channelAudioNode={input,gain};return out.channelAudioNode;
    }catch{return null}
  }
  if(!src.stream?.getAudioTracks?.().length||out.nodes.has(src.id))return out.nodes.get(src.id)||null;
  try{
    const ms=new MediaStream(src.stream.getAudioTracks());
    const input=out.audio.createMediaStreamSource(ms);
    const gain=out.audio.createGain();gain.gain.value=0;input.connect(gain);gain.connect(out.dest);
    out.nodes.set(src.id,{input,gain});return out.nodes.get(src.id);
  }catch{return null}
}

function selectAudio(out,id){
  if(!out)return;
  const ch=ensureAudio(out,A.sources.get("channel"));
  if(ch)try{ch.gain.gain.setTargetAtTime(id==="channel"?1:0,out.audio.currentTime,.04)}catch{ch.gain.gain.value=id==="channel"?1:0}
  out.nodes.forEach((node,sid)=>{
    const v=sid===id?1:0;
    try{node.gain.gain.setTargetAtTime(v,out.audio.currentTime,.04)}catch{node.gain.gain.value=v}
  });
}

async function gatewayStart(){
  const id=activeChannelId();if(!id)throw new Error("Select a live channel first.");
  await refreshChannelSource();
  const s=A.channelData;
  if(!s?.rtmp_server||!s?.stream_key)throw new Error("This channel does not have RTMP encoder details.");

  try{await fetch("http://127.0.0.1:8765/status",{cache:"no-store"}).then(r=>r.json())}
  catch{throw new Error("The FBI NDI Gateway / Local Studio Encoder is not running on this production computer.")}

  const prep=await api("/api/live/streams/"+encodeURIComponent(id)+"/program/start",{method:"POST"});
  let out=null;
  try{
    out=makeProgramStream();
    const start=await fetch("http://127.0.0.1:8765/local/start",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({rtmp_url:prep.program_rtmp_url})
    });
    const d=await start.json().catch(()=>({}));
    if(!start.ok||d.error)throw new Error(d.error||"Local Studio Encoder could not start.");

    A.bridge={out,channelId:id,session:d.session,ready:false};

    out.recorder.ondataavailable=e=>{
      if(!e.data?.size||!A.bridge||A.bridge.session!==d.session)return;
      out.sendChain=out.sendChain.then(async()=>{
        if(!A.bridge||A.bridge.session!==d.session)return;
        const body=await e.data.arrayBuffer();
        const rr=await fetch("http://127.0.0.1:8765/local/chunk?session="+encodeURIComponent(d.session),{
          method:"POST",headers:{"Content-Type":"application/octet-stream"},body
        });
        if(!rr.ok)throw new Error("Local encoder rejected Program data");
      }).catch(err=>toast(err.message||"Local encoder input failed."));
    };

    await out.audio.resume().catch(()=>{});
    A.sources.forEach(src=>ensureAudio(out,src));
    out.recorder.start(500);
    A.localProgram=A.localProgram||"channel";
    draw(out);
    const deadline=Date.now()+12000;
    while(Date.now()<deadline){
      try{
        const st=await fetch("http://127.0.0.1:8765/local/status?session="+encodeURIComponent(d.session),{cache:"no-store"}).then(r=>r.json());
        if(st.running&&Number(st.bytes)>0){out.ready=true;break}
        if(st.error)throw new Error(st.error);
      }catch(e){
        if(e.message&&e.message!==""&&Date.now()+100>deadline)throw e;
      }
      await new Promise(r=>setTimeout(r,350));
    }
    if(!out.ready)throw new Error("Local Program encoder did not receive video data.");
    await api("/api/live/streams/"+encodeURIComponent(id)+"/program/activate",{method:"POST"});
    setProgramMonitor(out);
    return A.bridge;
  }catch(e){
    if(A.bridge){try{await fetch("http://127.0.0.1:8765/local/stop?session="+encodeURIComponent(A.bridge.session),{method:"POST"})}catch{}try{A.bridge.out.recorder.stop()}catch{}cancelAnimationFrame(A.bridge.out.raf);try{A.bridge.out.audio.close()}catch{}A.bridge=null}
    await api("/api/live/streams/"+encodeURIComponent(id)+"/program/stop",{method:"POST"}).catch(()=>{});
    throw e;
  }
}

async function localTake(src){
  const id=activeChannelId();if(!id){toast("Select a live channel first.");return}
  await refreshChannelSource();
  if(A.channelData?.status!=="live"){
    updateLocalUi();
    toast("TAKE requires the selected channel to be LIVE from OBS/vMix.");
    return;
  }
  A.selectedSource=src.id;
  if(src.kind==="CHANNEL"){await putChannelInProgram(false);return}
  try{
    const previous=A.localProgram||"channel";
    const bridge=A.bridge||await gatewayStart();
    await bridge.out.audio.resume().catch(()=>{});
    const node=ensureAudio(bridge.out,src);
    if(src.kind!=="AUDIO"&&previous!==src.id&&bridge.out){
      bridge.out.transition={fromId:previous,toId:src.id,started:performance.now(),duration:450};
      A.localProgram=src.id;
    }else if(src.kind!=="AUDIO"){
      A.localProgram=src.id;
    }
    if(src.kind==="AUDIO"){A.audioProgram=src.id;selectAudio(bridge.out,src.id);}
    else{selectAudio(bridge.out,node?src.id:"channel");}
    setProgramMonitor(bridge.out);
    renderLocalGridOnly();
    toast(src.name+(src.kind==="AUDIO"?" added to PROGRAM AUDIO":" is now PROGRAM / ON AIR"));
  }catch(e){toast(e.message||"Could not put local source on air.")}
}


async function stopGateway(){
  const b=A.bridge;
  if(!b){
    if(A.channelData)await api("/api/live/streams/"+encodeURIComponent(A.channelData.id)+"/program/stop",{method:"POST"}).catch(()=>{});
    restoreProgram();return;
  }
  const id=b.channelId;
  try{if(b.session)await fetch("http://127.0.0.1:8765/local/stop?session="+encodeURIComponent(b.session),{method:"POST"})}catch{}
  try{b.out.recorder.stop()}catch{}
  cancelAnimationFrame(b.out.raf);
  try{b.out.audio.close()}catch{}
  A.bridge=null;A.localProgram="";
  await api("/api/live/streams/"+encodeURIComponent(id)+"/program/stop",{method:"POST"}).catch(()=>{});
  restoreProgram();refresh();
}

function restoreProgram(){
  const v=programVideo();if(!v)return;
  v.style.display="block";v.dataset.fbiProgram="channel";
  try{v.srcObject=null}catch{}
  destroyHls(v);v.removeAttribute("src");v.load();
  const id=A.programChannel||activeChannelId();
  if(id)channel(id).then(s=>{A.channelData=s;ensureChannelSource(s);setHls(v,hlsUrl(s))}).catch(()=>{});
}

async function listMedia(){
  if(!navigator.mediaDevices?.enumerateDevices)return {video:[],audio:[]};
  let all=await navigator.mediaDevices.enumerateDevices().catch(()=>[]);
  if(all.some(d=>(d.kind==="videoinput"||d.kind==="audioinput")&&!d.label)){
    // Labels are hidden until the browser grants access once.
    let probe=null;
    try{probe=await navigator.mediaDevices.getUserMedia({video:true,audio:true})}
    catch{try{probe=await navigator.mediaDevices.getUserMedia({video:true,audio:false})}catch(e){throw new Error("Camera access was blocked. Allow camera access in the browser and try again.")}}
    probe.getTracks().forEach(t=>t.stop());
    all=await navigator.mediaDevices.enumerateDevices().catch(()=>[]);
  }
  return {video:all.filter(d=>d.kind==="videoinput"),audio:all.filter(d=>d.kind==="audioinput"&&d.deviceId!=="communications")};
}
function pairedAudio(v,audio){
  // Capture cards and webcams expose their sound as an audio input in the same device group.
  const same=audio.find(a=>a.groupId&&a.groupId===v.groupId&&a.deviceId!=="default");
  if(same)return same.deviceId;
  const word=String(v.label||"").toLowerCase().replace(/\(.*?\)/g,"").split(/[^a-z0-9]+/).filter(w=>w.length>2&&!/video|camera|usb|device/.test(w))[0];
  const byName=word&&audio.find(a=>String(a.label||"").toLowerCase().includes(word)&&a.deviceId!=="default");
  return byName?byName.deviceId:"";
}
async function addCamera(mode){
  const capture=mode==="capture";
  if(!navigator.mediaDevices?.getUserMedia)throw new Error("Camera capture needs Chrome or Edge on this computer.");
  const {video,audio}=await listMedia();
  if(!video.length)throw new Error(capture?"No capture card was found. Plug it in, then try again.":"No camera was found.");
  const sorted=capture?[...video].sort((x,y)=>(CAPTURE_RX.test(y.label)?1:0)-(CAPTURE_RX.test(x.label)?1:0)):video;
  const modal=document.createElement("div");modal.className="channel-modal";modal.style.zIndex="9000";
  modal.innerHTML='<div class="channel-box fbi-ls-modal"><div class="channel-head"><b>'+(capture?"Add a capture card":"Add a camera")+'</b><button class="channel-close" id="fbiCamClose" aria-label="Close">×</button></div><div class="channel-body"><p class="channel-help">'+
    (capture?"Pick your HDMI or SDI capture card. Its sound is paired automatically; change it if your audio comes in elsewhere.":"Pick a camera. Choose where its sound should come from, or leave it silent and add a microphone separately.")+
    '</p><div id="fbiCamList"></div></div></div>';
  document.body.appendChild(modal);
  const list=modal.querySelector("#fbiCamList");
  const audioOptions=(sel)=>'<option value="">No sound</option>'+audio.map(a=>'<option value="'+esc(a.deviceId)+'"'+(a.deviceId===sel?" selected":"")+'>'+esc(a.label||"Audio input")+'</option>').join("");
  sorted.forEach((d,i)=>{
    const looksCapture=CAPTURE_RX.test(d.label||"");
    const paired=pairedAudio(d,audio);
    const row=document.createElement("div");row.className="fbi-ls-pick";
    row.innerHTML='<div class="fbi-ls-pick-main"><b>'+esc(d.label||("Video device "+(i+1)))+'</b>'+(looksCapture?'<span class="fbi-ls-chip">Capture card</span>':'')+
      '<label>Sound<select>'+audioOptions(capture||paired?paired:"")+'</select></label></div><button type="button">Add</button>';
    const btn=row.querySelector("button"),sel=row.querySelector("select");
    btn.onclick=async()=>{
      btn.disabled=true;btn.textContent="Opening…";
      try{
        const v={deviceId:{exact:d.deviceId},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}};
        const a=sel.value?{deviceId:{exact:sel.value},echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:{ideal:2}}:false;
        let st;
        try{st=await navigator.mediaDevices.getUserMedia({video:v,audio:a})}
        catch(err){if(!a)throw err;st=await navigator.mediaDevices.getUserMedia({video:v,audio:false});toast("The selected sound input could not be opened, so this source is silent.")}
        const vid=document.createElement("video");
        vid.autoplay=true;vid.muted=true;vid.playsInline=true;vid.srcObject=st;await vid.play().catch(()=>{});
        const kind=capture||looksCapture?"CAPTURE":"DEVICE";
        const soundName=sel.value?(sel.options[sel.selectedIndex].text):"";
        const src={id:"device-"+crypto.randomUUID(),name:d.label?d.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i,""):((kind==="CAPTURE"?"Capture card ":"Camera ")+(i+1)),kind,detail:soundName?("Sound: "+soundName):"No sound",stream:st,video:vid};
        st.getVideoTracks()[0].onended=()=>removeSource(src.id);
        A.sources.set(src.id,src);A.selectedSource=src.id;if(A.bridge)ensureAudio(A.bridge.out,src);
        modal.remove();renderLocalGridOnly();selectPreview(src.id);toast(src.name+" added and ready in preview");
      }catch(e){
        btn.disabled=false;btn.textContent="Add";
        toast(e?.name==="NotAllowedError"?"Camera access was blocked.":e?.name==="NotReadableError"?"That device is in use by another app (close OBS, Zoom or Teams preview) and try again.":(e?.message||"Could not open the device."));
      }
    };
    list.appendChild(row);
  });
  modal.querySelector("#fbiCamClose").onclick=()=>modal.remove();
  modal.onclick=e=>{if(e.target===modal)modal.remove()};
}

async function captureDisplay(opts){
  if(!navigator.mediaDevices?.getDisplayMedia)throw new Error("Screen capture needs Chrome or Edge on this computer.");
  try{return await navigator.mediaDevices.getDisplayMedia(opts)}
  catch(e){
    if(e?.name==="NotAllowedError")throw new Error("Sharing was cancelled.");
    try{return await navigator.mediaDevices.getDisplayMedia({video:opts.video,audio:false})}catch(err){throw new Error(err?.message||"Could not capture that window.")}
  }
}
function addStreamSource(kind,name,detail,st){
  const id=kind.toLowerCase()+"-"+crypto.randomUUID(),src={id,name,kind,detail,stream:st,video:document.createElement("video")};
  src.video.autoplay=true;src.video.muted=true;src.video.playsInline=true;src.video.srcObject=st;src.video.play().catch(()=>{});
  st.getVideoTracks()[0].onended=()=>removeSource(id);
  A.sources.set(id,src);A.selectedSource=id;if(A.bridge)ensureAudio(A.bridge.out,src);
  renderLocalGridOnly();selectPreview(id);
  return src;
}
function countKind(k){return [...A.sources.values()].filter(x=>x.kind===k).length}
const VIDEO_HQ={frameRate:{ideal:30},width:{ideal:1920},height:{ideal:1080}};
const TAB_AUDIO={suppressLocalAudioPlayback:false,echoCancellation:false,noiseSuppression:false,autoGainControl:false};
function meetingModal(app){
  const meet=app==="MEET",label=meet?"Google Meet":"Zoom";
  const modal=document.createElement("div");modal.className="channel-modal";modal.style.zIndex="9000";
  const steps=meet
    ?'<ol class="fbi-ls-steps"><li>Join the call in another Chrome or Edge tab. Use a separate Google account for the studio so your own camera isn’t in the shot.</li><li>In Meet, pin the speaker you want and hide self view.</li><li>Click <b>Choose the Meet tab</b>, select the Meet tab and turn on <b>Also share tab audio</b>.</li></ol>'
    :'<ol class="fbi-ls-steps"><li>Join the meeting, set <b>Speaker view</b> or <b>Gallery view</b>, and turn on <b>Hide self view</b>.</li><li>Zoom in a browser tab: pick the tab and turn on <b>Also share tab audio</b>.</li><li>Zoom desktop app: pick the Zoom window for picture. Browsers can’t take sound from a single app, so for sound choose <b>Whole screen with sound</b> and turn on <b>Share system audio</b>.</li></ol>';
  const buttons=meet
    ?'<button type="button" class="fbi-ls-btn take" data-mode="tab">Choose the Meet tab</button>'
    :'<button type="button" class="fbi-ls-btn take" data-mode="tab">Zoom in a browser tab</button><button type="button" class="fbi-ls-btn" data-mode="window">Zoom desktop window</button><button type="button" class="fbi-ls-btn" data-mode="monitor">Whole screen with sound</button>';
  modal.innerHTML='<div class="channel-box fbi-ls-modal"><div class="channel-head"><b>Add '+label+'</b><button class="channel-close" aria-label="Close">×</button></div><div class="channel-body">'+steps+'<div class="fbi-ls-modal-acts">'+buttons+'</div><p class="fbi-ls-note">For Zoom, NDI output (Zoom Rooms and some Zoom plans) gives the cleanest picture: send it through the NDI Gateway and add it with <b>NDI</b>.</p></div></div>';
  if(meet)modal.querySelector(".fbi-ls-note").remove();
  document.body.appendChild(modal);
  const close=()=>modal.remove();
  modal.querySelector(".channel-close").onclick=close;modal.onclick=e=>{if(e.target===modal)close()};
  modal.querySelectorAll("[data-mode]").forEach(b=>b.onclick=async()=>{
    const mode=b.dataset.mode;
    const opts=mode==="tab"?{video:{...VIDEO_HQ,displaySurface:"browser"},audio:TAB_AUDIO,preferCurrentTab:false,selfBrowserSurface:"exclude",surfaceSwitching:"include",systemAudio:"exclude"}
      :mode==="window"?{video:{...VIDEO_HQ,displaySurface:"window"},audio:false,selfBrowserSurface:"exclude"}
      :{video:{...VIDEO_HQ,displaySurface:"monitor"},audio:TAB_AUDIO,systemAudio:"include",selfBrowserSurface:"exclude"};
    try{
      const st=await captureDisplay(opts);
      close();
      const hasSound=st.getAudioTracks().length>0;
      const n=countKind(app)+1;
      const src=addStreamSource(app,label+(n>1?" "+n:""),(mode==="tab"?"Browser tab":mode==="window"?"Desktop window":"Whole screen")+(hasSound?", with sound":", no sound"),st);
      if(!hasSound&&mode!=="window")toast("No sound was shared. Remove this source and choose again with “Share audio” turned on.");
      else toast(src.name+" added and ready in preview");
    }catch(e){toast(e.message||"Could not capture "+label)}
  });
}
async function addScreen(){
  if(!navigator.mediaDevices?.getDisplayMedia)throw new Error("Screen capture is not supported in this browser.");
  let st;
  try{st=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:30}},audio:true});}
  catch(e){
    if(e?.name==="NotAllowedError")throw new Error("Screen sharing was cancelled or blocked.");
    try{st=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:30}},audio:false});}
    catch(err){throw new Error(err?.message||"Could not capture the selected screen or window.");}
  }
  const id="screen-"+crypto.randomUUID(),src={id,name:"Screen "+(countKind("SCREEN")+1),kind:"SCREEN",detail:"Screen, window or tab",stream:st,video:document.createElement("video")};
  src.video.autoplay=true;src.video.muted=true;src.video.playsInline=true;src.video.srcObject=st;await src.video.play().catch(()=>{});
  st.getVideoTracks()[0].onended=()=>removeSource(id);
  A.sources.set(id,src);A.selectedSource=id;renderLocalGridOnly();selectPreview(id);toast(src.name+" added and ready in PREVIEW");
}

async function addAudio(){
  if(!navigator.mediaDevices?.getUserMedia)throw new Error("Audio capture is not supported in this browser.");
  try{
    const st=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    const id="audio-"+crypto.randomUUID(),src={id,name:"Audio Input "+([...A.sources.values()].filter(x=>x.kind==="AUDIO").length+1),kind:"AUDIO",detail:"Microphone or line in",stream:st};
    st.getAudioTracks()[0].onended=()=>removeSource(id);
    A.sources.set(id,src);A.selectedSource=id;if(A.bridge)ensureAudio(A.bridge.out,src);
    renderLocalGridOnly();toast(src.name+" added and ready in PREVIEW");
  }catch(e){throw new Error(e?.name==="NotAllowedError"?"Microphone/audio access was blocked.":(e?.message||"Could not open the audio input."));}
}

async function loadNdi(){
  try{const d=await fetch("http://127.0.0.1:8765/sources",{cache:"no-store"}).then(r=>r.json());const list=(d.sources||[]).map(String).filter(Boolean);if(!list.length)throw new Error("No NDI sources were discovered.");return list}catch{throw new Error("NDI Gateway is not available on this production computer.")}
}
async function addNdi(){
  const names=await loadNdi();const modal=document.createElement("div");modal.className="channel-modal";modal.style.zIndex="9000";
  modal.innerHTML='<div class="channel-box"><div class="channel-head"><b>Add an NDI source</b><button class="channel-close" id="fbiNdiClose">×</button></div><div class="channel-body"><p class="channel-help">NDI sources are discovered automatically on the local network.</p><div id="fbiNdiList"></div></div></div>';document.body.appendChild(modal);const list=modal.querySelector("#fbiNdiList");
  names.forEach(name=>{const row=document.createElement("div");row.className="fbi-ls-pick";row.innerHTML='<b>'+esc(name)+'</b><button type="button">Add</button>';row.querySelector("button").onclick=()=>{const id="ndi-"+crypto.randomUUID();const image=new Image();image.crossOrigin="anonymous";image.src="http://127.0.0.1:8765/preview?source_name="+encodeURIComponent(name)+"&t="+Date.now();A.sources.set(id,{id,name,kind:"NDI",detail:"NDI on your network",ndiName:name,image});modal.remove();refresh();toast(name+" added")};list.appendChild(row)});
  modal.querySelector("#fbiNdiClose").onclick=()=>modal.remove();modal.onclick=e=>{if(e.target===modal)modal.remove()};
}
function removeSource(id){
  const s=A.sources.get(id);if(!s)return;
  try{s.stream?.getTracks?.().forEach(t=>t.stop())}catch{}
  try{if(s.mvVideo)destroyHls(s.mvVideo)}catch{}
  try{s.card?.remove();s.mvCard?.remove()}catch{}
  if(A.bridge?.out?.nodes?.has(id)){const n=A.bridge.out.nodes.get(id);try{n.input.disconnect();n.gain.disconnect()}catch{}A.bridge.out.nodes.delete(id)}
  if(A.selectedSource===id)A.selectedSource="";
  if(A.localProgram===id){A.localProgram="";restoreProgram()}
  A.sources.delete(id);updateLocalUi();
}


function selectPreview(id){
  const s=A.sources.get(id);if(!s)return;
  A.selectedSource=id;
  const v=selectedPreviewVideo();
  if(v&&s.kind==="CHANNEL"){destroyHls(v);v.srcObject=null;v.removeAttribute("src");v.load();setHls(v,inputHlsUrl(A.channelData||{}));}
  else if(v&&isLocalVideo(s)){destroyHls(v);v.srcObject=s.stream;v.removeAttribute("src");v.load();v.play().catch(()=>{});}
  updateLocalUi();toast(s.name+" selected in PREVIEW");
}

function updateLocalUi(){
  const grid=document.getElementById("fbiLocalGrid");
  const channelLive=A.channelData?.status==="live";
  const selected=A.sources.get(A.selectedSource);
  if(grid)for(const card of grid.children){
    const id=card.dataset.sourceId||"";
    if(!card.dataset.sourceId)continue;
    const isPgm=A.bridge?id===A.localProgram:id==="channel"&&channelLive;
    card.className="fbi-ls-src "+(isPgm?"program":(id===A.selectedSource?"preview":""));
    const tl=card.querySelector(".fbi-ls-tally");if(tl)tl.textContent=isPgm?"PROGRAM":"PREVIEW";
    const t=card.querySelector("[data-act=take]");
    if(t){
      t.disabled=!channelLive;
      t.title=channelLive?"Take source to Program":"Start OBS/vMix and make the selected channel LIVE before TAKE";
    }
  }
  const stop=document.getElementById("fbiLocalStop");if(stop)stop.disabled=!A.bridge;
  const range=document.getElementById("fbiLocalTbar");if(range)range.disabled=!selected;
  const st=document.getElementById("fbiLocalState");if(st)st.textContent=A.bridge?"Local mix is on air":(channelLive?"Channel is live":"Channel offline");
  const pill=document.getElementById("fbiLocalPill");if(pill){pill.className="fbi-ls-pill "+(A.bridge?"onair":(channelLive?"ready":""));pill.querySelector("em").textContent=A.bridge?"On air":(channelLive?"Ready to take":"Channel offline")}
  const nm=document.getElementById("fbiLocalPvwName");if(nm)nm.textContent=selected?selected.name:"nothing selected";
  const tx=document.getElementById("fbiLocalText");
  if(tx)tx.textContent=A.bridge
    ?"A local source is on program. OBS or vMix keeps feeding the channel in the background."
    :(channelLive
      ?"Pick a source for preview, then take it to program."
      :"You can preview sources now. Go live from OBS or vMix to enable Take.");
  const master=document.getElementById("fbiTakeLocal");
  if(master)master.disabled=!channelLive||!selected;
}
function renderLocalGridOnly(){
  const grid=document.getElementById("fbiLocalGrid");if(!grid)return;
  const keep=new Set();
  for(const s of A.sources.values()){
    keep.add(s.id);
    let card=s.card;
    if(!card){
      card=document.createElement("div");card.dataset.sourceId=s.id;
      const visual=document.createElement("div");visual.className="fbi-ls-vis";visual.title="Click to preview";visual.onclick=()=>selectPreview(s.id);
      if(s.kind==="CHANNEL"||isLocalVideo(s)){
        const v=s.video||document.createElement("video");
        v.autoplay=true;v.muted=true;v.playsInline=true;v.style.cssText="width:100%;height:100%;display:block;object-fit:cover;background:#000";
        if(s.kind==="CHANNEL")setHls(v,inputHlsUrl(A.channelData||{}));else if(v.srcObject!==s.stream){v.srcObject=s.stream;v.play().catch(()=>{})}
        s.video=v;visual.appendChild(v);
      }else if(s.kind==="NDI"){
        const img=s.cardImage||new Image();img.crossOrigin="anonymous";img.style.cssText="width:100%;height:100%;object-fit:cover;display:block";
        if(!img.src)img.src="http://127.0.0.1:8765/preview?source_name="+encodeURIComponent(s.ndiName||s.name)+"&t="+Date.now();
        s.cardImage=img;visual.appendChild(img);
      }else visual.innerHTML='<div class="fbi-ls-audio">'+ICON.audio+'Audio input</div>';
      visual.insertAdjacentHTML("beforeend",'<span class="fbi-ls-num"></span><span class="fbi-ls-tally">PREVIEW</span><span class="fbi-ls-kind">'+esc(KIND[s.kind]||s.kind)+'</span>');
      const body=document.createElement("div");body.className="fbi-ls-body";
      const nameBox=document.createElement("div");nameBox.className="fbi-ls-name";
      const name=document.createElement("b");name.textContent=s.name;
      const meta=document.createElement("span");meta.className="fbi-addon-source-meta";meta.textContent=s.detail;
      nameBox.append(name,meta);
      const acts=document.createElement("div");acts.className="fbi-ls-acts";
      const p=document.createElement("button");p.type="button";p.textContent="Preview";p.dataset.act="preview";
      const t=document.createElement("button");t.type="button";t.textContent="Take";t.dataset.act="take";t.onclick=()=>localTake(s);
      const rm=document.createElement("button");rm.type="button";rm.dataset.act="remove";rm.innerHTML="&times;";rm.title="Remove source";rm.setAttribute("aria-label","Remove "+s.name);rm.onclick=()=>removeSource(s.id);
      if(s.id==="channel"){rm.disabled=true;rm.title="The channel feed can't be removed"}
      p.onclick=()=>selectPreview(s.id);acts.append(p,t,rm);body.append(nameBox,acts);card.append(visual,body);s.card=card;
    }else{
      const meta=card.querySelector(".fbi-addon-source-meta");if(meta)meta.textContent=s.detail;
      if(isLocalVideo(s)&&s.video&&s.video.srcObject!==s.stream){s.video.srcObject=s.stream;s.video.play().catch(()=>{})}
      if(s.kind==="CHANNEL"&&s.video)setHls(s.video,inputHlsUrl(A.channelData||{}));
    }
    grid.appendChild(card);
  }
  for(const card of [...grid.children])if(card.dataset.sourceId&&(!keep.has(card.dataset.sourceId)||A.sources.get(card.dataset.sourceId)?.card!==card))card.remove();
  [...grid.children].filter(c=>c.dataset.sourceId).forEach((c,i)=>{const n=c.querySelector(".fbi-ls-num");if(n)n.textContent=i<9?String(i+1):""});
  let ghost=document.getElementById("fbiLocalGhost");
  if(!ghost){ghost=document.createElement("button");ghost.type="button";ghost.id="fbiLocalGhost";ghost.className="fbi-ls-ghost";ghost.innerHTML='<span><b>Add a source</b>Camera, capture card, screen, Google Meet, Zoom, audio or NDI</span>';ghost.onclick=e=>{e.stopPropagation();A.openAddMenu&&A.openAddMenu()}}
  grid.appendChild(ghost);
  updateLocalUi();
}


async function takeNdi(s){return localTake(s)}

function setProgramNdi(s){const v=programVideo();if(!v)return;destroyHls(v);v.srcObject=null;v.removeAttribute("src");v.load();const img=document.createElement("img");img.style.cssText="width:100%;height:100%;object-fit:cover;display:block;background:#000";img.src="http://127.0.0.1:8765/preview?source_name="+encodeURIComponent(s.ndiName||s.name)+"&t="+Date.now();v.style.display="none";v.parentElement?.appendChild(img)}
function menuItem(id,icon,title,desc){return '<button type="button" role="menuitem" id="'+id+'"><span class="fbi-ls-mi">'+ICON[icon]+'</span><span><b>'+title+'</b><small>'+desc+'</small></span></button>'}
function build(){
  injectStyle();
  if(document.getElementById("fbiLocalDrawer"))return;
  const d=document.createElement("section");d.id="fbiLocalDrawer";d.className="fbi-ls";d.setAttribute("aria-label","Local Studio");
  d.innerHTML='<div class="fbi-ls-head">'+
    '<div class="fbi-ls-title"><div><h2>Local Studio</h2><p>Switch cameras, capture cards, calls, screens and audio from this computer</p></div><span class="fbi-ls-pill" id="fbiLocalPill"><i></i><em style="font-style:normal">Channel offline</em></span></div>'+
    '<div class="fbi-ls-addwrap"><button type="button" class="fbi-ls-btn gold" id="fbiAddMenuBtn" aria-haspopup="menu" aria-expanded="false">'+ICON.plus+'Add source</button>'+
      '<div class="fbi-ls-menu" id="fbiAddMenu" role="menu" hidden>'+
        menuItem("fbiAddCam","cam","Camera","Webcam or USB camera")+
        menuItem("fbiAddCapture","capture","Capture card","HDMI or SDI capture, with its sound")+
        menuItem("fbiAddScreen","screen","Screen or window","Slides, a browser tab or an app")+
        menuItem("fbiAddMeet","meet","Google Meet","A Meet call, picture and sound")+
        menuItem("fbiAddZoom","zoom","Zoom","A Zoom meeting, browser or desktop app")+
        menuItem("fbiAddAudio","audio","Audio input","Microphone, mixer or line in")+
        menuItem("fbiAddNdi","ndi","NDI","NDI sources on your network")+
      '</div></div>'+
    '<button type="button" class="fbi-ls-btn" id="fbiMulti">'+ICON.grid+'<span class="t">Multiview</span></button>'+
    '<button type="button" class="fbi-ls-btn danger" id="fbiLocalStop" disabled>Stop local output</button>'+
    '<button type="button" class="fbi-ls-btn icon" id="fbiLocalMin" title="Minimise" aria-label="Minimise Local Studio">'+ICON.min+'</button>'+
    '<button type="button" class="fbi-ls-btn icon" id="fbiLocalClose" title="Close" aria-label="Close Local Studio">'+ICON.close+'</button></div>'+
  '<div class="fbi-ls-bus"><div class="fbi-ls-bus-label"><span>Sources</span><span>Press <kbd>1</kbd>–<kbd>9</kbd> to preview, <kbd>Enter</kbd> to take</span></div><div id="fbiLocalGrid" class="fbi-ls-grid"></div></div>'+
  '<div class="fbi-ls-foot"><div class="fbi-ls-status"><b id="fbiLocalState">Channel offline</b><span id="fbiLocalText">Pick a source for preview, then take it to program.</span></div>'+
    '<div class="fbi-ls-tbar"><input id="fbiLocalTbar" class="fbi-ls-range" type="range" min="0" max="100" value="0" step="1" disabled aria-label="T-bar: drag to program"><div class="fbi-ls-range-label"><span>Preview: <span id="fbiLocalPvwName">nothing selected</span></span><b id="fbiLocalTbarValue">0%</b><span>Program</span></div></div>'+
    '<button type="button" class="fbi-ls-btn take" id="fbiTakeLocal">Take to program</button></div>';
  document.body.appendChild(d);
  const menu=d.querySelector("#fbiAddMenu"),menuBtn=d.querySelector("#fbiAddMenuBtn");
  const setMenu=open=>{menu.hidden=!open;menuBtn.setAttribute("aria-expanded",String(open));if(open)menu.querySelector("button")?.focus()};
  menuBtn.onclick=e=>{e.stopPropagation();setMenu(menu.hidden)};
  document.addEventListener("click",e=>{if(!menu.hidden&&!menu.contains(e.target)&&e.target!==menuBtn)setMenu(false)});
  menu.addEventListener("keydown",e=>{if(e.key==="Escape"){e.stopPropagation();setMenu(false);menuBtn.focus()}});
  menu.querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>setMenu(false)));
  A.openAddMenu=()=>{if(d.classList.contains("min"))d.querySelector("#fbiLocalMin").click();setMenu(true)};
  d.querySelector("#fbiAddCam").onclick=()=>addCamera("camera").catch(e=>toast(e.message||"Could not open camera devices"));
  d.querySelector("#fbiAddCapture").onclick=()=>addCamera("capture").catch(e=>toast(e.message||"Could not open capture devices"));
  d.querySelector("#fbiAddMeet").onclick=()=>meetingModal("MEET");
  d.querySelector("#fbiAddZoom").onclick=()=>meetingModal("ZOOM");
  d.querySelector("#fbiAddScreen").onclick=()=>addScreen().catch(e=>toast(e.message||"Could not capture screen"));
  d.querySelector("#fbiAddAudio").onclick=()=>addAudio().catch(e=>toast(e.message||"Could not capture audio"));
  d.querySelector("#fbiAddNdi").onclick=()=>addNdi().catch(e=>toast(e.message||"NDI Gateway unavailable"));
  d.querySelector("#fbiMulti").onclick=openMultiView;
  d.querySelector("#fbiLocalStop").onclick=stopGateway;d.querySelector("#fbiLocalClose").onclick=closeLocal;
  d.querySelector("#fbiLocalMin").onclick=()=>{d.classList.toggle("min");const m=d.classList.contains("min");d.querySelector("#fbiLocalMin").innerHTML=m?ICON.max:ICON.min;d.querySelector("#fbiLocalMin").title=m?"Expand":"Minimise";padMain()};
  if(window.ResizeObserver)new ResizeObserver(padMain).observe(d);
  document.addEventListener("keydown",onKeys);
  d.querySelector("#fbiTakeLocal").onclick=()=>{const s=A.sources.get(A.selectedSource);if(s)localTake(s);else toast("Select a local source for Preview first.")};
  const range=d.querySelector("#fbiLocalTbar");const paint=n=>{range.style.background="linear-gradient(90deg,#e8402f "+n+"%,#2a313b "+n+"%)";d.querySelector("#fbiLocalTbarValue").textContent=n+"%"};range.oninput=()=>{const n=Number(range.value);paint(n);if(n>=100){const s=A.sources.get(A.selectedSource);if(s)localTake(s);setTimeout(()=>{range.value=0;paint(0)},350)}};
}
function padMain(){const d=document.getElementById("fbiLocalDrawer"),m=document.querySelector(".main");if(!m)return;m.style.paddingBottom=d&&d.classList.contains("open")?(d.offsetHeight+30)+"px":""}
function closeLocal(){const d=document.getElementById("fbiLocalDrawer");if(d)d.classList.remove("open");document.getElementById("fbiLocalOpen")?.classList.remove("is-open");padMain()}
function onKeys(e){
  const d=document.getElementById("fbiLocalDrawer");if(!d||!d.classList.contains("open"))return;
  const t=e.target;if(t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)&&t.type!=="range"))return;
  if(e.key==="Escape"){const open=[...document.querySelectorAll(".channel-modal")].some(m=>m.offsetParent!==null&&!m.classList.contains("hidden"));if(!open)closeLocal();return}
  if(/^[1-9]$/.test(e.key)&&!e.ctrlKey&&!e.metaKey&&!e.altKey){const cards=[...document.querySelectorAll("#fbiLocalGrid [data-source-id]")];const c=cards[Number(e.key)-1];if(c){e.preventDefault();selectPreview(c.dataset.sourceId)}return}
  if(e.key==="Enter"&&!(t&&t.tagName==="BUTTON")){const s=A.sources.get(A.selectedSource);const b=document.getElementById("fbiTakeLocal");if(s&&b&&!b.disabled){e.preventDefault();localTake(s)}}
}
function refresh(){refreshChannelSource().catch(()=>{}).then(()=>{renderLocalGridOnly();padMain()})}
function openLocal(){build();const id=activeChannelId();if(!id){toast("Select a live channel first.");return}A.selectedChannel=id;const d=document.getElementById("fbiLocalDrawer");d.classList.add("open");document.getElementById("fbiLocalOpen")?.classList.add("is-open");refresh()}
function addControls(){
  const actions=document.querySelector(".top-actions");if(actions&&!document.getElementById("fbiLocalOpen")){const b=document.createElement("button");b.id="fbiLocalOpen";b.className="btn";b.textContent="LOCAL STUDIO";b.onclick=()=>{const d=document.getElementById("fbiLocalDrawer");if(d&&d.classList.contains("open"))closeLocal();else openLocal()};actions.insertBefore(b,actions.firstChild)}
  const rack=document.querySelector("#studio .rack .panel .pb.grid2");if(rack&&!document.getElementById("fbiTakeChannel")){const b=document.createElement("button");b.className="rack-btn primary";b.id="fbiTakeChannel";b.textContent="TAKE";rack.insertBefore(b,rack.firstChild);b.onclick=()=>putChannelInProgram(true)}
  const ctrl=document.querySelector("#studio .controls .control-group");if(ctrl&&!document.getElementById("fbiTakeChannelBottom")){const b=document.createElement("button");b.className="smallbtn primary";b.id="fbiTakeChannelBottom";b.textContent="TAKE TO PROGRAM";ctrl.insertBefore(b,ctrl.firstChild);b.onclick=()=>putChannelInProgram(true)}
  build();
}
function protectProgram(){
  if(A.bridge){setProgramMonitor(A.bridge.out);return}
  const id=activeChannelId();if(id&&id!==A.programChannel){A.programChannel=id;refreshChannelSource().catch(()=>{})}
}

function openMultiView(){
  if(!A.mv){
    const m=document.createElement("div");m.id="fbiLocalMultiView";m.className="fbi-addon-mv";m.innerHTML='<div class="fbi-addon-mv-card"><div class="fbi-ls-head"><div class="fbi-ls-title"><div><h2>Multiview</h2><p>Every Local Studio source at once</p></div></div><button type="button" class="fbi-ls-btn" id="fbiMvRefresh">Refresh</button><button type="button" class="fbi-ls-btn icon" id="fbiMvClose" aria-label="Close multiview">'+ICON.close+'</button></div><div class="fbi-addon-mv-grid" id="fbiMvGrid"></div></div>';document.body.appendChild(m);A.mv=m;m.querySelector("#fbiMvClose").onclick=()=>m.classList.remove("open");m.querySelector("#fbiMvRefresh").onclick=renderMultiView;m.onclick=e=>{if(e.target===m)m.classList.remove("open")}}
  A.mv.classList.add("open");renderMultiView();
}
function renderMultiView(){
  const g=document.getElementById("fbiMvGrid");if(!g)return;
  const keep=new Set();
  for(const s of A.sources.values()){
    keep.add(s.id);
    let card=s.mvCard;
    if(!card){
      card=document.createElement("div");card.className="fbi-addon-mv-card-item";card.dataset.sourceId=s.id;
      const vwrap=document.createElement("div");vwrap.className="fbi-addon-mv-visual";
      if(s.kind==="CHANNEL"||isLocalVideo(s)){
        const v=document.createElement("video");v.autoplay=true;v.muted=true;v.playsInline=true;v.style.cssText="width:100%;height:100%;object-fit:cover;display:block;background:#000";
        if(s.kind==="CHANNEL")setHls(v,inputHlsUrl(A.channelData||{}));else{v.srcObject=s.stream;v.play().catch(()=>{})}
        s.mvVideo=v;vwrap.appendChild(v);
      }else if(s.kind==="NDI"){
        const img=s.mvImage||new Image();img.crossOrigin="anonymous";if(!img.src)img.src="http://127.0.0.1:8765/preview?source_name="+encodeURIComponent(s.ndiName||s.name)+"&t="+Date.now();img.style.cssText="width:100%;height:100%;object-fit:cover;display:block";s.mvImage=img;vwrap.appendChild(img);
      }else vwrap.innerHTML='<div class="fbi-ls-audio">'+ICON.audio+'Audio input</div>';
      const body=document.createElement("div");body.className="fbi-addon-mv-body";
      const name=document.createElement("b");name.textContent=s.name;
      const meta=document.createElement("span");meta.textContent=(KIND[s.kind]||s.kind)+", "+s.detail;
      const acts=document.createElement("div");acts.className="fbi-addon-mv-actions";
      const p=document.createElement("button");p.textContent="Preview";p.onclick=()=>{selectPreview(s.id);A.mv.classList.remove("open")};
      const t=document.createElement("button");t.textContent="Take";t.className="primary";t.onclick=()=>{A.mv.classList.remove("open");localTake(s)};
      acts.append(p,t);body.append(name,meta,acts);card.append(vwrap,body);s.mvCard=card;
    }else{
      const meta=card.querySelector(".fbi-addon-mv-body span");if(meta)meta.textContent=s.kind+" • "+s.detail;
      if(s.kind==="CHANNEL"&&s.mvVideo)setHls(s.mvVideo,inputHlsUrl(A.channelData||{}));
      if(isLocalVideo(s)&&s.mvVideo&&s.mvVideo.srcObject!==s.stream){s.mvVideo.srcObject=s.stream;s.mvVideo.play().catch(()=>{})}
    }
    g.appendChild(card);
  }
  for(const card of [...g.children])if(!keep.has(card.dataset.sourceId)){const s=A.sources.get(card.dataset.sourceId);if(s?.mvVideo)destroyHls(s.mvVideo);card.remove()}
}


function watch(){
  if(A.timer)clearInterval(A.timer);
  A.timer=setInterval(()=>{
    addControls();protectProgram();
    if(document.getElementById("fbiLocalDrawer")?.classList.contains("open"))refreshChannelSource().then(updateLocalUi).catch(()=>{});
  },5000);
}

function boot(){addControls();watch()}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
})();