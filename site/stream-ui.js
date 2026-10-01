
(function(){
  const css=[
    ".streamstudio{display:grid;grid-template-columns:290px minmax(0,1fr);gap:16px}",
    ".streamstudio-left{min-width:0}",
    ".streamstudio-right{min-width:0}",
    ".stream-channel-card{background:linear-gradient(145deg,#f5efe5,#e8dfd1);color:#19191c;border-radius:22px;padding:14px;box-shadow:0 20px 60px rgba(0,0,0,.18)}",
    ".stream-channel-card h2{color:#19191c;font-size:16px;margin:0}.stream-channel-card p{color:#746e64;font-size:9px;line-height:1.5}",
    ".stream-channel-card .ph{padding:4px 2px 12px;border:0}.stream-channel-card .body{padding:4px 0 0}",
    ".streamstudio .streamrow{background:rgba(255,255,255,.72);color:#202023;border:1px solid rgba(20,20,20,.08);border-radius:16px;padding:12px;margin-bottom:8px}",
    ".streamstudio .streamrow.sel{border-color:#c7a83f;box-shadow:inset 0 0 0 1px rgba(199,168,63,.15)}",
    ".streamstudio .streamrow .smeta{color:#777066}",
    ".streamhero{border-radius:22px;overflow:hidden;background:linear-gradient(135deg,#30281d,#0c0d0f 58%,#191a1d);min-height:430px;position:relative;box-shadow:0 28px 80px rgba(0,0,0,.28)}",
    ".streamhero-top{position:absolute;z-index:4;top:0;left:0;right:0;padding:16px 18px;display:flex;align-items:center;gap:10px;background:linear-gradient(180deg,rgba(0,0,0,.66),transparent)}",
    ".streamhero-title{color:#fff;font-size:16px;font-weight:800}.streamhero-meta{font-size:9px;color:#cfc8ba;margin-top:3px}",
    ".streamhero-badge{margin-left:auto;padding:7px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.35);color:#ddd;font-size:9px;backdrop-filter:blur(10px)}",
    ".streamhero-badge.live{color:#65f39a;border-color:rgba(101,243,154,.28)}",
    ".streamhero video{display:block;width:100%;height:430px;background:#000;object-fit:contain}",
    ".streamhero-empty{height:430px;display:grid;place-items:center;text-align:center;padding:30px;color:#aaa293}",
    ".streamhero-empty b{color:#fff;font-size:17px}.streamhero-empty p{font-size:10px;color:#a8a095;max-width:440px;line-height:1.5}",
    ".streamhero-bottom{position:absolute;z-index:4;left:14px;right:14px;bottom:14px;display:flex;align-items:end;gap:10px}",
    ".streamhero-glass{flex:1;padding:12px;border-radius:18px;background:rgba(10,10,11,.55);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(14px);color:#fff}",
    ".streamhero-glass h3{margin:0;font-size:13px}.streamhero-glass p{margin:4px 0 0;color:#c2bcaf;font-size:9px}",
    ".streamhero-actions{display:flex;gap:7px;flex-wrap:wrap}.streamhero-actions .btn{background:rgba(255,255,255,.92);color:#151518;border-color:transparent}.streamhero-actions .btn.primary{background:#efc84d;color:#111}",
    ".streammetrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:10px}",
    ".streammetric{background:#f4efe6;color:#171719;border-radius:16px;padding:13px}.streammetric small{display:block;color:#7c7468;text-transform:uppercase;letter-spacing:.08em;font-size:8px}.streammetric b{display:block;font-size:17px;margin-top:5px}.streammetric span{display:block;font-size:9px;color:#7a746c;margin-top:3px}",
    ".streamlower{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}",
    ".streamglass{background:#fff;color:#171719;border-radius:18px;padding:14px;border:1px solid rgba(20,20,20,.08)}.streamglass h3{margin:0;font-size:12px}.streamglass p{margin:4px 0 10px;color:#746f67;font-size:9px}",
    ".streamrecord{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #ebe5dc}.streamrecord:last-child{border-bottom:0}.streamrecord-thumb{width:84px;height:48px;flex:none;border-radius:9px;overflow:hidden;background:#151517;display:grid;place-items:center;color:#efc84d}.streamrecord-thumb video{width:100%;height:100%;object-fit:cover}.streamrecord-info{min-width:0;flex:1}.streamrecord-info b{display:block;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.streamrecord-info span{display:block;font-size:8px;color:#777168;margin-top:3px}",
    ".streamsetup{display:grid;gap:8px}.streamsetup .credrow{grid-template-columns:72px 1fr auto}.streamsetup .credrow label{color:#7b7468}",
    "@media(max-width:1000px){.streamstudio{grid-template-columns:1fr}.streammetrics{grid-template-columns:repeat(2,minmax(0,1fr))}.streamlower{grid-template-columns:1fr}.streamhero video,.streamhero-empty{height:360px}}",
    "@media(max-width:620px){.streammetrics{grid-template-columns:1fr 1fr}.streamhero-bottom{flex-direction:column;align-items:stretch}.streamhero-actions{justify-content:flex-end}}"
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
        startLevel:-1,
        xhrSetup:function(xhr){xhr.withCredentials=true;},
        fetchSetup:function(context,init){init.credentials="include";return new Request(context.url,init);}
      });
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
    const watch=String(s.viewer_url||""),rtmp=String(s.rtmp_server||""),key=String(s.stream_key||"");
    const hls=s.hls_url?String(s.hls_url)+"/index.m3u8":"";
    pane.innerHTML=
      "<div class='streamhero'>"+
        "<div class='streamhero-top'>"+
          "<div><div class='streamhero-title'>"+esc(s.name)+"</div><div class='streamhero-meta'>"+esc(s.title||"FBI Live Channel")+"</div></div>"+
          "<div class='streamhero-badge "+(s.status==="live"?"live":"")+"'>"+(s.status==="live"?"● LIVE":"OFFLINE")+"</div>"+
        "</div>"+
        (s.status==="live"&&hls?"<video id='studioStreamVideo' controls autoplay muted playsinline></video>":"<div class='streamhero-empty'><div><b>"+(s.status==="live"?"ENCODER STARTING":"READY FOR LIVE")+"</b><p>"+(s.status==="live"?"The live signal is received. The embedded encoder is preparing a browser-optimized H.264 stream.":"Publish from OBS, vMix, Streamlabs or your production encoder using the connection details below.")+"</p></div></div>")+
        "<div class='streamhero-bottom'><div class='streamhero-glass'><h3>"+esc(s.title||s.name)+"</h3><p>"+Number(s.current_viewers||0)+" watching now • "+(s.record_enabled?"Automatic recording ON":"Recording OFF")+"</p></div><div class='streamhero-actions'><button class='btn primary' id='copyAllStream'>Copy Setup</button><button class='btn' id='openWatch'>Open Watch</button></div></div>"+
      "</div>"+
      "<div class='streammetrics'>"+
        "<div class='streammetric'><small>Live Signal</small><b>"+(s.status==="live"?"LIVE":"OFFLINE")+"</b><span>"+(s.status==="live"?"Input detected":"Waiting for input")+"</span></div>"+
        "<div class='streammetric'><small>Viewers</small><b>"+Number(s.current_viewers||0)+"</b><span>"+Number(s.total_viewers||0)+" viewer sessions</span></div>"+
        "<div class='streammetric'><small>Encoder</small><b>"+(s.status==="live"?"ON":"READY")+"</b><span>H.264 / AAC normalization</span></div>"+
        "<div class='streammetric'><small>Recording</small><b>"+(s.record_enabled?"ON":"OFF")+"</b><span>Save completed sessions</span></div>"+
      "</div>"+
      "<div class='streamlower'>"+
        "<div class='streamglass'><h3>Broadcast Setup</h3><p>Use these settings in OBS, vMix, Streamlabs or another RTMP encoder.</p>"+
          "<div class='streamsetup'><div class='credrow'><label>Server</label><input readonly value='"+esc(rtmp)+"'><button class='mini' id='copyRtmp'>Copy</button></div>"+
          "<div class='credrow'><label>Key</label><input id='streamKey' type='password' readonly value='"+esc(key)+"'><div><button class='mini' id='toggleKey'>Show</button> <button class='mini' id='copyKey'>Copy</button></div></div></div>"+
          "<div id='streamPlayerStatus' class='smallnote' style='margin-top:10px'>"+(s.status==="live"?"Starting low-latency browser playback…":"Waiting for the live signal")+"</div>"+
        "</div>"+
        "<div class='streamglass'><h3>Recorded Sessions</h3><p>When the live session ends, the playable MP4 is saved to cloud storage.</p><div id='streamRecordings'><div class='smallnote'>Loading recordings…</div></div></div>"+
      "</div>"+
      "<div style='height:10px'></div>"+
      "<div class='panel' style='box-shadow:none'><div class='ph'><div><h2>Stream Settings</h2><p>Control viewer access and automatic recording.</p></div><button class='btn primary' id='saveStream'>Save Changes</button></div>"+
        "<div class='body'><div class='settinggrid'><div class='field'><label>Stream Name</label><input id='streamNameEdit' value='"+esc(s.name)+"'></div><div class='field'><label>On-screen Title</label><input id='streamTitleEdit' value='"+esc(s.title||"")+"'></div></div>"+
        "<div class='field'><label>Description</label><textarea id='streamDescEdit'>"+esc(s.description||"")+"</textarea></div>"+
        "<div class='settinggrid'><label class='toggle'><input id='streamShareEdit' type='checkbox' "+(s.shared?"checked":"")+"><span><b>Allow viewers to watch</b><br><small class='muted'>Turn the public watch page on or off.</small></span></label>"+
        "<label class='toggle'><input id='streamRecordEdit' type='checkbox' "+(s.record_enabled?"checked":"")+"><span><b>Record every live session</b><br><small class='muted'>Save a playable MP4 automatically when streaming ends.</small></span></label></div></div></div>";

    document.querySelector("#copyRtmp").onclick=function(){copyText(s.rtmp_server)};
    document.querySelector("#copyKey").onclick=function(){copyText(s.stream_key)};
    document.querySelector("#copyAllStream").onclick=function(){copyText("Server: "+s.rtmp_server+"\nStream Key: "+s.stream_key)};
    document.querySelector("#toggleKey").onclick=function(){const i=document.querySelector("#streamKey");i.type=i.type==="password"?"text":"password";this.textContent=i.type==="password"?"Show":"Hide"};
    document.querySelector("#openWatch").onclick=function(){window.open(s.viewer_url,"_blank","noopener")};
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
        renderStreamsList();renderSelectedStream();toast("Stream settings saved");
      }catch(e){toast(e.message)}
    };
    if(s.status==="live"&&hls){
      window.mountStudioStreamPlayer(document.querySelector("#studioStreamVideo"),hls);
    }
    window.loadStreamRecordings(s.id);
  };

  window.renderStreamsPage=function(){
    document.querySelector("#content").innerHTML=
      "<div class='streamstudio'>"+
        "<div class='streamstudio-left'><div class='stream-channel-card'><div class='ph'><div><h2>Live Channels</h2><p>Professional live channels with RTMP publishing, browser playback, low-latency delivery and automatic recording.</p></div><button class='btn primary' id='newStream'>＋ New Stream</button></div><div class='body'><div id='streamList' class='streamlist'></div></div></div></div>"+
        "<div class='streamstudio-right'><div id='streamDetail'><div class='empty'>Select a stream or create a new live stream.</div></div></div>"+
      "</div>";
    document.querySelector("#newStream").onclick=function(){document.querySelector("#streamModal").classList.add("show");document.querySelector("#streamName").focus()};
    loadStreams();
    clearInterval(streamPoller);
    streamPoller=setInterval(function(){if(activeStudioView==="streams")loadStreams().catch(function(){})},5000);
  };
})();
