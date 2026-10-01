const express=require("express");
const crypto=require("crypto");
const path=require("path");
const {Pool}=require("pg");
const {spawn}=require("child_process");
const ffmpegPath=require("ffmpeg-static");

const app=express();
app.use(express.json({limit:"1mb"}));
app.use(express.urlencoded({extended:true}));
const PORT=Number(process.env.PORT||8080);
const ADMIN_EMAIL=(process.env.ADMIN_EMAIL||"filmbyfbi@gmail.com").trim().toLowerCase();
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";
const SESSION_SECRET=process.env.SESSION_SECRET||crypto.randomBytes(32).toString("hex");
const MEDIA_BASE=(process.env.MEDIA_BASE_URL||"").replace(/\/+$/,"");
const RTMP_HOST=process.env.RTMP_HOST||"";
const RTMP_PORT=Number(process.env.RTMP_PORT||1935);
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:false});

const MEDIA_RTMP_INTERNAL=String(process.env.MEDIA_RTMP_INTERNAL||"rtmp://fbi-tv-media:1935").replace(/\/+$/,"");
const tvTranscoders=new Map();

function encodedPublishUrl(key){
  const clean=encodeURIComponent(String(key||""));
  const u=new URL(MEDIA_RTMP_INTERNAL);
  u.pathname="/encoded/"+clean;
  u.username="fbi";
  u.password=String(key||"");
  return u.toString();
}
function inputRtmpUrl(key){
  const u=new URL(MEDIA_RTMP_INTERNAL);
  u.pathname="/live/"+encodeURIComponent(String(key||""));
  u.username="";
  u.password="";
  return u.toString();
}
function stopTvTranscoder(id){
  const entry=tvTranscoders.get(String(id));
  if(!entry)return;
  try{entry.proc.kill("SIGINT")}catch{}
  tvTranscoders.delete(String(id));
}
function startTvTranscoder(row,delay=0){
  if(!row||!row.id||!row.stream_key||!row.enabled)return;
  const id=String(row.id);
  if(tvTranscoders.has(id))return;
  if(!ffmpegPath){
    console.error("FFmpeg static binary is unavailable; cannot normalize stream",id);
    return;
  }
  const launch=()=>{
    if(tvTranscoders.has(id))return;
    const key=String(row.stream_key);
    const input=inputRtmpUrl(key);
    const output=encodedPublishUrl(key);
    const args=[
      "-hide_banner","-loglevel","warning",
      "-i",input,
      "-map","0:v:0",
      "-map","0:a:0?",
      "-c:v","libx264",
      "-preset","ultrafast",
      "-tune","zerolatency",
      "-pix_fmt","yuv420p",
      "-profile:v","main",
      "-level","4.1",
      "-r","30",
      "-g","60",
      "-keyint_min","60",
      "-sc_threshold","0",
      "-b:v","5M",
      "-maxrate","6M",
      "-bufsize","10M",
      "-c:a","aac",
      "-b:a","128k",
      "-ar","48000",
      "-ac","2",
      "-f","flv",
      output
    ];
    console.log("Starting FBI TV H264 normalizer for",id);
    const proc=spawn(ffmpegPath,args,{stdio:["ignore","pipe","pipe"]});
    const entry={proc,key,startedAt:Date.now(),restartTimer:null};
    tvTranscoders.set(id,entry);
    proc.stdout.on("data",()=>{});
    proc.stderr.on("data",buf=>{
      const msg=String(buf||"").trim();
      if(msg)console.error("FBI TV normalizer",id,msg);
    });
    proc.on("error",err=>{
      console.error("FBI TV normalizer process error",id,err?.message||err);
    });
    proc.on("exit",(code,signal)=>{
      if(tvTranscoders.get(id)?.proc===proc)tvTranscoders.delete(id);
      console.log("FBI TV H264 normalizer stopped",id,"code",code,"signal",signal||"");
      setTimeout(async()=>{
        try{
          const q=await pool.query("SELECT * FROM tv_streams WHERE id=$1 AND enabled=true",[id]);
          if(q.rowCount&&String(q.rows[0].status)==="live")startTvTranscoder(q.rows[0],0);
        }catch(e){console.error("Normalizer restart check failed",id,e?.message||e)}
      },1500);
    });
  };
  if(delay>0)setTimeout(launch,delay);else launch();
}


function uid(){return crypto.randomUUID()}
function token(n=24){return crypto.randomBytes(n).toString("base64url")}
function cookies(req){const out={};for(const p of String(req.headers.cookie||"").split(";")){const i=p.indexOf("=");if(i>0)out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim())}return out}
function normalizeEmail(v){return String(v||"").trim().toLowerCase()}
function normalizeAnswer(v){return String(v||"").trim().toLowerCase().replace(/\s+/g," ")}
function passwordHash(password){
  const salt=crypto.randomBytes(16).toString("hex");
  const hash=crypto.scryptSync(String(password),salt,64).toString("hex");
  return salt+"$"+hash;
}
function passwordVerify(password,stored){
  try{
    const [salt,hex]=String(stored||"").split("$");
    if(!salt||!hex)return false;
    const actual=crypto.scryptSync(String(password),salt,64);
    const expected=Buffer.from(hex,"hex");
    return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);
  }catch{return false}
}
function cookies(req){const out={};for(const p of String(req.headers.cookie||"").split(";")){const i=p.indexOf("=");if(i>0)out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim())}return out}
function signPayload(payload,purpose){
  const body=Buffer.from(JSON.stringify({...payload,purpose})).toString("base64url");
  const sig=crypto.createHmac("sha256",SESSION_SECRET).update(body).digest("base64url");
  return body+"."+sig;
}
function readSigned(value,purpose){
  const [body,sig]=String(value||"").split(".");
  if(!body||!sig)return null;
  try{
    const expected=crypto.createHmac("sha256",SESSION_SECRET).update(body).digest("base64url");
    if(sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;
    const d=JSON.parse(Buffer.from(body,"base64url").toString("utf8"));
    if(d.purpose!==purpose||Number(d.exp)<=Date.now())return null;
    return d;
  }catch{return null}
}
function signSession(user){return signPayload({uid:user.id,email:user.email,exp:Date.now()+7*86400000},"session")}
function signReset(user){return signPayload({uid:user.id,email:user.email,exp:Date.now()+10*60*1000,nonce:crypto.randomBytes(12).toString("hex")},"reset")}
function setSession(res,user){res.setHeader("Set-Cookie","fbi_tv_session="+encodeURIComponent(signSession(user))+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800")}
function clearSession(res){res.setHeader("Set-Cookie","fbi_tv_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0")}
async function sessionUser(req){
  const d=readSigned(cookies(req).fbi_tv_session,"session");
  if(!d?.uid)return null;
  const q=await pool.query("SELECT id,full_name,email,role,active FROM tv_admin_users WHERE id=$1 AND active=true",[d.uid]);
  return q.rows[0]||null;
}
async function admin(req,res,next){
  try{
    const user=await sessionUser(req);
    if(!user)return res.status(401).json({error:"Unauthorised"});
    req.adminUser=user;
    next();
  }catch(e){
    console.error("Auth middleware failed:",e);
    res.status(500).json({error:"Authentication service unavailable"});
  }
}
const SECURITY_QUESTIONS=[
  "What was the name of your first school?",
  "What city or town were you born in?",
  "What was your childhood nickname?",
  "What was the name of your first pet?",
  "What was your favourite food growing up?",
  "What was the name of your favourite teacher?"
]
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
async function init(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tv_admin_users(
      id uuid PRIMARY KEY,
      full_name text NOT NULL,
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      q1 text NOT NULL,
      a1_hash text NOT NULL,
      q2 text NOT NULL,
      a2_hash text NOT NULL,
      q3 text NOT NULL,
      a3_hash text NOT NULL,
      role text NOT NULL DEFAULT 'admin',
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_login timestamptz
    );
    CREATE INDEX IF NOT EXISTS idx_tv_admin_users_email ON tv_admin_users(email);
    CREATE TABLE IF NOT EXISTS tv_streams(
      id uuid PRIMARY KEY,
      name text NOT NULL,
      title text NOT NULL DEFAULT '',
      description text NOT NULL DEFAULT '',
      stream_key text UNIQUE NOT NULL,
      viewer_token text UNIQUE NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      shared boolean NOT NULL DEFAULT true,
      record_enabled boolean NOT NULL DEFAULT true,
      status text NOT NULL DEFAULT 'offline',
      current_viewers integer NOT NULL DEFAULT 0,
      total_viewers integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_tv_streams_updated ON tv_streams(updated_at DESC);
    CREATE TABLE IF NOT EXISTS tv_mcr_config(
      id smallint PRIMARY KEY CHECK (id=1),
      program_stream_id uuid REFERENCES tv_streams(id) ON DELETE SET NULL,
      preview_stream_id uuid REFERENCES tv_streams(id) ON DELETE SET NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO tv_mcr_config(id,program_stream_id,preview_stream_id) VALUES(1,NULL,NULL) ON CONFLICT (id) DO NOTHING;
  `);
}
function rtmpServer(){
  return RTMP_HOST?"rtmp://"+RTMP_HOST+":"+RTMP_PORT+"/live":"";
}
function hlsForKey(key){
  return MEDIA_BASE?MEDIA_BASE+"/live/"+encodeURIComponent(key)+"/index.m3u8":"";
}
function hlsProxyBase(tokenValue){
  return "/api/public/watch/"+encodeURIComponent(tokenValue)+"/hls/";
}
async function publicStream(tokenValue){
  const q=await pool.query("SELECT * FROM tv_streams WHERE viewer_token=$1 AND enabled=true AND shared=true",[tokenValue]);
  return q.rows[0]||null;
}

app.get("/api/auth/status",async(req,res)=>{
  try{
    const q=await pool.query("SELECT count(*)::int AS count FROM tv_admin_users WHERE active=true");
    res.json({hasAdmin:Number(q.rows[0]?.count||0)>0,securityQuestions:SECURITY_QUESTIONS});
  }catch(e){res.status(500).json({error:"Could not load account status"})}
});
app.post("/api/auth/register",async(req,res)=>{
  try{
    const fullName=String(req.body.fullName||"").trim();
    const email=normalizeEmail(req.body.email);
    const password=String(req.body.password||"");
    const confirm=String(req.body.confirmPassword||"");
    const questions=Array.isArray(req.body.questions)?req.body.questions:[];
    const answers=Array.isArray(req.body.answers)?req.body.answers:[];
    if(fullName.length<2)return res.status(400).json({error:"Enter the administrator's full name."});
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return res.status(400).json({error:"Enter a valid email address."});
    if(password.length<10)return res.status(400).json({error:"Password must be at least 10 characters."});
    if(password!==confirm)return res.status(400).json({error:"Passwords do not match."});
    if(questions.length!==3||answers.length!==3)return res.status(400).json({error:"Choose and answer all three security questions."});
    if(new Set(questions).size!==3||questions.some(q=>!SECURITY_QUESTIONS.includes(String(q))))return res.status(400).json({error:"Choose three different security questions."});
    if(answers.some(a=>normalizeAnswer(a).length<2))return res.status(400).json({error:"Each security answer must contain at least 2 characters."});
    const count=await pool.query("SELECT count(*)::int AS count FROM tv_admin_users WHERE active=true");
    if(Number(count.rows[0]?.count||0)>0)return res.status(403).json({error:"An administrator already exists. Ask an existing administrator to add another account."});
    const id=uid();
    const q=await pool.query("INSERT INTO tv_admin_users(id,full_name,email,password_hash,q1,a1_hash,q2,a2_hash,q3,a3_hash,role) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'admin') RETURNING id,full_name,email,role",
      [id,fullName,email,passwordHash(password),questions[0],passwordHash(normalizeAnswer(answers[0])),questions[1],passwordHash(normalizeAnswer(answers[1])),questions[2],passwordHash(normalizeAnswer(answers[2]))]);
    const user=q.rows[0];
    setSession(res,user);
    res.status(201).json({ok:true,user});
  }catch(e){
    if(e?.code==="23505")return res.status(409).json({error:"An account with that email already exists."});
    console.error("Admin registration failed:",e);
    res.status(500).json({error:"Could not create administrator account."});
  }
});
app.post("/api/auth/login",async(req,res)=>{
  try{
    const email=normalizeEmail(req.body.email);
    const password=String(req.body.password||"");
    const q=await pool.query("SELECT * FROM tv_admin_users WHERE email=$1 AND active=true LIMIT 1",[email]);
    const user=q.rows[0];
    if(!user||!passwordVerify(password,user.password_hash))return res.status(401).json({error:"Invalid email or password."});
    await pool.query("UPDATE tv_admin_users SET last_login=now() WHERE id=$1",[user.id]);
    setSession(res,user);
    res.json({ok:true,user:{id:user.id,full_name:user.full_name,email:user.email,role:user.role}});
  }catch(e){console.error("Login failed:",e);res.status(500).json({error:"Could not sign in."})}
});
app.post("/api/auth/forgot/start",async(req,res)=>{
  try{
    const email=normalizeEmail(req.body.email);
    const q=await pool.query("SELECT id,email,q1,q2,q3 FROM tv_admin_users WHERE email=$1 AND active=true LIMIT 1",[email]);
    if(!q.rowCount)return res.status(404).json({error:"No active FBI TV administrator account was found for that email."});
    const u=q.rows[0];
    res.json({ok:true,resetToken:signReset(u),questions:[u.q1,u.q2,u.q3]});
  }catch(e){console.error("Password recovery start failed:",e);res.status(500).json({error:"Could not start password recovery."})}
});
app.post("/api/auth/forgot/reset",async(req,res)=>{
  try{
    const d=readSigned(req.body.resetToken,"reset");
    if(!d?.uid)return res.status(400).json({error:"This password recovery session has expired. Start again."});
    const answers=Array.isArray(req.body.answers)?req.body.answers:[];
    const password=String(req.body.password||"");
    const confirm=String(req.body.confirmPassword||"");
    if(answers.length!==3)return res.status(400).json({error:"Answer all three security questions."});
    if(password.length<10)return res.status(400).json({error:"New password must be at least 10 characters."});
    if(password!==confirm)return res.status(400).json({error:"Passwords do not match."});
    const q=await pool.query("SELECT id,email,q1,a1_hash,q2,a2_hash,q3,a3_hash,full_name,role FROM tv_admin_users WHERE id=$1 AND active=true LIMIT 1",[d.uid]);
    if(!q.rowCount)return res.status(400).json({error:"Administrator account not found."});
    const u=q.rows[0];
    const ok=[
      passwordVerify(normalizeAnswer(answers[0]),u.a1_hash),
      passwordVerify(normalizeAnswer(answers[1]),u.a2_hash),
      passwordVerify(normalizeAnswer(answers[2]),u.a3_hash)
    ].every(Boolean);
    if(!ok)return res.status(401).json({error:"One or more security answers are incorrect."});
    await pool.query("UPDATE tv_admin_users SET password_hash=$1 WHERE id=$2",[passwordHash(password),u.id]);
    const user={id:u.id,email:u.email,full_name:u.full_name,role:u.role};
    setSession(res,user);
    res.json({ok:true,user});
  }catch(e){console.error("Password reset failed:",e);res.status(500).json({error:"Could not reset the password."})}
});
app.get("/api/auth/me",async(req,res)=>{
  try{
    const user=await sessionUser(req);
    res.json({authenticated:!!user,user:user||null});
  }catch(e){res.status(500).json({error:"Could not verify session"})}
});
app.post("/api/auth/logout",(req,res)=>{clearSession(res);res.json({ok:true})});


function hlsBackends(){
  const raw=[
    "http://fbi-tv-live-ingest:8888",
    process.env.STREAM_HLS_INTERNAL||"",
    MEDIA_BASE
  ];
  const out=[];
  for(const v of raw){
    const x=String(v||"").replace(/\/+$/,"");
    if(x&&!out.includes(x))out.push(x);
  }
  return out;
}
async function fetchPlayback(base,key,sub){
  const clean=String(sub||"index.m3u8").replace(/^\/+?/,"");
  const sourcePath="encoded/"+String(key||"");
  const url=new URL(base+"/"+sourcePath+(clean?"/"+clean:""));
  try{
    const r=await fetch(url,{cache:"no-store",redirect:"follow"});
    return {response:r,sourcePath,backend:base};
  }catch(e){
    return null;
  }
}
async function checkBackendLive(base,key,mode="both"){
  const probes=mode==="live"
    ? ["live/"+String(key||"")]
    : ["encoded/"+String(key||""),"live/"+String(key||"")];
  for(const sourcePath of probes){
    try{
      const r=await fetch(base+"/"+sourcePath+"/index.m3u8",{cache:"no-store"});
      if(!r.ok)continue;
      const t=await r.text();
      if(/#EXTM3U/.test(t))return true;
    }catch{}
  }
  return false;
}
async function refreshStreamStatusRow(row){
  let live=false;
  for(const base of hlsBackends()){
    if(await checkBackendLive(base,row.stream_key,"live")){live=true;break;}
  }
  if(live){
    startTvTranscoder(row,500);
  }else{
    stopTvTranscoder(row.id);
  }
  if(live!==String(row.status||"offline")==="live"){
    await pool.query("UPDATE tv_streams SET status=$1,updated_at=now() WHERE id=$2",[live?"live":"offline",row.id]);
  }
  return {...row,status:live?"live":"offline"};
}
function streamView(row, req, programId, previewId){
  const base=process.env.PUBLIC_BASE_URL||req.protocol+"://"+req.get("host");
  const publicHls="/api/public/watch/"+encodeURIComponent(row.viewer_token)+"/hls/index.m3u8";
  const adminHls="/api/streams/"+encodeURIComponent(row.id)+"/hls/index.m3u8";
  return {
    id:row.id,name:row.name,title:row.title,description:row.description,stream_key:row.stream_key,
    enabled:row.enabled,shared:row.shared,record_enabled:row.record_enabled,status:row.status,
    current_viewers:Number(row.current_viewers||0),total_viewers:Number(row.total_viewers||0),
    rtmp_server:rtmpServer(),
    rtmp_url:rtmpServer()?rtmpServer()+"/"+row.stream_key:"",
    hls_url:adminHls,
    preview_url:adminHls,
    public_hls_url:publicHls,
    viewer_url:base+"/watch/"+row.viewer_token,
    live_url:base+"/live/"+row.id,
    is_program:String(programId||"")===String(row.id),
    is_preview:String(previewId||"")===String(row.id)
  };
}
async function mcrConfig(){
  const q=await pool.query("SELECT * FROM tv_mcr_config WHERE id=1");
  return q.rows[0]||{id:1,program_stream_id:null,preview_stream_id:null};
}

app.get("/api/streams",admin,async(req,res)=>{
  try{
    const cfg=await mcrConfig();
    const q=await pool.query("SELECT * FROM tv_streams ORDER BY updated_at DESC");
    const rows=[];
    for(const row of q.rows)rows.push(await refreshStreamStatusRow(row));
    res.json({streams:rows.map(row=>streamView(row,req,cfg.program_stream_id,cfg.preview_stream_id))});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load live streams"});}
});

app.post("/api/streams",admin,async(req,res)=>{
  try{
    const name=String(req.body.name||"").trim();
    if(!name)return res.status(400).json({error:"Stream name is required"});
    const s={id:uid(),name,title:String(req.body.title||name).trim(),description:String(req.body.description||"").trim(),stream_key:token(18),viewer_token:token(24)};
    const q=await pool.query("INSERT INTO tv_streams(id,name,title,description,stream_key,viewer_token) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[s.id,s.name,s.title,s.description,s.stream_key,s.viewer_token]);
    const cfg=await mcrConfig();
    const row=await refreshStreamStatusRow(q.rows[0]);
    res.status(201).json({stream:streamView(row,req,cfg.program_stream_id,cfg.preview_stream_id)});
  }catch(e){console.error("Stream create failed:",e);res.status(500).json({error:"Could not create stream"});}
});

app.get("/api/streams/:id",admin,async(req,res)=>{
  try{
    const q=await pool.query("SELECT * FROM tv_streams WHERE id=$1",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Stream not found"});
    const cfg=await mcrConfig();
    const row=await refreshStreamStatusRow(q.rows[0]);
    res.json({stream:streamView(row,req,cfg.program_stream_id,cfg.preview_stream_id)});
  }catch(e){res.status(500).json({error:"Could not load stream"});}
});

app.patch("/api/streams/:id",admin,async(req,res)=>{
  try{
    const fields=[],vals=[];
    for(const k of ["name","title","description","shared","record_enabled","enabled"]){
      if(req.body[k]!==undefined){
        vals.push(k==="shared"||k==="record_enabled"||k==="enabled"?Boolean(req.body[k]):String(req.body[k]??"").trim().slice(0,2000));
        fields.push(k+"=$"+vals.length);
      }
    }
    if(!fields.length)return res.status(400).json({error:"Nothing to update"});
    vals.push(req.params.id);
    const q=await pool.query("UPDATE tv_streams SET "+fields.join(",")+",updated_at=now() WHERE id=$"+vals.length+" RETURNING *",vals);
    if(!q.rowCount)return res.status(404).json({error:"Stream not found"});
    const cfg=await mcrConfig();
    const row=await refreshStreamStatusRow(q.rows[0]);
    res.json({stream:streamView(row,req,cfg.program_stream_id,cfg.preview_stream_id)});
  }catch(e){console.error("Stream update failed:",e);res.status(500).json({error:"Could not update stream"});}
});

app.post("/api/streams/:id/regenerate-key",admin,async(req,res)=>{
  try{
    const key=token(18);
    const q=await pool.query("UPDATE tv_streams SET stream_key=$1,status='offline',updated_at=now() WHERE id=$2 RETURNING *",[key,req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Stream not found"});
    const cfg=await mcrConfig();
    res.json({stream:streamView(q.rows[0],req,cfg.program_stream_id,cfg.preview_stream_id)});
  }catch(e){res.status(500).json({error:"Could not regenerate stream key"});}
});

app.delete("/api/streams/:id",admin,async(req,res)=>{
  try{
    const q=await pool.query("DELETE FROM tv_streams WHERE id=$1 RETURNING id",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Stream not found"});
    await pool.query("UPDATE tv_mcr_config SET program_stream_id=NULL,preview_stream_id=NULL,updated_at=now() WHERE id=1 AND (program_stream_id=$1 OR preview_stream_id=$1)",[req.params.id]);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:"Could not delete stream"});}
});

app.get("/api/mcr/overview",admin,async(req,res)=>{
  try{
    const cfg=await mcrConfig();
    const q=await pool.query("SELECT * FROM tv_streams WHERE enabled=true ORDER BY created_at ASC");
    const sources=[];
    for(const row of q.rows){
      const fresh=await refreshStreamStatusRow(row);
      sources.push(streamView(fresh,req,cfg.program_stream_id,cfg.preview_stream_id));
    }
    const program=sources.find(x=>String(x.id)===String(cfg.program_stream_id))||null;
    const preview=sources.find(x=>String(x.id)===String(cfg.preview_stream_id))||null;
    res.json({sources,program,preview,program_url:(process.env.PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/program"});
  }catch(e){console.error("MCR overview failed:",e);res.status(500).json({error:"Could not load MCR"});}
});

app.post("/api/mcr/preview",admin,async(req,res)=>{
  try{
    const id=String(req.body.streamId||"");
    if(id){
      const q=await pool.query("SELECT id FROM tv_streams WHERE id=$1 AND enabled=true",[id]);
      if(!q.rowCount)return res.status(404).json({error:"Input source not found"});
    }
    const q=await pool.query("UPDATE tv_mcr_config SET preview_stream_id=$1,updated_at=now() WHERE id=1 RETURNING *",[id||null]);
    res.json({ok:true,preview_stream_id:q.rows[0].preview_stream_id||null});
  }catch(e){res.status(500).json({error:"Could not set preview source"});}
});

app.get("/api/mcr/program",admin,async(req,res)=>{
  try{
    const cfg=await mcrConfig();
    const q=cfg.program_stream_id?await pool.query("SELECT * FROM tv_streams WHERE id=$1 AND enabled=true",[cfg.program_stream_id]):{rowCount:0,rows:[]};
    const row=q.rowCount?await refreshStreamStatusRow(q.rows[0]):null;
    res.json({program:row?streamView(row,req,cfg.program_stream_id,cfg.preview_stream_id):null,program_url:(process.env.PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/program"});
  }catch(e){res.status(500).json({error:"Could not load program output"});}
});

app.post("/api/mcr/program",admin,async(req,res)=>{
  try{
    const id=String(req.body.streamId||"");
    if(id){
      const q=await pool.query("SELECT * FROM tv_streams WHERE id=$1 AND enabled=true",[id]);
      if(!q.rowCount)return res.status(404).json({error:"Program source not found"});
    }
    const q=await pool.query("UPDATE tv_mcr_config SET program_stream_id=$1,updated_at=now() WHERE id=1 RETURNING *",[id||null]);
    const row=id?(await pool.query("SELECT * FROM tv_streams WHERE id=$1",[id])).rows[0]:null;
    const fresh=row?await refreshStreamStatusRow(row):null;
    res.json({ok:true,program:fresh?streamView(fresh,req,q.rows[0].program_stream_id,q.rows[0].preview_stream_id):null,program_url:(process.env.PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/program"});
  }catch(e){console.error("Program switch failed:",e);res.status(500).json({error:"Could not change program source"});}
});

app.post("/api/mediamtx/auth",async(req,res)=>{
  try{
    const action=String(req.body.action||"");
    const pathValue=String(req.body.path||"").replace(/^\/+|\/+$/g,"");
    const presentedToken=String(req.body.token||"");
    const presentedPassword=String(req.body.password||"");
    if(!pathValue)return res.status(401).end();

    // Match the proven Client File Studio authentication behavior:
    // resolve the parent stream path and allow the exact publish path
    // without requiring OBS/vMix to send a separate password.
    const q=await pool.query(
      "SELECT * FROM tv_streams WHERE stream_key=$1 LIMIT 1",
      [pathValue.replace(/^live\//,"").split("/")[0]]
    );
    if(!q.rowCount)return res.status(403).end();
    const stream=q.rows[0];
    const parentPath="live/"+stream.stream_key;
    const isExactPublishPath=pathValue===parentPath;
    const isStreamDescendant=pathValue.startsWith(parentPath+"/");

    if(action==="publish"){
      if(!stream.enabled)return res.status(403).end();
      const isEncodedPublish=pathValue==="encoded/"+stream.stream_key;
      if(isExactPublishPath){
        await pool.query("UPDATE tv_streams SET status='live',updated_at=now() WHERE id=$1",[stream.id]);
        startTvTranscoder(stream,700);
        return res.status(200).end();
      }
      if(isEncodedPublish && presentedPassword===stream.stream_key){
        return res.status(200).end();
      }
      if(isStreamDescendant && (presentedPassword===stream.stream_key || presentedToken===stream.stream_key)){
        return res.status(200).end();
      }
      return res.status(403).end();
    }

    if(action==="read"||action==="playback"){
      if(!stream.enabled||!stream.shared)return res.status(403).end();
      return res.status(200).end();
    }

    if(action==="api"||action==="metrics"||action==="pprof")return res.status(200).end();
    return res.status(403).end();
  }catch(e){
    console.error("MediaMTX auth failed:",e);
    res.status(500).end();
  }
});

app.get("/api/public/watch/:token/status",async(req,res)=>{
  const s=await publicStream(req.params.token);
  if(!s)return res.status(404).json({error:"Watch link is invalid or disabled."});
  let live=false;
  for(const base of hlsBackends()){
    if(await checkBackendLive(base,s.stream_key)){live=true;break;}
  }
  if(live!==("".concat(s.status)==="live")){
    await pool.query("UPDATE tv_streams SET status=$1,updated_at=now() WHERE id=$2",[live?"live":"offline",s.id]).catch(()=>{});
  }
  res.json({live,title:s.title,name:s.name,current_viewers:Number(s.current_viewers||0),hls_url:hlsProxyBase(req.params.token)});
});

async function proxyTvHlsStream(req,res,opts){
  try{
    const id=opts.id?String(opts.id):"";
    const tokenValue=opts.token?String(opts.token):"";
    let row=null;
    if(id){
      const q=await pool.query("SELECT * FROM tv_streams WHERE id=$1 AND enabled=true",[id]);
      if(!q.rowCount)return res.status(404).end();
      row=q.rows[0];
    }else{
      row=await publicStream(tokenValue);
      if(!row)return res.status(404).end();
    }

    let sub=String(req.path||"/").replace(/^\/+?/,"");
    if(/^index\.m3u8\/index\.m3u8$/i.test(sub))sub="index.m3u8";
    else if(/^index\.m3u8\//i.test(sub))sub=sub.slice("index.m3u8/".length);

    const cookieName=opts.cookieName;
    const proxyBase=opts.proxyBase;
    const incomingCookies=String(req.headers.cookie||"");
    const cookiePattern=new RegExp("(?:^|;\\s*)"+cookieName+"=([^;]+)");
    const rawSession=(incomingCookies.match(cookiePattern)||[])[1]||"";
    const proxySession=rawSession?decodeURIComponent(rawSession):"";

    let selected=null;
    let lastResponse=null;
    for(const base of hlsBackends()){
      const got=await fetchPlayback(base,row.stream_key,sub);
      if(!got)continue;
      selected=got;
      lastResponse=got.response;
      if(got.response.ok)break;
      if(got.response.status!==404&&got.response.status!==401&&got.response.status!==403)break;
    }
    if(!selected||!lastResponse)return res.status(502).json({error:"Live stream playback unavailable."});

    const sourcePath=selected.sourcePath;
    const upstream=new URL(selected.backend+"/"+sourcePath+(sub?"/"+sub:""));
    if(proxySession&&!upstream.searchParams.has("session"))upstream.searchParams.set("session",proxySession);
    if(sub==="index.m3u8"&&!upstream.searchParams.has("session"))upstream.searchParams.set("cookieCheck","1");
    const response=await fetch(upstream,{redirect:"follow",cache:"no-store"});
    const type=response.headers.get("content-type")||"application/octet-stream";
    let body=Buffer.from(await response.arrayBuffer());
    if(!response.ok)return res.status(response.status).type(type).send(body);

    if(type.toLowerCase().includes("mpegurl")){
      let textBody=body.toString("utf8");
      let session="";
      const setCookies=typeof response.headers.getSetCookie==="function"
        ? response.headers.getSetCookie()
        : String(response.headers.get("set-cookie")||"").split(/,(?=\s*\w+=)/);
      for(const sc of setCookies){
        const m=String(sc).match(/(?:^|;\s*)hlsSession=([^;]+)/i);
        if(m){session=m[1];break;}
      }
      session=session||upstream.searchParams.get("session")||"";

      const proxyUri=(raw)=>{
        const value=String(raw||"").trim();
        if(!value)return value;
        try{
          const absolute=/^https?:\/\//i.test(value)?new URL(value):null;
          let pathname=absolute?absolute.pathname:value.split("?")[0];
          let query=absolute?absolute.search:(value.includes("?")?"?"+value.split("?").slice(1).join("?"):"");
          const marker="/"+sourcePath+"/";
          const markerIndex=pathname.indexOf(marker);
          if(markerIndex>=0)pathname=pathname.slice(markerIndex+marker.length);
          pathname=pathname.replace(/^\/+?/,"");
          const url=proxyBase+pathname;
          const sp=new URLSearchParams(query.replace(/^\?/,""));
          if(session&&!sp.has("session"))sp.set("session",session);
          const suffix=sp.toString();
          return url+(suffix?"?"+suffix:"");
        }catch{return value}
      };

      textBody=textBody.split(/\r?\n/).map(line=>{
        const trimmed=line.trim();
        if(!trimmed)return line;
        if(/^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|MAP):/i.test(trimmed)){
          return line.replace(/URI="([^"]+)"/gi,(_,uri)=>'URI="'+proxyUri(uri)+'"');
        }
        if(trimmed[0]==="#")return line;
        return proxyUri(trimmed);
      }).join("\\n");
      body=Buffer.from(textBody,"utf8");
      if(session){
        res.setHeader("Set-Cookie",cookieName+"="+encodeURIComponent(session)+"; Path="+proxyBase.replace(/index\.m3u8$/,"")+"; HttpOnly; Secure; SameSite=Lax; Max-Age=1800");
      }
    }

    res.status(200)
      .set("Cache-Control",type.toLowerCase().includes("mpegurl")?"no-store, no-cache, must-revalidate":"no-cache")
      .type(type)
      .send(body);
  }catch(e){
    console.error("TV HLS proxy error:",e?.stack||e);
    res.status(502).json({error:"Live stream playback proxy unavailable."});
  }
}

app.use("/api/streams/:id/hls",admin,async(req,res)=>{
  const id=String(req.params.id||"");
  await proxyTvHlsStream(req,res,{id,cookieName:"fbi_hls_session",proxyBase:"/api/streams/"+encodeURIComponent(id)+"/hls/"});
});

app.use("/api/public/watch/:token/hls",async(req,res)=>{
  const tokenValue=String(req.params.token||"");
  await proxyTvHlsStream(req,res,{token:tokenValue,cookieName:"fbi_public_hls_session",proxyBase:"/api/public/watch/"+encodeURIComponent(tokenValue)+"/hls/"});
});

app.post("/api/public/watch/:token/heartbeat",async(req,res)=>{
  const s=await publicStream(req.params.token);if(!s)return res.status(404).end();
  await pool.query("UPDATE tv_streams SET current_viewers=GREATEST(0,current_viewers+0),total_viewers=GREATEST(total_viewers,0),updated_at=now() WHERE id=$1",[s.id]);
  res.json({ok:true});
});


async function selectedProgram(){
  const cfg=await mcrConfig();
  if(!cfg.program_stream_id)return null;
  const q=await pool.query("SELECT * FROM tv_streams WHERE id=$1 AND enabled=true AND shared=true",[cfg.program_stream_id]);
  return q.rowCount?q.rows[0]:null;
}
app.get("/api/public/program/status",async(req,res)=>{
  try{
    const row=await selectedProgram();
    if(!row)return res.json({live:false,program:null,hls_url:"/api/public/program/hls/index.m3u8"});
    const fresh=await refreshStreamStatusRow(row);
    res.json({live:fresh.status==="live",program:{id:fresh.id,name:fresh.name,title:fresh.title,current_viewers:Number(fresh.current_viewers||0)},hls_url:"/api/public/program/hls/index.m3u8"});
  }catch(e){res.status(500).json({error:"Program status unavailable"});}
});

app.use("/api/public/program/hls",async(req,res)=>{
  try{
    const row=await selectedProgram();
    if(!row)return res.status(404).end();
    await proxyTvHlsStream(req,res,{id:row.id,cookieName:"fbi_program_hls_session",proxyBase:"/api/public/program/hls/"});
  }catch(e){
    console.error("Program HLS proxy failed:",e?.stack||e);
    res.status(502).end();
  }
});

app.get("/watch/program",async(req,res)=>{
  res.type("html").send("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>FBI TV Program</title><script src=\"https://cdn.jsdelivr.net/npm/hls.js@latest\"></script><style>body{margin:0;background:#08090b;color:#f5f5f7;font-family:Inter,system-ui,sans-serif}.wrap{max-width:1400px;margin:auto;padding:24px}.brand{color:#e8c448;font-size:12px;letter-spacing:.16em;text-transform:uppercase}.title{font-size:28px;font-weight:900;margin-top:8px}.meta{color:#9b9ba4;font-size:12px;margin:6px 0 18px}.player{background:#000;border:1px solid #2a2a2d;border-radius:18px;overflow:hidden}.player video{width:100%;display:block;aspect-ratio:16/9;background:#000}.offline{min-height:460px;display:grid;place-items:center;color:#aaa;font-size:14px;text-align:center}.foot{color:#666;font-size:10px;text-align:center;padding:18px}</style></head><body><div class=\"wrap\"><div class=\"brand\">FILM BEYOND IMAGINATION • FBI TV</div><div class=\"title\">PROGRAM</div><div class=\"meta\" id=\"meta\">Connecting…</div><div class=\"player\"><video id=\"video\" controls autoplay muted playsinline></video><div id=\"offline\" class=\"offline\" style=\"display:none\">No program source is currently selected.</div></div><div class=\"foot\">FBI TV • Official Program Output</div></div><script>const video=document.getElementById('video'),offline=document.getElementById('offline'),meta=document.getElementById('meta');let hls=null,current='';function stop(){if(hls){try{hls.destroy()}catch{}hls=null}video.pause();video.removeAttribute('src');video.load()}function start(url){stop();video.style.display='block';offline.style.display='none';if(window.Hls&&Hls.isSupported()){hls=new Hls({enableWorker:true,lowLatencyMode:false,liveSyncDurationCount:3,liveMaxLatencyDurationCount:6,maxBufferLength:30,maxMaxBufferLength:60,backBufferLength:90});hls.loadSource(url);hls.attachMedia(video);hls.on(Hls.Events.MANIFEST_PARSED,()=>video.play().catch(()=>{}));hls.on(Hls.Events.ERROR,(_,d)=>{if(d&&d.fatal){setTimeout(()=>{if(current)start(url)},1500)}})}else{video.src=url;video.play().catch(()=>{})}}async function refresh(){try{const r=await fetch('/api/public/program/status',{cache:'no-store'}),d=await r.json();meta.textContent=d.program?(d.live?'● LIVE • '+d.program.title:'OFFLINE • '+d.program.title):'NO PROGRAM SOURCE';if(d.live){if(current!==d.program.id){current=d.program.id;start(d.hls_url)}}else{if(current){current='';stop()}video.style.display='none';offline.style.display='grid'}}catch(e){meta.textContent='PROGRAM UNAVAILABLE'}}refresh();setInterval(refresh,5000)</script></body></html>");
});app.get("/live/:id",admin,async(req,res)=>{
  try{
    const q=await pool.query("SELECT id FROM tv_streams WHERE id=$1 AND enabled=true",[req.params.id]);
    if(!q.rowCount)return res.status(404).send("Live stream not found.");
    res.redirect(302,"/?stream="+encodeURIComponent(q.rows[0].id));
  }catch(e){
    console.error("Live studio route failed:",e);
    res.status(500).send("Could not open live stream.");
  }
});

app.get("/watch/:token",async(req,res)=>{
  const s=await publicStream(req.params.token);if(!s)return res.status(404).send("Watch link is invalid or disabled.");
  const title=esc(s.title||s.name), tvBase=process.env.PUBLIC_BASE_URL||req.protocol+"://"+req.get("host");
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} • FBI TV</title><script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script><style>
body{margin:0;background:#09090a;color:#f6f6f7;font-family:Inter,system-ui,sans-serif}.wrap{max-width:1200px;margin:auto;padding:24px}.brand{color:#e8c448;font-size:12px;letter-spacing:.16em;text-transform:uppercase}.title{font-size:28px;font-weight:800;margin:8px 0}.meta{color:#9b9ba4;font-size:12px;margin-bottom:16px}.player{background:#000;border:1px solid #26262a;border-radius:18px;overflow:hidden}.player video{width:100%;display:block;aspect-ratio:16/9;background:#000}.offline{min-height:420px;display:grid;place-items:center;color:#aaa;text-align:center;padding:20px}.foot{color:#666;font-size:10px;text-align:center;padding:18px}</style></head><body><div class="wrap"><div class="brand">FILM BEYOND IMAGINATION • FBI TV</div><div class="title">${title}</div><div class="meta" id="meta">Checking live status…</div><div class="player"><video id="video" controls playsinline autoplay muted></video><div id="offline" class="offline" style="display:none">Waiting for the broadcast to start…</div></div><div class="foot">FBI TV • Live broadcast</div></div><script>
const token=${JSON.stringify(req.params.token)},video=document.getElementById("video"),offline=document.getElementById("offline"),meta=document.getElementById("meta");let player=null,live=false;
function stop(){if(player){try{player.destroy()}catch{}player=null}video.pause();video.removeAttribute("src");video.load()}
function start(url){stop();video.style.display="block";offline.style.display="none";if(window.Hls&&Hls.isSupported()){player=new Hls({enableWorker:true,lowLatencyMode:false,liveSyncDurationCount:3,liveMaxLatencyDurationCount:6,maxBufferLength:30,maxMaxBufferLength:60,backBufferLength:90});player.on(Hls.Events.ERROR,(_,d)=>{if(d&&d.fatal){setTimeout(()=>{if(live)start(url)},1800)}});player.loadSource(url);player.attachMedia(video);player.on(Hls.Events.MANIFEST_PARSED,()=>video.play().catch(()=>{}));return}video.src=url;video.play().catch(()=>{})}
async function refresh(){try{const r=await fetch("/api/public/watch/"+encodeURIComponent(token)+"/status",{cache:"no-store"}),d=await r.json();if(!r.ok)throw new Error(d.error);meta.textContent=d.live?"● LIVE":"OFFLINE";if(d.live){if(!live){live=true;start(d.hls_url+"index.m3u8")} }else{if(live){live=false;stop()}video.style.display="none";offline.style.display="grid"}}catch(e){meta.textContent="STREAM UNAVAILABLE"}}
refresh();setInterval(refresh,8000);
</script></body></html>`);
});

const index=path.join(__dirname,"public/index.html");
app.use(express.static(path.join(__dirname,"public")));
app.get("/",(req,res)=>res.sendFile(index));
init().then(()=>app.listen(PORT,()=>console.log("FBI TV Control listening on port "+PORT))).catch(e=>{console.error(e);process.exit(1)});
