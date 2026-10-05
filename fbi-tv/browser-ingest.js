const {WebSocketServer}=require("ws");
const {spawn}=require("child_process");
const ffmpegPath=require("ffmpeg-static")||"ffmpeg";

const active=new Map();

function stopEntry(entry){
  if(!entry)return;
  try{entry.ws?.close()}catch{}
  try{entry.ff?.stdin?.end()}catch{}
  try{entry.ff?.kill("SIGTERM")}catch{}
  setTimeout(()=>{
    try{if(entry.ff&&!entry.ff.killed)entry.ff.kill("SIGKILL")}catch{}
  },1500);
}

function attachBrowserIngest(server,{pool,verifyToken,rtmpBase="rtmp://fbi-tv-live-ingest:1935/live"}){
  const wss=new WebSocketServer({noServer:true,maxPayload:8*1024*1024,perMessageDeflate:false});

  server.on("upgrade",(req,socket,head)=>{
    let url;
    try{url=new URL(req.url,"http://localhost")}catch{socket.destroy();return}
    if(url.pathname!=="/ws/local-studio"){socket.destroy();return}
    const token=url.searchParams.get("token")||"";
    const data=verifyToken(token);
    if(!data?.sid||!data?.uid){
      try{socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")}catch{}
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req,data));
  });

  wss.on("connection",async(ws,req,data)=>{
    const uid=String(data.uid);
    const sid=String(data.sid);

    const old=active.get(uid);
    if(old)stopEntry(old);

    let q;
    try{
      q=await pool.query("SELECT id,stream_key,enabled FROM tv_streams WHERE id=$1 LIMIT 1",[sid]);
    }catch(e){
      try{ws.close(1011,"Database unavailable")}catch{}
      return;
    }

    if(!q.rowCount||!q.rows[0].enabled){
      try{ws.close(1008,"Studio output unavailable")}catch{}
      return;
    }

    const stream=q.rows[0];
    const target=String(rtmpBase).replace(/\/+$/,"")+"/"+stream.stream_key;
    const ff=spawn(ffmpegPath,[
      "-hide_banner","-loglevel","warning",
      "-f","webm","-i","pipe:0",
      "-map","0:v:0","-map","0:a:0?",
      "-c:v","libx264","-preset","ultrafast","-tune","zerolatency",
      "-pix_fmt","yuv420p","-profile:v","main","-level","4.1",
      "-r","30","-g","60","-keyint_min","60","-sc_threshold","0",
      "-b:v","5M","-maxrate","6M","-bufsize","10M",
      "-c:a","aac","-b:a","128k","-ar","48000","-ac","2",
      "-f","flv",target
    ],{stdio:["pipe","ignore","pipe"]});

    const entry={ws,ff,sid,uid,started:false};
    active.set(uid,entry);

    ff.stderr.on("data",buf=>{
      const line=String(buf||"").trim();
      if(line&&/error|failed|invalid|broken|unable|refused/i.test(line))console.warn("Local studio FFmpeg:",line.slice(0,500));
    });
    ff.on("error",err=>{
      console.error("Local studio encoder failed:",err?.message||err);
      try{ws.close(1011,"Local studio encoder failed")}catch{}
    });
    ff.on("close",()=>{
      const current=active.get(uid);
      if(current===entry)active.delete(uid);
      pool.query("UPDATE tv_streams SET status='offline',updated_at=now() WHERE id=$1",[sid]).catch(()=>{});
    });

    ws.binaryType="nodebuffer";
    ws.on("message",(data,isBinary)=>{
      if(!isBinary||!data||ff.stdin.destroyed)return;
      try{
        const b=Buffer.isBuffer(data)?data:Buffer.from(data);
        if(!b.length)return;
        ff.stdin.write(b);
        if(!entry.started){
          entry.started=true;
          pool.query("UPDATE tv_streams SET status='live',updated_at=now() WHERE id=$1",[sid]).catch(()=>{});
        }
      }catch(e){
        console.error("Local studio ingest write failed:",e?.message||e);
        try{ws.close(1011,"Encoder input failed")}catch{}
      }
    });

    ws.on("close",()=>{
      try{ff.stdin.end()}catch{}
      try{ff.kill("SIGTERM")}catch{}
      const current=active.get(uid);
      if(current===entry)active.delete(uid);
    });

    ws.on("error",()=>{try{ff.stdin.end()}catch{}});
  });

  return {
    stopForUser(uid){
      const entry=active.get(String(uid));
      if(entry){stopEntry(entry);active.delete(String(uid));}
      return !!entry;
    },
    stopAll(){
      for(const [uid,entry] of active.entries()){stopEntry(entry);active.delete(uid);}
    }
  };
}

module.exports={attachBrowserIngest};
