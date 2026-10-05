
(function(){
  const css=[
    ".streamstudio{display:grid;gap:18px;padding:22px;border-radius:28px;min-height:calc(100vh - 160px);color:#171719;background:radial-gradient(circle at 75% 0%,#fffaf1 0,#f3eee5 58%,#ebe2d3 100%);border:1px solid rgba(28,27,25,.07);box-shadow:0 24px 70px rgba(57,45,25,.10)}",
    ".streamstudio *{box-sizing:border-box}",
    ".streamstudio-left,.streamstudio-right{min-width:0}",
    ".streamstudio-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:4px 2px}",
    ".streamstudio-kicker{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#7a7267}",
    ".streamstudio-top h1{margin:2px 0 0;font-size:24px;line-height:1.05;font-weight:850;color:#151517}",
    ".streamstudio-top p{margin:5px 0 0;font-size:10px;color:#746d63}",
    ".streamstudio-top-main{flex:1;min-width:220px}",
    ".streamstudio-top-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
    ".streamstudio-top-actions .btn{background:#fff;border-color:rgba(23,23,25,.09);color:#18181b}",
    ".streamstudio-top-actions .btn.primary{background:#e8c448;color:#171719;border-color:#e8c448}",
    ".streamstudio-layout{display:grid;grid-template-columns:286px minmax(0,1fr);gap:16px;align-items:start}",
    ".stream-channel-card{background:linear-gradient(180deg,#f8f4ec,#eee6d9);border:1px solid rgba(26,26,27,.08);border-radius:26px;padding:15px;box-shadow:0 22px 60px rgba(66,52,27,.12);position:sticky;top:18px}",
    ".stream-channel-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:2px 2px 14px}",
    ".stream-channel-head h2{margin:0;font-size:16px;color:#1b1b1e}.stream-channel-head p{margin:4px 0 0;font-size:9px;line-height:1.5;color:#777067}",
    ".stream-channel-count{font-size:8px;padding:5px 8px;border-radius:999px;background:#fff;border:1px solid rgba(20,20,20,.08);color:#5f5a52}",
    ".stream-channel-actions{margin-bottom:12px}.stream-channel-actions .btn{width:100%;border:0;border-radius:13px;padding:11px 12px;background:#1b1b1e;color:#fff;font-weight:800;box-shadow:0 8px 22px rgba(20,20,20,.14)}",
    ".streamlist{display:grid;gap:8px;max-height:calc(100vh - 290px);overflow:auto;padding-right:2px}",
    ".streamstudio .streamrow{border:1px solid rgba(20,20,20,.08);background:rgba(255,255,255,.78);color:#202023;border-radius:17px;padding:12px;cursor:pointer;transition:.18s ease}",
    ".streamstudio .streamrow:hover{transform:translateY(-1px);box-shadow:0 10px 26px rgba(44,36,22,.08)}",
    ".streamstudio .streamrow.sel{border-color:#caa72f;background:#fff;box-shadow:inset 0 0 0 1px rgba(202,167,47,.16),0 10px 26px rgba(44,36,22,.08)}",
    ".streamstudio .streamrow .stitle{font-size:11px;font-weight:850}.streamstudio .streamrow .smeta{font-size:8px;color:#777066;margin-top:4px;line-height:1.45}",
    ".streamstudio .livebadge{font-size:8px;padding:5px 8px;border-radius:999px;border:1px solid rgba(20,20,20,.1);background:#fff;color:#7c766f}.streamstudio .livebadge.live{color:#167a45;border-color:rgba(22,122,69,.25);background:#f3fbf5}",
    ".stream-stage{min-width:0}",
    ".streamhero{position:relative;overflow:hidden;border-radius:28px;background:#0c0c0e;min-height:0;box-shadow:0 28px 80px rgba(25,21,15,.18);border:1px solid rgba(255,255,255,.08)}",
    ".streamhero-top{position:absolute;z-index:5;left:0;right:0;top:0;display:flex;align-items:flex-start;gap:12px;padding:18px 20px;background:linear-gradient(180deg,rgba(0,0,0,.72),rgba(0,0,0,.03))}",
    ".streamhero-title{color:#fff;font-size:18px;font-weight:850;line-height:1.05}.streamhero-meta{font-size:9px;color:#d6d0c6;margin-top:5px}",
    ".streamhero-badge{margin-left:auto;padding:7px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.45);backdrop-filter:blur(12px);color:#ddd;font-size:8px;letter-spacing:.08em}.streamhero-badge.live{color:#7cf1a5;border-color:rgba(124,241,165,.34)}",
    ".streamhero video{display:block;width:100%;aspect-ratio:16/9;height:auto;min-height:430px;max-height:650px;background:#030304;object-fit:contain}",
    ".streamhero-empty{aspect-ratio:16/9;min-height:430px;display:grid;place-items:center;text-align:center;padding:40px;color:#aaa293;background:radial-gradient(circle at 50% 35%,#222225 0,#101012 55%,#080809 100%)}",
    ".streamhero-empty b{color:#fff;font-size:18px}.streamhero-empty p{font-size:10px;color:#a8a095;max-width:460px;line-height:1.6;margin:8px auto 0}",
    ".streamhero-bottom{position:absolute;z-index:5;left:16px;right:16px;bottom:16px;display:flex;align-items:flex-end;gap:10px}",
    ".streamhero-glass{flex:1;min-width:0;padding:14px 15px;border-radius:18px;background:rgba(8,8,9,.58);border:1px solid rgba(255,255,255,.13);backdrop-filter:blur(18px);color:#fff}",
    ".streamhero-glass h3{margin:0;font-size:13px;font-weight:800}.streamhero-glass p{margin:5px 0 0;color:#c6c0b6;font-size:8px}",
    ".streamhero-actions{display:flex;gap:7px;flex-wrap:wrap}.streamhero-actions .btn{background:rgba(255,255,255,.94);color:#151518;border-color:transparent}.streamhero-actions .btn.primary{background:#e8c448;color:#151515}",
    ".streammetrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:11px;margin-top:11px}",
    ".streammetric{background:linear-gradient(180deg,#fff,#f4efe6);border:1px solid rgba(20,20,20,.07);color:#171719;border-radius:19px;padding:14px;box-shadow:0 14px 34px rgba(39,31,18,.06)}",
    ".streammetric small{display:block;color:#7c7468;text-transform:uppercase;letter-spacing:.1em;font-size:7px}.streammetric b{display:block;font-size:18px;margin-top:5px}.streammetric span{display:block;font-size:8px;color:#7a746c;margin-top:4px}",
    ".streamlower{display:grid;grid-template-columns:1.1fr .9fr;gap:11px;margin-top:11px}",
    ".streamglass{background:#fff;color:#171719;border:1px solid rgba(20,20,20,.07);border-radius:20px;padding:15px;box-shadow:0 14px 34px rgba(39,31,18,.05)}",
    ".streamglass-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.streamglass h3{margin:0;font-size:12px;font-weight:850}.streamglass p{margin:4px 0 11px;color:#746f67;font-size:8px;line-height:1.5}",
    ".streamsetup{display:grid;gap:8px}.streamsetup .credrow{grid-template-columns:62px 1fr auto}.streamsetup .credrow label{color:#80786d;font-size:8px}.streamsetup .credrow input{min-width:0;width:100%;background:#f7f4ee;border:1px solid rgba(20,20,20,.09);color:#29282a;border-radius:10px;padding:9px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:8px}",
    ".streamcode{border:1px solid rgba(20,20,20,.09);background:#171719;color:#efede8;border-radius:12px;padding:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:8px;line-height:1.6;white-space:pre-wrap;word-break:break-word}",
    ".streamStatusLine{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;padding-top:10px;border-top:1px solid #ece7de}",
    ".streamstatus-pill{font-size:8px;color:#6e675d}",
    ".streamrecord{display:flex;align-items:center;gap:9px;padding:9px 0;border-bottom:1px solid #ebe5dc}.streamrecord:last-child{border-bottom:0}.streamrecord-thumb{width:82px;height:48px;flex:none;border-radius:10px;overflow:hidden;background:#151517;display:grid;place-items:center;color:#efc84d}.streamrecord-thumb video{width:100%;height:100%;object-fit:cover}.streamrecord-info{min-width:0;flex:1}.streamrecord-info b{display:block;font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.streamrecord-info span{display:block;font-size:7px;color:#777168;margin-top:3px}",
    ".stream-settings{margin-top:11px}.stream-settings .ph{padding:15px}.stream-settings .body{padding:15px}",
    ".stream-danger{margin-top:11px;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;border-radius:18px;background:#fff5f4;border:1px solid rgba(180,40,40,.12)}",
    ".stream-danger b{font-size:9px;color:#8a2d2d}.stream-danger span{display:block;color:#9a6f6f;font-size:7px;margin-top:3px}",
    ".streamsetup .mini{background:#f0ece3;color:#2b2927;border-color:rgba(20,20,20,.08)}",
    "@media(max-width:1050px){.streamstudio-layout{grid-template-columns:1fr}.stream-channel-card{position:static}.streamlist{max-height:none;grid-template-columns:repeat(2,minmax(0,1fr))}.streamlower{grid-template-columns:1fr}}",
    "@media(max-width:700px){.streamstudio-top h1{font-size:20px}.streamlist{grid-template-columns:1fr}.streammetrics{grid-template-columns:1fr}.streamhero video,.streamhero-empty{min-height:260px}.streamhero-bottom{position:static;padding:12px;display:block;background:#0d0d0f}.streamhero-actions{margin-top:8px}.streamlower{grid-template-columns:1fr}.streamstudio-top-actions{width:100%}.streamstudio-top-actions .btn{flex:1}}"
  ].join("");
  if(!document.getElementById("fbi-streamstudio-style")){
    const st=document.createElement("style");st.id="fbi-streamstudio-style";st.textContent=css;document.head.appendChild(st);
  }

  window.ensureHlsJs=async function(){
    if(window.Hls)return window.Hls;
    if(window.__fbiHlsLoading)return window.__fbiHlsLoading;
    window.__fbiHlsLoading=new Promise(function(resolve,reject){
      const s=document.createElement("script");
      s.src="https://cdn.jsdelivr.net/npm/hls.js@latest";
      s.onload=function(){resolve(window.Hls)};
      s.onerror=reject;
      document.head.appendChild(s);
    });
    return window.__fbiHlsLoading;
  };

  window.mountStudioStreamPlayer=async function(video,url){
    if(!video||!url)return;
    try{
      if(video.__hls){try{video.__hls.destroy()}catch{}video.__hls=null}
      if(video.canPlayType("application/vnd.apple.mpegurl")){
        video.src=url;
        video.play().catch(function(){});
        return;
      }
      const H=await window.ensureHlsJs();
      if(!H||!H.isSupported())throw new Error("This browser does not support HLS playback.");
      const hls=new H({
        enableWorker:true,
        lowLatencyMode:false,
        liveSyncDurationCount:3,
        liveMaxLatencyDurationCount:6,
        maxLiveSyncPlaybackRate:1.15,
        maxBufferLength:30,
        maxMaxBufferLength:60,
        backBufferLength:90,
        capLevelToPlayerSize:true,
        startLevel:-1      });
      video.__hls=hls;
      hls.on(H.Events.ERROR,function(_,data){
        if(!data||!data.fatal)return;
        try{hls.destroy()}catch{}
        video.__hls=null;
        const note=document.querySelector("#streamPlayerStatus");
        if(note)note.textContent="Live playback reconnecting…";
        setTimeout(function(){window.mountStudioStreamPlayer(video,url)},1800);
      });
      hls.on(H.Events.MANIFEST_PARSED,function(){video.play().catch(function(){})});
      hls.loadSource(url);
      hls.attachMedia(video);
    }catch(e){
      const note=document.querySelector("#streamPlayerStatus");
      if(note)note.textContent=e.message||"Playback unavailable";
    }
  };

  window.streamRecordingDuration=function(started,ended){
    const a=new Date(started||Date.now()).getTime(),b=new Date(ended||Date.now()).getTime();
    let s=Math.max(0,Math.round((b-a)/1000));const h=Math.floor(s/3600);s%=3600;const m=Math.floor(s/60),ss=s%60;
    return h?(h+"h "+m+"m "+ss+"s"):(m?(m+"m "+ss+"s"):(ss+"s"));
  };

  window.loadStreamRecordings=function(streamId){
    const box=document.querySelector("#streamRecordings");
    if(!box)return Promise.resolve();
    return api("/api/streams/"+streamId+"/recordings").then(function(d){
      const rows=d.recordings||[];
      if(!rows.length){box.innerHTML="<div class='smallnote'>No recordings yet. Finished live sessions will be saved here automatically.</div>";return}
      box.innerHTML=rows.map(function(r){
        const ready=r.status==="completed"&&r.play_url;
        return "<div class='streamrecord'>"+
          "<div class='streamrecord-thumb'>"+(ready?"<video muted playsinline preload='metadata' src='"+esc(r.play_url)+"'></video>":"◷")+"</div>"+
          "<div class='streamrecord-info'><b>"+esc(r.filename)+"</b><span>"+esc(r.status)+" • "+fmt(r.size_bytes||0)+" • "+streamRecordingDuration(r.started_at,r.ended_at)+"</span></div>"+
          (ready?"<button class='mini' data-record-play='"+esc(r.play_url)+"'>Play</button>":"")+
        "</div>";
      }).join("");
      box.querySelectorAll("[data-record-play]").forEach(function(b){
        b.onclick=function(){
          const modal=document.createElement("div");modal.className="viewer show";
          modal.innerHTML="<div class='viewerbox'><div class='vh'><b>Recorded Live Session</b><button class='close'>×</button></div><div class='vc'><video controls autoplay playsinline src='"+b.dataset.recordPlay+"'></video></div></div>";
          document.body.appendChild(modal);
          modal.querySelector(".close").onclick=function(){modal.remove()};
          modal.onclick=function(e){if(e.target===modal)modal.remove()};
        };
      });
    }).catch(function(e){box.innerHTML="<div class='smallnote'>"+esc(e.message)+"</div>"});
  };

  window.renderSelectedStream=function(){
    const pane=document.querySelector("#streamDetail");if(!pane)return;
    const s=selectedStream();
    if(!s){pane.innerHTML="<div class='empty'>Select a stream or create a new live stream.</div>";return}
    const liveUrl=String(s.live_url||location.origin+"/live/"+s.id),watch=String(s.viewer_url||""),rtmp=String(s.rtmp_server||""),key=String(s.stream_key||"");
    const rawHls=String(s.hls_url||"").trim();
    const hls=rawHls?(/\.m3u8(?:\?|$)/i.test(rawHls)?rawHls:rawHls.replace(/\/+$/,"")+"/index.m3u8"):"";

    pane.innerHTML=
      "<div class='streamstudio-top'>"+
        "<div class='streamstudio-top-main'><div class='streamstudio-kicker'>FBI Live Broadcast Studio</div><h1>"+esc(s.title||s.name)+"</h1><p>"+esc(s.name)+" • "+(s.status==="live"?"Live broadcast is on air":"Ready for broadcast")+"</p></div>"+
        "<div class='streamstudio-top-actions'><button class='btn' id='copyLive'>Copy Live Link</button><button class='btn' id='copyAllStream'>Copy Setup</button><button class='btn primary' id='openWatch'>Open Watch Page</button></div>"+
      "</div>"+
      "<div class='streamstudio-layout'>"+
        "<aside class='stream-channel-card'>"+
          "<div class='stream-channel-head'><div><h2>Live Channels</h2><p>Select a channel to manage its broadcast.</p></div><span class='stream-channel-count'>"+Number((window.__streams||[]).length)+" channels</span></div>"+
          "<div class='stream-channel-actions'><button class='btn' id='newStream'>＋ New Stream</button></div>"+
          "<div id='streamList' class='streamlist'></div>"+
        "</aside>"+
        "<section class='stream-stage'>"+
          "<div class='streamhero'>"+
            "<div class='streamhero-top'>"+
              "<div><div class='streamhero-title'>"+esc(s.name)+"</div><div class='streamhero-meta'>"+esc(s.title||"FBI Live Channel")+" • "+Number(s.current_viewers||0)+" watching</div></div>"+
              "<div class='streamhero-badge "+(s.status==="live"?"live":"")+"'>"+(s.status==="live"?"● LIVE":"OFFLINE")+"</div>"+
            "</div>"+
            (s.status==="live"&&hls?"<video id='studioStreamVideo' controls autoplay muted playsinline></video>":"<div class='streamhero-empty'><div><b>"+(s.status==="live"?"ENCODER STARTING":"READY FOR LIVE")+"</b><p>"+(s.status==="live"?"The live signal is received. Preparing the browser playback stream.":"Publish from OBS, vMix, Streamlabs or another RTMP encoder using the connection details below.")+"</p></div></div>")+
            "<div class='streamhero-bottom'><div class='streamhero-glass'><h3>"+esc(s.title||s.name)+"</h3><p><span id='streamDetailViewers'>"+Number(s.current_viewers||0)+" watching now</span> • "+(s.record_enabled?"Automatic recording ON":"Recording OFF")+"</p></div><div class='streamhero-actions'><button class='btn primary' id='openWatchHero'>Watch Page</button></div></div>"+
          "</div>"+
          "<div class='streammetrics'>"+
            "<div class='streammetric'><small>Live Signal</small><b>"+(s.status==="live"?"ON AIR":"OFFLINE")+"</b><span>"+(s.status==="live"?"Input detected and online":"Waiting for encoder")+"</span></div>"+
            "<div class='streammetric'><small>Viewers Now</small><b>"+Number(s.current_viewers||0)+"</b><span>"+Number(s.total_viewers||0)+" total viewer sessions</span></div>"+
            "<div class='streammetric'><small>Recording</small><b>"+(s.record_enabled?"ON":"OFF")+"</b><span>"+(s.record_enabled?"Save completed sessions automatically":"Recording disabled")+"</span></div>"+
          "</div>"+
          "<div class='streamlower'>"+
            "<div class='streamglass'>"+
              "<div class='streamglass-head'><div><h3>Broadcast Setup</h3><p>Use these settings in OBS, vMix, Streamlabs or another RTMP encoder.</p></div><button class='mini' id='copyRtmp'>Copy Server</button></div>"+
              "<div class='streamsetup'>"+
                "<div class='credrow'><label>Server</label><input readonly value='"+esc(rtmp)+"'><button class='mini' id='copyRtmp2'>Copy</button></div>"+
                "<div class='credrow'><label>Key</label><input id='streamKey' type='password' readonly value='"+esc(key)+"'><div><button class='mini' id='toggleKey'>Show</button> <button class='mini' id='copyKey'>Copy</button></div></div>"+
              "</div>"+
              "<div class='streamcode' style='margin-top:10px'>Service: Custom RTMP\nServer: "+esc(rtmp)+"\nStream Key: "+esc(key)+"</div>"+
              "<div class='streamStatusLine'><span id='streamPlayerStatus' class='streamstatus-pill'>"+(s.status==="live"?"Live playback active":"Waiting for the live signal")+"</span><span class='streamstatus-pill'>H.264 / AAC</span></div>"+
            "</div>"+
            "<div class='streamglass'>"+
              "<div class='streamglass-head'><div><h3>Recorded Sessions</h3><p>Completed live broadcasts saved as playable files.</p></div></div>"+
              "<div id='streamRecordings'><div class='smallnote'>Loading recordings…</div></div>"+
            "</div>"+
          "</div>"+
          "<div class='panel stream-settings' style='box-shadow:none'><div class='ph'><div><h2>Stream Settings</h2><p>Manage the channel without changing the streaming engine.</p></div><button class='btn primary' id='saveStream'>Save Changes</button></div>"+
            "<div class='body'><div class='settinggrid'><div class='field'><label>Stream Name</label><input id='streamNameEdit' value='"+esc(s.name)+"'></div><div class='field'><label>On-screen Title</label><input id='streamTitleEdit' value='"+esc(s.title||"")+"'></div></div>"+
            "<div class='field'><label>Description</label><textarea id='streamDescEdit'>"+esc(s.description||"")+"</textarea></div>"+
            "<div class='settinggrid'><label class='toggle'><input id='streamShareEdit' type='checkbox' "+(s.shared?"checked":"")+"><span><b>Allow viewers to watch</b><br><small class='muted'>Turn the public watch page on or off.</small></span></label>"+
            "<label class='toggle'><input id='streamRecordEdit' type='checkbox' "+(s.record_enabled?"checked":"")+"><span><b>Record every live session</b><br><small class='muted'>Save a playable MP4 automatically when streaming ends.</small></span></label></div></div>"+
          "</div>"+
          "<div class='stream-danger'><div><b>Stream Key Management</b><span>Regenerating the key changes the publishing address for this channel.</span></div><div><button class='btn' id='regenStreamKey'>Regenerate Key</button> <button class='btn danger' id='deleteStream'>Delete Stream</button></div></div>"+
        "</section>"+
      "</div>";

    renderStreamsList();
    document.querySelector("#copyLive").onclick=function(){copyText(liveUrl)};
    document.querySelector("#copyRtmp").onclick=function(){copyText(s.rtmp_server)};
    document.querySelector("#copyRtmp2").onclick=function(){copyText(s.rtmp_server)};
    document.querySelector("#copyKey").onclick=function(){copyText(s.stream_key)};
    document.querySelector("#copyAllStream").onclick=function(){copyText("Server: "+s.rtmp_server+"\nStream Key: "+s.stream_key)};
    document.querySelector("#toggleKey").onclick=function(){const i=document.querySelector("#streamKey");i.type=i.type==="password"?"text":"password";this.textContent=i.type==="password"?"Show":"Hide"};
    document.querySelector("#openWatch").onclick=function(){window.open(s.viewer_url,"_blank","noopener")};
    document.querySelector("#openWatchHero").onclick=function(){window.open(s.viewer_url,"_blank","noopener")};
    document.querySelector("#newStream").onclick=function(){document.querySelector("#streamModal").classList.add("show");document.querySelector("#streamName").focus()};
    document.querySelector("#saveStream").onclick=async function(){
      try{
        const r=await api("/api/streams/"+s.id,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({
          name:document.querySelector("#streamNameEdit").value,
          title:document.querySelector("#streamTitleEdit").value,
          description:document.querySelector("#streamDescEdit").value,
          shared:document.querySelector("#streamShareEdit").checked,
          record_enabled:document.querySelector("#streamRecordEdit").checked
        })});
        window.__streams=(window.__streams||[]).map(function(x){return x.id===s.id?{...x,...r.stream}:x});
        renderStreamsList();renderedStreamSignature="";
        renderSelectedStream();toast("Stream settings saved");
      }catch(e){toast(e.message)}
    };
    document.querySelector("#regenStreamKey").onclick=async function(){
      if(!confirm("Regenerate this stream key? The old publishing key will stop working."))return;
      const r=await api("/api/streams/"+s.id+"/regenerate-key",{method:"POST"});
      renderedStreamSignature="";await loadStreams();selectedStreamId=r.stream.id;toast("Stream key regenerated");
    };
    document.querySelector("#deleteStream").onclick=async function(){
      if(!confirm("Delete this stream configuration?"))return;
      await api("/api/streams/"+s.id,{method:"DELETE"});selectedStreamId=null;renderedStreamSignature="";await loadStreams();toast("Stream deleted");
    };
    if(s.status==="live"&&hls){
      window.mountStudioStreamPlayer(document.querySelector("#studioStreamVideo"),hls);
    }
    window.loadStreamRecordings(s.id);
  };
  window.renderStreamsPage=function(){
    document.querySelector("#content").innerHTML="<div class='streamstudio'>"+
      "<div class='streamstudio-top'><div class='streamstudio-top-main'><div class='streamstudio-kicker'>FBI Live Broadcast Studio</div><h1>Live Streaming</h1><p>Manage your live channels, monitor the broadcast and access recorded sessions.</p></div><div class='streamstudio-top-actions'><button class='btn primary' id='newStreamTop'>＋ New Stream</button></div></div>"+
      "<div id='streamDetail'><div class='empty'>Select a live channel or create a new stream.</div></div>"+
    "</div>";
    document.querySelector("#newStreamTop").onclick=function(){document.querySelector("#streamModal").classList.add("show");document.querySelector("#streamName").focus()};
    loadStreams();
    clearInterval(streamPoller);
    streamPoller=setInterval(function(){if(activeStudioView==="streams")loadStreams().catch(function(){})},5000);
  };

/*
 * Client gallery lightbox image recovery.
 * The gallery thumbnails use the public thumbnail route successfully. Older
 * lightbox markup could request /api/public/preview/, which can leave the
 * viewer overlay open with a blank image. Keep this scoped to the client
 * lightbox and transparently recover it to the known-good public thumbnail,
 * with the original media URL as a final fallback.
 */
(function installClientLightboxImageRecovery(){
  function repair(){
    const box=document.querySelector('#clientLightbox');
    if(!box)return;
    box.querySelectorAll('img[src*="/api/public/preview/"]').forEach(function(img){
      if(img.dataset.fbiPreviewRecovered==='1')return;
      img.dataset.fbiPreviewRecovered='1';
      const raw=img.getAttribute('src')||'';
      try{
        const u=new URL(raw,location.origin);
        const match=u.pathname.match(/\\/api\\/public\\/preview\\/([^/]+)/);
        const id=match&&match[1];
        const token=u.searchParams.get('token')||'';
        if(!id||!token)return;
        const thumb='/api/public/thumb/'+encodeURIComponent(id)+'?token='+encodeURIComponent(token)+'&w=1800&h=1800';
        const media='/api/public/media/'+encodeURIComponent(id)+'?token='+encodeURIComponent(token);
        img.onerror=function(){
          if(img.dataset.fbiMediaFallback==='1')return;
          img.dataset.fbiMediaFallback='1';
          img.src=media;
        };
        img.src=thumb;
      }catch(_e){}
    });
  }
  const observer=new MutationObserver(repair);
  function start(){
    if(!document.body)return;
    observer.observe(document.body,{childList:true,subtree:true});
    repair();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})();

})();
