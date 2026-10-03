const express=require("express");
const Busboy=require("busboy");
const {Pool}=require("pg");
const crypto=require("crypto");
const fs=require("fs");
const fsp=fs.promises;
const path=require("path");
const {spawn}=require("child_process");
let ffmpegPath="";try{ffmpegPath=require("ffmpeg-static")||""}catch(e){console.warn("ffmpeg-static is unavailable; video thumbnails will use fallback cards.")}
const {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand,DeleteObjectsCommand,HeadObjectCommand,CreateMultipartUploadCommand,UploadPartCommand,CompleteMultipartUploadCommand,AbortMultipartUploadCommand,ListPartsCommand,PutBucketCorsCommand}=require("@aws-sdk/client-s3");
const {Upload}=require("@aws-sdk/lib-storage");
const {getSignedUrl}=require("@aws-sdk/s3-request-presigner");
const sharp=require("sharp");
const thumbnailCache=new Map();
const THUMB_CACHE_MAX=300;
const THUMB_CACHE_TTL=30*60*1000;
function getThumbCache(key){
  const v=thumbnailCache.get(key);
  if(!v)return null;
  if(v.expires<Date.now()){thumbnailCache.delete(key);return null;}
  thumbnailCache.delete(key);thumbnailCache.set(key,v);
  return v;
}
function setThumbCache(key,buffer){
  // cache helper remains unchanged; media-aware thumbnail helpers follow below.

  thumbnailCache.set(key,{buffer,expires:Date.now()+THUMB_CACHE_TTL});
  while(thumbnailCache.size>THUMB_CACHE_MAX)thumbnailCache.delete(thumbnailCache.keys().next().value);
  return buffer;
}


function thumbKind(file){
  const mime=String(file?.mime_type||"").toLowerCase();
  if(/^image\//.test(mime))return"image";
  if(/^video\//.test(mime))return"video";
  if(/^audio\//.test(mime))return"audio";
  return"document";
}
function thumbExt(name){
  return String(name||"").split(".").pop().toLowerCase().replace(/[^a-z0-9+#-]/g,"").slice(0,8).toUpperCase()||"FILE";
}
function thumbDocFamily(name,mime){
  const ext=thumbExt(name);
  const m=String(mime||"").toLowerCase();
  if(ext==="PDF"||m==="application/pdf")return"PDF";
  if(["DOC","DOCX","ODT","RTF","TXT"].includes(ext))return ext;
  if(["XLS","XLSX","ODS","CSV"].includes(ext))return ext;
  if(["PPT","PPTX","ODP"].includes(ext))return ext;
  if(["ZIP","RAR","7Z"].includes(ext)||/zip|rar|7z/.test(m))return ext;
  return ext||"FILE";
}
function thumbXml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}
function documentThumbSvg(file,width){
  const ext=thumbDocFamily(file?.original_name,file?.mime_type);
  const rawName=String(file?.original_name||"Document");
  const base=rawName.split("/").pop()||rawName;
  const label=base.length>26?base.slice(0,23)+"…":base;
  const family=ext==="PDF"?"PDF":(["DOC","DOCX","ODT","RTF","TXT"].includes(ext)?"DOCUMENT":(["XLS","XLSX","ODS","CSV"].includes(ext)?"SPREADSHEET":(["PPT","PPTX","ODP"].includes(ext)?"PRESENTATION":(["ZIP","RAR","7Z"].includes(ext)?"ARCHIVE":"FILE"))));
  const w=Math.max(240,Math.min(900,Number(width)||360)),h=Math.round(w*1.25);
  const line1=label.length>18?label.slice(0,18)+"…":label;
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'">'+
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#171719"/><stop offset="1" stop-color="#0b0b0d"/></linearGradient></defs>'+
    '<rect width="100%" height="100%" rx="24" fill="url(#bg)"/>'+
    '<rect x="18" y="18" width="'+(w-36)+'" height="'+(h-36)+'" rx="18" fill="#f3f1eb"/>'+
    '<path d="M '+(w-112)+' 18 V 112 H '+(w-18)+'" fill="#e8e5de"/>'+
    '<path d="M '+(w-112)+' 18 L '+(w-18)+' 112 H '+(w-112)+' Z" fill="#d4d0c6"/>'+
    '<rect x="42" y="56" width="'+Math.min(72,w-84)+'" height="8" rx="4" fill="#c7a53d"/>'+
    '<rect x="42" y="78" width="'+Math.min(150,w-84)+'" height="6" rx="3" fill="#b3b0aa"/>'+
    '<rect x="42" y="108" width="'+Math.min(132,w-84)+'" height="6" rx="3" fill="#c6c3bd"/>'+
    '<rect x="42" y="150" width="'+Math.min(190,w-84)+'" height="10" rx="5" fill="#242428"/>'+
    '<rect x="42" y="172" width="'+Math.min(220,w-84)+'" height="7" rx="3.5" fill="#cac8c3"/>'+
    '<rect x="42" y="188" width="'+Math.min(198,w-84)+'" height="7" rx="3.5" fill="#d4d1cb"/>'+
    '<rect x="42" y="'+(h-132)+'" width="'+Math.min(138,w-84)+'" height="48" rx="12" fill="#171719"/>'+
    '<text x="62" y="'+(h-101)+'" font-family="Arial,Helvetica,sans-serif" font-size="18" font-weight="800" fill="#e7c75d">'+thumbXml(ext)+'</text>'+
    '<text x="42" y="'+(h-58)+'" font-family="Arial,Helvetica,sans-serif" font-size="14" font-weight="700" fill="#55545a">'+thumbXml(family)+'</text>'+
    '<text x="'+(w-42)+'" y="'+(h-58)+'" text-anchor="end" font-family="Arial,Helvetica,sans-serif" font-size="11" font-weight="700" fill="#8b8984">'+thumbXml(line1)+'</text>'+
  '</svg>');
}
function audioThumbSvg(file,width){
  const ext=thumbExt(file?.original_name);
  const w=Math.max(240,Math.min(900,Number(width)||360)),h=Math.round(w*0.56);
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">'+
    '<rect width="100%" height="100%" rx="24" fill="#101012"/><circle cx="'+(w/2)+'" cy="'+(h/2-6)+'" r="'+Math.min(58,h*.25)+'" fill="#c7a53d"/>'+
    '<path d="M '+(w/2-16)+' '+(h/2-28)+' L '+(w/2+18)+' '+(h/2-8)+' L '+(w/2-16)+' '+(h/2+12)+' Z" fill="#101012"/>'+
    '<text x="'+(w/2)+'" y="'+(h-20)+'" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="13" font-weight="800" fill="#efefef">'+thumbXml(ext)+'</text></svg>');
}
function runFfmpegPoster(url,seekSeconds){
  return new Promise((resolve,reject)=>{
    if(!ffmpegPath)return reject(new Error("FFmpeg is not available"));
    const args=["-hide_banner","-loglevel","error","-ss",String(seekSeconds),"-i",url,"-frames:v","1","-vf","scale=1280:-2:flags=lanczos","-q:v","5","-f","image2pipe","-vcodec","mjpeg","pipe:1"];
    const child=spawn(ffmpegPath,args,{stdio:["ignore","pipe","pipe"]});
    const chunks=[];let errText="";let settled=false;
    const finish=(err,val)=>{if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve(val)};
    const timer=setTimeout(()=>{try{child.kill("SIGKILL")}catch{}finish(new Error("Video thumbnail generation timed out"))},45000);
    child.stdout.on("data",c=>chunks.push(c));
    child.stderr.on("data",c=>{errText+=String(c||"")});
    child.on("error",e=>finish(e));
    child.on("close",(code,signal)=>{
      if(code===0&&chunks.length)return finish(null,Buffer.concat(chunks));
      finish(new Error(errText.trim()||("FFmpeg exited with code "+String(code||signal||"unknown"))));
    });
  });
}
async function generateThumbnail(file,width,height){
  const kind=thumbKind(file);
  if(kind==="document")return sharp(documentThumbSvg(file,width)).webp({quality:86,method:4}).toBuffer();
  if(kind==="audio")return sharp(audioThumbSvg(file,width)).webp({quality:84,method:4}).toBuffer();
  if(kind==="video"){
    try{
      const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:file.storage_path}),{expiresIn:300});
      let frame;
      try{frame=await runFfmpegPoster(url,5)}catch(_e1){try{frame=await runFfmpegPoster(url,1)}catch(_e2){frame=await runFfmpegPoster(url,0)}}
      return sharp(frame).rotate().resize({width:width,height:height,fit:"inside",withoutEnlargement:true}).webp({quality:76,method:4}).toBuffer();
    }catch(e){
      console.warn("Video thumbnail fallback:",file?.original_name,e?.message||e);
      return sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+Math.round(width*9/16)+'"><rect width="100%" height="100%" fill="#101012"/><circle cx="'+(width/2)+'" cy="'+(Math.round(width*9/16)/2)+'" r="'+Math.min(60,width*.15)+'" fill="#c7a53d"/><path d="M '+(width/2-16)+' '+(Math.round(width*9/16)/2-24)+' L '+(width/2+22)+' '+(Math.round(width*9/16)/2)+' L '+(width/2-16)+' '+(Math.round(width*9/16)/2+24)+' Z" fill="#101012"/></svg>')).webp({quality:84,method:4}).toBuffer();
    }
  }
  const obj=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:file.storage_path}));
  const input=obj.Body?.transformToByteArray?Buffer.from(await obj.Body.transformToByteArray()):Buffer.from(await new Promise((resolve,reject)=>{const chunks=[];obj.Body.on("data",c=>chunks.push(c));obj.Body.on("end",()=>resolve(Buffer.concat(chunks)));obj.Body.on("error",reject)}));
  return sharp(input).rotate().resize({width:width,height:height,fit:"inside",withoutEnlargement:true}).webp({quality:68,method:4}).toBuffer();
}

const app=express();
const PORT=Number(process.env.PORT||3000);
const ROOT=path.join(__dirname,"site");
const ADMIN_EMAIL=(process.env.ADMIN_EMAIL||"filmbyfbi@gmail.com").trim().toLowerCase();
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";
const SESSION_SECRET=process.env.SESSION_SECRET||crypto.randomBytes(32).toString("hex");
const PUBLIC_BASE_URL=(process.env.PUBLIC_BASE_URL||"").replace(/\/+$/,"");
const MAX_FILE_SIZE=5*1000*1000*1000*1000;
const STORAGE_QUOTA_BYTES=Number(process.env.STORAGE_QUOTA_BYTES||100000000000000);
const MIN_PART_SIZE=16*1024*1024;
const TURBO_PART_SIZE=16*1024*1024;
const MAX_PARTS=10000;
const PRESIGN_SECONDS=24*60*60;
const UPLOAD_PROTOCOL_VERSION=4;

const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?{rejectUnauthorized:false}:false});

function uid(){return crypto.randomUUID()}
function token(){return crypto.randomBytes(24).toString("base64url")}
function safeName(name){
  const ext=path.extname(name);
  const base=path.basename(name,ext).replace(/[^a-zA-Z0-9._-]+/g,"_").replace(/^\.+/,"").slice(0,140)||"file";
  return base+ext;
}
function cookies(req){const out={};for(const p of String(req.headers.cookie||"").split(";")){const i=p.indexOf("=");if(i>0)out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim())}return out}
function session(email){
  const exp=Date.now()+604800000;
  const payload=Buffer.from(JSON.stringify({email,exp})).toString("base64url");
  const sig=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
  return payload+"."+sig;
}
function validSession(req){
  const s=cookies(req).fbi_session;if(!s)return false;
  const [payload,sig]=s.split(".");if(!payload||!sig)return false;
  const expected=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
  try{
    if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return false;
    const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
    return data.email===ADMIN_EMAIL&&Number(data.exp)>Date.now();
  }catch{return false}
}
function admin(req,res,next){if(!validSession(req))return res.status(401).json({error:"Unauthorised"});next()}
function userSession(user){
  const exp=Date.now()+30*86400000;
  const payload=Buffer.from(JSON.stringify({uid:user.id,email:user.email,exp:exp})).toString("base64url");
  const sig=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
  return payload+"."+sig;
}
function validUserSession(req){
  const s=cookies(req).fbi_user_session;if(!s)return null;
  const parts=s.split("."),payload=parts[0],sig=parts[1];if(!payload||!sig)return null;
  try{
    const expected=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
    if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;
    const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
    if(!data.uid||!data.email||Number(data.exp)<=Date.now())return null;
    return {id:String(data.uid),email:String(data.email).toLowerCase()};
  }catch{return null}
}
function portalUser(req,res,next){
  const u=validUserSession(req);
  if(!u)return res.status(401).json({error:"Please log in to your account."});
  req.portalUser=u;next();
}
async function hashUserPassword(password){
  const N=32768,r=8,p=1,salt=crypto.randomBytes(16);
  const derived=await new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,{N:N,r:r,p:p,maxmem:256*1024*1024},(e,d)=>e?reject(e):resolve(d)));
  return "scrypt$"+N+"$"+r+"$"+p+"$"+salt.toString("base64")+"$"+Buffer.from(derived).toString("base64");
}
async function userPasswordMatches(password,stored){
  try{
    const parts=String(stored||"").split("$"),prefix=parts[0],N=parts[1],r=parts[2],p=parts[3],salt=parts[4],hash=parts[5];
    if(prefix!=="scrypt"||!N||!r||!p||!salt||!hash)return false;
    const derived=await new Promise((resolve,reject)=>crypto.scrypt(password,Buffer.from(salt,"base64"),64,{N:Number(N),r:Number(r),p:Number(p),maxmem:256*1024*1024},(e,d)=>e?reject(e):resolve(d)));
    const actual=Buffer.from(hash,"base64");
    return actual.length===derived.length&&crypto.timingSafeEqual(actual,derived);
  }catch{return false}
}
async function portalProjectOwned(userId,projectId){
  const r=await pool.query("SELECT * FROM projects WHERE id=$1 AND owner_id=$2",[projectId,userId]);
  return r.rows[0]||null;
}
function clientIp(req){return String(req.headers["x-forwarded-for"]||req.socket.remoteAddress||"").split(",")[0].trim().slice(0,120)}
function s3Ready(){return Boolean(process.env.S3_BUCKET&&process.env.S3_ENDPOINT&&process.env.S3_ACCESS_KEY_ID&&process.env.S3_SECRET_ACCESS_KEY&&process.env.S3_REGION)}
const s3=s3Ready()?new S3Client({
  region:process.env.S3_REGION,
  endpoint:process.env.S3_ENDPOINT,
  forcePathStyle:false,
  credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY}
}):null;
const bucket=()=>process.env.S3_BUCKET;

function choosePartSize(size){
  // Use 16 MiB parts as the normal floor. This keeps multipart requests
  // reasonably large for throughput while staying well below the 10,000-part
  // limit for the application's multi-terabyte file ceiling.
  var part=MIN_PART_SIZE;
  while(Math.ceil(size/part)>MAX_PARTS) part*=2;
  return part;
}
async function headObjectWithRetry(input,attempts=8,baseDelay=400){
  var last=null;
  for(var i=0;i<attempts;i++){
    try{
      return await s3.send(new HeadObjectCommand(input));
    }catch(e){
      last=e;
      if(i<attempts-1)await new Promise(function(resolve){setTimeout(resolve,baseDelay*Math.pow(1.5,i))});
    }
  }
  throw last;
}
async function listMultipartPartsDetailed(u){
  if(!s3Ready()||!u?.multipart_upload_id)return [];
  const parts=[];let marker=0;
  while(true){
    try{
      const r=await s3.send(new ListPartsCommand({
        Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,
        PartNumberMarker:marker||undefined,MaxParts:1000
      }));
      for(const p of r.Parts||[]){
        parts.push({
          partNumber:Number(p.PartNumber),
          etag:String(p.ETag||""),
          size:Number(p.Size||0)
        });
      }
      if(!r.IsTruncated)break;
      marker=r.NextPartNumberMarker;
    }catch(e){
      const code=String(e?.Code||e?.name||"");
      const status=Number(e?.$metadata?.httpStatusCode||0);
      if(code==="NoSuchUpload"||code==="InvalidUploadId"||status===404){
        const gone=new Error("The cloud multipart session is no longer available.");
        gone.code="UPLOAD_SESSION_GONE";
        throw gone;
      }
      throw e;
    }
  }
  return parts.sort((a,b)=>a.partNumber-b.partNumber);
}

async function inspectPendingUpload(u){
  const totalSize=Number(u.size_bytes||0);
  if(u.mode!=="multipart"){
    try{
      const head=await headObjectWithRetry({Bucket:bucket(),Key:u.storage_key},3,400);
      const uploadedBytes=Number(head.ContentLength||0);
      return {
        uploadedBytes,
        totalParts:1,
        completedParts:uploadedBytes===totalSize?1:0,
        missingParts:uploadedBytes===totalSize?[]:[1],
        completeReady:uploadedBytes===totalSize,
        parts:[]
      };
    }catch{
      return {uploadedBytes:0,totalParts:1,completedParts:0,missingParts:[1],completeReady:false,parts:[]};
    }
  }
  const partSize=Math.max(1,Number(u.part_size||MIN_PART_SIZE));
  const totalParts=Math.max(1,Math.ceil(totalSize/partSize));
  const allParts=await listMultipartPartsDetailed(u);
  // Only expected part numbers can contribute to completion.
  const parts=allParts.filter(function(p){return p.partNumber>=1&&p.partNumber<=totalParts});
  const byPart=new Map(parts.map(p=>[p.partNumber,p]));
  const missingParts=[];
  for(let i=1;i<=totalParts;i++)if(!byPart.has(i))missingParts.push(i);
  const uploadedBytes=parts.reduce((sum,p)=>sum+Number(p.size||0),0);
  return {
    uploadedBytes,
    totalParts,
    completedParts:totalParts-missingParts.length,
    missingParts,
    completeReady:missingParts.length===0&&uploadedBytes===totalSize,
    parts
  };
}

function safeRelativePath(rel,name){
  var raw=String(rel||name||"").replace(/\\/g,"/");
  var parts=raw.split("/").filter(Boolean).filter(function(x){return x!=="."&&x!=="..";}).map(function(x){
    return x.replace(/[<>:"|?*\\\u0000-\u001F]/g,"_").slice(0,180);
  }).filter(Boolean);
  return parts.length?parts.join("/"):safeName(name);
}
async function ensureBucketCors(){
  if(!s3Ready())return;
  try{
    await s3.send(new PutBucketCorsCommand({
      Bucket:bucket(),
      CORSConfiguration:{CORSRules:[{
        AllowedOrigins:["*"],
        AllowedMethods:["GET","HEAD","PUT","POST","DELETE"],
        AllowedHeaders:["*"],
        ExposeHeaders:["ETag"],
        MaxAgeSeconds:3600
      }]}
    }));
    console.log("Railway bucket CORS is configured.");
  }catch(e){
    console.warn("Automatic bucket CORS setup failed:",e.message);
  }
}


async function multipartUploadAlive(u){
  if(!s3Ready()||!u?.multipart_upload_id)return false;
  try{
    await s3.send(new ListPartsCommand({
      Bucket:bucket(),
      Key:u.storage_key,
      UploadId:u.multipart_upload_id,
      MaxParts:1
    }));
    return true;
  }catch(e){
    const code=String(e?.Code||e?.name||"");
    const status=Number(e?.$metadata?.httpStatusCode||0);
    if(code==="NoSuchUpload"||code==="InvalidUploadId"||status===404)return false;
    throw e;
  }
}

async function initDb(){
  if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is missing");
  if(!s3Ready())console.warn("Railway bucket variables are not ready yet.");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id uuid PRIMARY KEY,
      email text UNIQUE NOT NULL,
      full_name text NOT NULL DEFAULT '',
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS projects(
      id uuid PRIMARY KEY,
      owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
      name text NOT NULL,
      client_name text DEFAULT '',
      client_email text DEFAULT '',
      note text DEFAULT '',
      share_token text UNIQUE,
      shared boolean NOT NULL DEFAULT false,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS files(
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      original_name text NOT NULL,
      storage_name text NOT NULL,
      storage_path text NOT NULL,
      mime_type text NOT NULL DEFAULT 'application/octet-stream',
      size_bytes bigint NOT NULL DEFAULT 0,
      content_fingerprint text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS downloads(
      id bigserial PRIMARY KEY,
      project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
      file_id uuid REFERENCES files(id) ON DELETE SET NULL,
      downloaded_at timestamptz NOT NULL DEFAULT now(),
      user_agent text DEFAULT '',
      ip_address text DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);
    CREATE INDEX IF NOT EXISTS idx_downloads_project ON downloads(project_id);

    CREATE TABLE IF NOT EXISTS upload_sessions(
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      original_name text NOT NULL,
      relative_path text NOT NULL DEFAULT '',
      storage_key text NOT NULL,
      mime_type text NOT NULL DEFAULT 'application/octet-stream',
      size_bytes bigint NOT NULL DEFAULT 0,
      part_size bigint NOT NULL DEFAULT 0,
      multipart_upload_id text,
      mode text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      content_fingerprint text,
      upload_protocol_version integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
    ALTER TABLE files ADD COLUMN IF NOT EXISTS relative_path text NOT NULL DEFAULT '';
    ALTER TABLE files ADD COLUMN IF NOT EXISTS content_fingerprint text;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS sha256 text;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS idx_files_fingerprint ON files(project_id,content_fingerprint,size_bytes);
    CREATE INDEX IF NOT EXISTS idx_upload_sessions_project ON upload_sessions(project_id);
    ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS content_fingerprint text;
    ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS upload_protocol_version integer;
    CREATE INDEX IF NOT EXISTS idx_upload_sessions_active ON upload_sessions(project_id,status);
    CREATE TABLE IF NOT EXISTS streams(
      id uuid PRIMARY KEY,
      name text NOT NULL,
      title text DEFAULT '',
      description text DEFAULT '',
      stream_key text UNIQUE NOT NULL,
      stream_path text UNIQUE NOT NULL,
      viewer_token text UNIQUE NOT NULL,
      shared boolean NOT NULL DEFAULT true,
      enabled boolean NOT NULL DEFAULT true,
      status text NOT NULL DEFAULT 'offline',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      ended_at timestamptz
    );
    ALTER TABLE streams ADD COLUMN IF NOT EXISTS record_enabled boolean NOT NULL DEFAULT true;
    CREATE TABLE IF NOT EXISTS stream_recordings(
      id uuid PRIMARY KEY,
      stream_id uuid NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
      filename text NOT NULL,
      storage_key text UNIQUE NOT NULL,
      status text NOT NULL DEFAULT 'recording',
      size_bytes bigint NOT NULL DEFAULT 0,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      error text DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_stream_recordings_stream ON stream_recordings(stream_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS stream_viewers(
      id uuid PRIMARY KEY,
      stream_id uuid NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
      session_key text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      last_seen timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      user_agent text DEFAULT '',
      ip_address text DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_streams_updated ON streams(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stream_viewers_stream ON stream_viewers(stream_id,last_seen);
    CREATE TABLE IF NOT EXISTS stream_comments(
      id uuid PRIMARY KEY,
      stream_id uuid NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
      display_name text NOT NULL DEFAULT '',
      comment text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_stream_comments_stream ON stream_comments(stream_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS ndi_gateways(
      id uuid PRIMARY KEY,
      name text NOT NULL DEFAULT '',
      pair_token text UNIQUE NOT NULL,
      version text DEFAULT '',
      capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'offline',
      active_input text DEFAULT '',
      active_output text DEFAULT '',
      last_ip text DEFAULT '',
      last_seen timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ndi_gateways_seen ON ndi_gateways(last_seen DESC);
    CREATE TABLE IF NOT EXISTS app_settings(
      key text PRIMARY KEY,
      value text NOT NULL DEFAULT ''
    );
    INSERT INTO app_settings(key,value) VALUES
      ('studio_name','FBI Client File Studio'),
      ('portal_title','FBI Client File Delivery'),
      ('default_client_note','Your files are ready for download.'),
      ('default_expiry_days','30'),
      ('log_downloads','true'),
      ('allow_client_preview','true'),
      ('show_file_size','true')
    ON CONFLICT (key) DO NOTHING;
  `);
}

  ``;

// The function is defined after initDb so it can use the existing pool.
// It only affects recordings whose stream is already offline.
async function finalizeStaleOfflineRecordings(){
  try{
    const r=await pool.query(`
      UPDATE stream_recordings sr
      SET status='failed',
          ended_at=COALESCE(sr.ended_at,now()),
          error=CASE WHEN COALESCE(sr.error,'')='' THEN 'Recording process was interrupted before finalization.' ELSE sr.error END
      FROM streams s
      WHERE sr.stream_id=s.id
        AND sr.status='recording'
        AND s.status='offline'
      RETURNING sr.id
    `);
    if(r.rowCount)console.warn("Finalized "+r.rowCount+" stale offline recording(s).");
  }catch(e){
    console.warn("Stale recording cleanup failed:",e?.message||e);
  }
}

const DEFAULT_SETTINGS={
  studio_name:"FBI Client File Studio",
  portal_title:"FBI Client File Delivery",
  default_client_note:"Your files are ready for download.",
  default_expiry_days:"30",
  log_downloads:"true",
  allow_client_preview:"true",
  show_file_size:"true"
};
async function loadSettings(){
  const r=await pool.query("SELECT key,value FROM app_settings");
  const out={...DEFAULT_SETTINGS};
  for(const row of r.rows)out[row.key]=row.value;
  return out;
}
function settingBool(v){return String(v)==="true";}
function settingInt(v,fallback){const n=Number(v);return Number.isFinite(n)?Math.max(0,Math.min(3650,Math.round(n))):fallback;}
function formatStorageBytes(v){
  var n=Math.max(0,Number(v||0));
  if(n===0)return"0 B";
  var units=["B","KB","MB","GB","TB","PB"],i=0;
  while(n>=1000&&i<units.length-1){n/=1000;i++;}
  return (i===0?n.toFixed(0):n<10?n.toFixed(2):n<100?n.toFixed(1):n.toFixed(0))+" "+units[i];
}
async function adminPasswordMatches(password){
  const r=await pool.query("SELECT value FROM app_settings WHERE key='admin_password_hash'");
  const stored=r.rows[0]?.value||"";
  if(!stored)return ADMIN_PASSWORD && password===ADMIN_PASSWORD;
  try{
    const [prefix,N,r,p,salt,hash]=stored.split("$");
    if(prefix!=="scrypt"||!N||!r||!p||!salt||!hash)return false;
    const derived=await new Promise((resolve,reject)=>crypto.scrypt(password,Buffer.from(salt,"base64"),64,{N:Number(N),r:Number(r),p:Number(p),maxmem:128*1024*1024},(e,d)=>e?reject(e):resolve(d)));
    return crypto.timingSafeEqual(Buffer.from(hash,"base64"),derived);
  }catch{return false;}
}
async function hashAdminPassword(password){
  const N=16384,r=8,p=1,salt=crypto.randomBytes(16),derived=await new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,{N,r,p,maxmem:128*1024*1024},(e,d)=>e?reject(e):resolve(d)));
  return `scrypt${N}${r}${p}${salt.toString("base64")}${Buffer.from(derived).toString("base64")}`;
}


function escHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}
function streamPathForKey(key){return "live/"+key;}
function streamPlaybackPathForRow(row){return "encoded/"+String(row?.stream_key||"");}
function streamHlsUrl(row){
  // Always use the current page origin. This prevents the HLS proxy request
  // from crossing domains and losing the authenticated admin session cookie.
  return "/api/streams/"+encodeURIComponent(String(row.id))+"/hls/index.m3u8";
}
function streamInputHlsUrl(row){
  const base=String(process.env.STREAM_HLS_BASE||"").replace(/\/+$/,"");
  return base+"/"+String(row?.stream_path||"");
}
function streamInputRtmpUrl(row){
  const base=streamRtmpServer();
  return base&&row?.stream_key?base+"/"+row.stream_key:"";
}
function streamEncodedRtmpUrl(row){
  const base=streamRtmpServer();
  return base&&row?.stream_key?base.replace(/\/live$/,"/encoded")+"/"+row.stream_key:"";
}
const activeStreamRecordings=new Map();
async function startStreamRecording(row){
  if(activeStreamRecordings.has(row.id)||!row.record_enabled||!ffmpegPath||!s3Ready())return;
  const inputBase=streamInputHlsUrl(row);
  const input=inputBase&&inputBase.startsWith("http")?inputBase+"/index.m3u8":streamInputRtmpUrl(row);
  if(!input)return;

  const id=uid();
  const filename=safeName((row.name||"live-stream")+"-"+new Date().toISOString().replace(/[:.]/g,"-")+".mp4");
  const storageKey="recordings/"+row.id+"/"+id+"/"+filename;
  await pool.query("INSERT INTO stream_recordings(id,stream_id,filename,storage_key,status,started_at) VALUES($1,$2,$3,$4,'recording',now())",[id,row.id,filename,storageKey]);

  const proc=spawn(ffmpegPath,[
    "-hide_banner","-loglevel","warning",
    "-i",input,
    "-map","0:v:0","-map","0:a:0?",
    "-c:v","libx264","-preset","veryfast","-crf","18",
    "-pix_fmt","yuv420p","-profile:v","high",
    "-c:a","aac","-b:a","160k","-ar","48000","-ac","2",
    "-movflags","+frag_keyframe+empty_moov+default_base_moof",
    "-f","mp4","pipe:1"
  ],{stdio:["ignore","pipe","pipe"]});

  const PassThrough=require("stream").PassThrough;
  const pass=new PassThrough();
  let bytes=0,stderr="";
  proc.stdout.on("data",chunk=>{bytes+=chunk.length;pass.write(chunk)});
  proc.stdout.on("end",()=>pass.end());
  proc.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-8000)});

  const uploadDone=new Upload({
    client:s3,
    params:{Bucket:bucket(),Key:storageKey,Body:pass,ContentType:"video/mp4",CacheControl:"private, max-age=31536000"},
    queueSize:2,
    partSize:64*1024*1024,
    leavePartsOnError:false
  }).done();

  let finalized=false;
  const finalize=async(status,errorText)=>{
    if(finalized)return;
    finalized=true;
    try{await uploadDone}catch(uploadErr){
      status="failed";
      errorText=String(uploadErr?.message||uploadErr);
    }
    try{
      await pool.query(
        "UPDATE stream_recordings SET status=$2,ended_at=COALESCE(ended_at,now()),size_bytes=$3,error=$4 WHERE id=$1",
        [id,status,bytes,String(errorText||"")]
      );
    }catch(dbErr){
      console.error("Recording database finalization failed:",dbErr?.message||dbErr);
    }
    activeStreamRecordings.delete(row.id);
  };

  proc.on("error",async err=>{
    try{pass.destroy(err)}catch{}
    await finalize("failed",String(err?.message||err));
  });

  proc.on("close",async code=>{
    try{if(!proc.stdout.readableEnded)pass.end()}catch{}
    const status=code===0&&bytes>0?"completed":"failed";
    await finalize(status,status==="failed"?(stderr||("FFmpeg exited with code "+String(code))):"");
  });

  activeStreamRecordings.set(row.id,{id,proc,finish:()=>finalize("completed","")});
}

async function stopStreamRecording(streamId){
  const active=activeStreamRecordings.get(streamId);
  if(!active)return;

  try{active.proc.kill("SIGINT")}catch{}
  await new Promise(r=>setTimeout(r,5000));

  if(activeStreamRecordings.has(streamId)){
    try{active.proc.kill("SIGTERM")}catch{}
    await new Promise(r=>setTimeout(r,4000));
  }

  if(activeStreamRecordings.has(streamId)){
    try{active.proc.kill("SIGKILL")}catch{}
    await new Promise(r=>setTimeout(r,1000));
  }

  await Promise.race([
    active.finish(),
    new Promise(r=>setTimeout(r,8000))
  ]);

  activeStreamRecordings.delete(streamId);
}
function randomStreamKey(){return crypto.randomBytes(24).toString("base64url");}
function randomViewerToken(){return crypto.randomBytes(24).toString("base64url");}
function randomNdiPairToken(){return crypto.randomBytes(20).toString("base64url");}
function streamRtmpServer(){const h=String(process.env.STREAM_RTMP_HOST||"").trim(),p=String(process.env.STREAM_RTMP_PORT||"").trim();return h&&p?"rtmp://"+h+":"+p+"/live":"";}
function parseQueryString(q){
  const raw=String(q||"");
  const out={};
  try{const params=new URLSearchParams(raw);for(const [k,v] of params.entries())out[k]=v;}catch{}
  return out;
}
async function checkStreamLive(row){
  if(!row || !row.enabled)return false;
  const url=streamInputHlsUrl(row)+"/index.m3u8";
  if(!url.startsWith("http"))return false;
  try{
    const r=await fetch(url,{method:"GET",cache:"no-store"});
    if(!r.ok)return false;
    const text=await r.text();
    return /#EXTM3U/.test(text);
  }catch{return false;}
}
async function refreshStreamStatus(row){
  const live=await checkStreamLive(row);
  const status=live?"live":"offline";
  if(status!==row.status){
    if(live){
      await pool.query("UPDATE streams SET status='live',started_at=COALESCE(started_at,now()),updated_at=now() WHERE id=$1",[row.id]);
      startStreamRecording({...row,status:"live"}).catch(e=>console.error("Stream recording start failed:",e.message||e));
    }else{
      await pool.query("UPDATE streams SET status='offline',ended_at=now(),updated_at=now() WHERE id=$1",[row.id]);
      stopStreamRecording(row.id).catch(e=>console.error("Stream recording stop failed:",e.message||e));
    }
  }else if(live&&row.record_enabled&&!activeStreamRecordings.has(row.id)){
    startStreamRecording({...row,status:"live"}).catch(e=>console.error("Stream recording recovery failed:",e.message||e));
  }
  return {...row,status};
}
async function streamRows(){
  const r=await pool.query(`SELECT s.*,
    COALESCE((SELECT count(*) FROM stream_viewers v WHERE v.stream_id=s.id),0)::int AS total_viewers,
    COALESCE((SELECT count(*) FROM stream_viewers v WHERE v.stream_id=s.id AND v.last_seen>=now()-interval '45 seconds'),0)::int AS current_viewers,
    COALESCE((SELECT max(c) FROM (SELECT count(*)::int c FROM stream_viewers v WHERE v.stream_id=s.id GROUP BY date_trunc('minute',v.last_seen)) z),0)::int AS peak_viewers
    FROM streams s ORDER BY s.updated_at DESC`);
  const out=[];for(const row of r.rows)out.push(await refreshStreamStatus(row));
  return out;
}
const streamMonitor=setInterval(async()=>{
  try{
    const r=await pool.query("SELECT * FROM streams WHERE enabled=true");
    for(const row of r.rows)await refreshStreamStatus(row);
  }catch(e){console.error("Stream monitor error:",e.message||e);}
},5000);
if(streamMonitor.unref)streamMonitor.unref();

app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:true}));

app.get("/health",(req,res)=>res.json({ok:true,service:"FBI Client File Studio",storage:s3Ready()?"railway-object-storage":"not-ready",time:new Date().toISOString()}));

app.post("/api/auth/login",async(req,res)=>{
  try{
    const email=String(req.body.email||"").trim().toLowerCase();
    const password=String(req.body.password||"");
    if(email!==ADMIN_EMAIL||!(await adminPasswordMatches(password)))return res.status(401).json({error:"Invalid email or password"});
    res.setHeader("Set-Cookie",`fbi_session=${encodeURIComponent(session(email))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);
    res.json({ok:true,email});
  }catch(e){console.error(e);res.status(500).json({error:"Login service error"});}
});
app.post("/api/auth/logout",(req,res)=>{
  res.setHeader("Set-Cookie","fbi_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  res.json({ok:true});
});
app.get("/api/auth/me",(req,res)=>res.json(validSession(req)?{authenticated:true,email:ADMIN_EMAIL}:{authenticated:false}));
app.post("/api/portal/register",async(req,res)=>{
 try{
  const fullName=String(req.body.full_name||"").trim().slice(0,120);
  const email=String(req.body.email||"").trim().toLowerCase();
  const password=String(req.body.password||"");
  if(!fullName)return res.status(400).json({error:"Full name is required."});
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:"Enter a valid email address."});
  if(password.length<10)return res.status(400).json({error:"Password must be at least 10 characters."});
  const existing=await pool.query("SELECT id FROM users WHERE email=$1",[email]);
  if(existing.rowCount)return res.status(409).json({error:"An account with that email already exists."});
  const id=uid(),hash=await hashUserPassword(password);
  const r=await pool.query("INSERT INTO users(id,email,full_name,password_hash) VALUES($1,$2,$3,$4) RETURNING id,email,full_name,created_at",[id,email,fullName,hash]);
  res.setHeader("Set-Cookie","fbi_user_session="+encodeURIComponent(userSession(r.rows[0]))+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000");
  res.json({ok:true,user:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not create your account."})}
});
app.post("/api/portal/login",async(req,res)=>{
 try{
  const email=String(req.body.email||"").trim().toLowerCase(),password=String(req.body.password||"");
  const r=await pool.query("SELECT id,email,full_name,password_hash FROM users WHERE email=$1",[email]);
  if(!r.rowCount||!(await userPasswordMatches(password,r.rows[0].password_hash)))return res.status(401).json({error:"Invalid email or password."});
  const u={id:r.rows[0].id,email:r.rows[0].email,full_name:r.rows[0].full_name};
  res.setHeader("Set-Cookie","fbi_user_session="+encodeURIComponent(userSession(u))+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000");
  res.json({ok:true,user:u});
 }catch(e){console.error(e);res.status(500).json({error:"Login service error."})}
});
app.post("/api/portal/logout",(req,res)=>{
  res.setHeader("Set-Cookie","fbi_user_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  res.json({ok:true});
});
app.get("/api/portal/me",portalUser,async(req,res)=>{
 try{
  const r=await pool.query("SELECT id,email,full_name,created_at FROM users WHERE id=$1",[req.portalUser.id]);
  if(!r.rowCount)return res.status(401).json({error:"Account not found."});
  res.json({authenticated:true,user:r.rows[0]});
 }catch(e){res.status(500).json({error:"Could not load account."})}
});

app.get("/api/portal/projects",portalUser,async(req,res)=>{
 try{
  const q=String(req.query.q||"").trim();
  const sql=q ? "SELECT p.*,COALESCE((SELECT count(*) FROM files f WHERE f.project_id=p.id),0)::int file_count,COALESCE((SELECT sum(size_bytes) FROM files f WHERE f.project_id=p.id),0) total_bytes FROM projects p WHERE p.owner_id=$1 AND (p.name ILIKE $2 OR p.client_name ILIKE $2) ORDER BY p.updated_at DESC" : "SELECT p.*,COALESCE((SELECT count(*) FROM files f WHERE f.project_id=p.id),0)::int file_count,COALESCE((SELECT sum(size_bytes) FROM files f WHERE f.project_id=p.id),0) total_bytes FROM projects p WHERE p.owner_id=$1 ORDER BY p.updated_at DESC";
  const vals=q?[req.portalUser.id,"%"+q+"%"]:[req.portalUser.id];
  const r=await pool.query(sql,vals);res.json({projects:r.rows});
 }catch(e){console.error(e);res.status(500).json({error:"Could not load your projects."})}
});
app.post("/api/portal/projects",portalUser,async(req,res)=>{
 try{
  const name=String(req.body.name||"").trim();if(!name)return res.status(400).json({error:"Project name is required."});
  const id=uid(),shareToken=token(),settings=await loadSettings(),defaultNote=String(req.body.note||"").trim()||settings.default_client_note||"",days=settingInt(settings.default_expiry_days,30),expires=days?new Date(Date.now()+days*86400000):null;
  const r=await pool.query("INSERT INTO projects(id,owner_id,name,client_name,client_email,note,share_token,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[id,req.portalUser.id,name,String(req.body.client_name||"").trim(),String(req.body.client_email||"").trim(),defaultNote,shareToken,expires]);
  res.json({project:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not create project."})}
});
app.get("/api/portal/projects/:id",portalUser,async(req,res)=>{
 try{const p=await portalProjectOwned(req.portalUser.id,req.params.id);if(!p)return res.status(404).json({error:"Project not found."});const f=await pool.query("SELECT * FROM files WHERE project_id=$1 ORDER BY created_at DESC",[p.id]);res.json({project:p,files:f.rows});}
 catch(e){console.error(e);res.status(500).json({error:"Could not load project."})}
});
app.patch("/api/portal/projects/:id",portalUser,async(req,res)=>{
 try{const p=await portalProjectOwned(req.portalUser.id,req.params.id);if(!p)return res.status(404).json({error:"Project not found."});const fields=[],values=[];let n=1;for(const k of ["name","client_name","client_email","note","expires_at","shared","archived"])if(Object.prototype.hasOwnProperty.call(req.body,k)){fields.push(k+"=$"+n++);values.push(k==="shared"||k==="archived"?Boolean(req.body[k]):req.body[k]===null?null:String(req.body[k]).trim())}if(!fields.length)return res.status(400).json({error:"Nothing to update."});fields.push("updated_at=now()");values.push(p.id,req.portalUser.id);const r=await pool.query("UPDATE projects SET "+fields.join(",")+" WHERE id=$"+n+" AND owner_id=$"+(n+1)+" RETURNING *",values);if(!r.rowCount)return res.status(404).json({error:"Project not found."});res.json({project:r.rows[0]});}
 catch(e){console.error(e);res.status(500).json({error:"Could not update project."})}
});
app.post("/api/portal/projects/:id/share",portalUser,async(req,res)=>{
 try{const p=await portalProjectOwned(req.portalUser.id,req.params.id);if(!p)return res.status(404).json({error:"Project not found."});const r=await pool.query("UPDATE projects SET share_token=$1,shared=true,updated_at=now() WHERE id=$2 AND owner_id=$3 RETURNING *",[token(),p.id,req.portalUser.id]);res.json({project:r.rows[0],share_url:(PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/share/"+r.rows[0].share_token});}
 catch(e){console.error(e);res.status(500).json({error:"Could not create client share link."})}
});
app.get("/api/portal/thumb/:id",portalUser,async(req,res)=>{
 try{
  const q=await pool.query("SELECT * FROM files WHERE id=$1 AND project_id IN (SELECT id FROM projects WHERE owner_id=$2)",[req.params.id,req.portalUser.id]);
  if(!q.rowCount)return res.status(404).send("File not found.");
  const f=q.rows[0];
  const width=Math.max(160,Math.min(640,Number(req.query.w||360))),height=Math.max(160,Math.min(720,Number(req.query.h||540)));
  const kind=thumbKind(f),cacheKind=kind==="video"?"video-v2":kind;
  const cacheKey="portal:"+f.id+":"+cacheKind+":"+width+"x"+height, cached=getThumbCache(cacheKey);
  if(cached)return res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").send(cached.buffer);
  const key="__portal-thumbnails/"+crypto.createHash("sha1").update(String(f.id)+"|"+cacheKind+"|"+width+"|"+height).digest("hex")+".webp";
  try{
   const head=await s3.send(new HeadObjectCommand({Bucket:bucket(),Key:key}));
   if(head.ContentLength){
    const got=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:key}));
    const bytes=got.Body?.transformToByteArray?Buffer.from(await got.Body.transformToByteArray()):Buffer.from(await new Promise((resolve,reject)=>{const chunks=[];got.Body.on("data",c=>chunks.push(c));got.Body.on("end",()=>resolve(Buffer.concat(chunks)));got.Body.on("error",reject)}));
    setThumbCache(cacheKey,bytes);return res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").send(bytes);
   }
  }catch(_e){}
  const webp=await generateThumbnail(f,width,height);
  setThumbCache(cacheKey,webp);
  await s3.send(new PutObjectCommand({Bucket:bucket(),Key:key,Body:webp,ContentType:"image/webp",CacheControl:"private, max-age=31536000, immutable",Metadata:{source_file_id:String(f.id),generated_by:"fbi-client-file-studio-portal-media-aware"}})).catch(function(){});
  res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").send(webp);
 }catch(e){console.error(e);res.status(500).send("Unable to generate thumbnail.")}
});
app.delete("/api/portal/projects/:id",portalUser,async(req,res)=>{
 try{
  if(!s3Ready())return res.status(503).json({error:"Cloud file storage is not ready."});
  const p=await portalProjectOwned(req.portalUser.id,req.params.id);
  if(!p)return res.status(404).json({error:"Project not found."});
  const files=await pool.query("SELECT storage_path FROM files WHERE project_id=$1",[p.id]);
  const sessions=await pool.query("SELECT storage_key,multipart_upload_id,mode FROM upload_sessions WHERE project_id=$1 AND status='active'",[p.id]);
  for(const u of sessions.rows){
   if(u.mode==="multipart"&&u.multipart_upload_id)await s3.send(new AbortMultipartUploadCommand({Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id})).catch(()=>{});
   else if(u.storage_key)await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:u.storage_key})).catch(()=>{});
  }
  const keys=files.rows.map(f=>f.storage_path).filter(Boolean);
  for(let i=0;i<keys.length;i+=1000){
   const out=await s3.send(new DeleteObjectsCommand({Bucket:bucket(),Delete:{Objects:keys.slice(i,i+1000).map(function(Key){return {Key:Key}}),Quiet:true}}));
   if(out.Errors&&out.Errors.length)throw new Error("One or more cloud files could not be deleted.");
  }
  await pool.query("DELETE FROM projects WHERE id=$1 AND owner_id=$2",[p.id,req.portalUser.id]);
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Could not completely delete the project."})}
});
app.get("/api/portal/file/:id",portalUser,async(req,res)=>{
 try{const r=await pool.query("SELECT * FROM files WHERE id=$1 AND project_id IN (SELECT id FROM projects WHERE owner_id=$2)",[req.params.id,req.portalUser.id]);if(!r.rowCount)return res.status(404).send("File not found.");const f=r.rows[0];const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:f.storage_path}),{expiresIn:900});res.redirect(url);}
 catch(e){console.error(e);res.status(500).send("Unable to serve file.")}
});
app.get("/api/projects",admin,async(req,res)=>{
 try{
  const q=String(req.query.q||"").trim();
  const status=String(req.query.status||"active");
  const where=[],values=[];
  if(q){values.push(`%${q}%`);where.push(`(p.name ILIKE ${values.length} OR p.client_name ILIKE ${values.length} OR p.client_email ILIKE ${values.length})`);}
  if(status==="active")where.push("p.archived=false");
  if(status==="archived")where.push("p.archived=true");
  const r=await pool.query(`SELECT p.*,
    (SELECT count(*) FROM files f WHERE f.project_id=p.id) file_count,
    COALESCE((SELECT sum(size_bytes) FROM files f WHERE f.project_id=p.id),0) total_bytes
    FROM projects p ${where.length?"WHERE "+where.join(" AND "):""} ORDER BY p.updated_at DESC`,values);
  res.json({projects:r.rows});
 }catch(e){console.error(e);res.status(500).json({error:"Could not load projects"})}
});

app.post("/api/projects",admin,async(req,res)=>{
 try{
  const name=String(req.body.name||"").trim();if(!name)return res.status(400).json({error:"Project name is required"});
  const id=uid(),shareToken=token();
  const settings=await loadSettings();
  const defaultNote=String(req.body.note||"").trim()||settings.default_client_note||"";
  const days=settingInt(settings.default_expiry_days,30);
  const expires=days?new Date(Date.now()+days*86400000):null;
  const r=await pool.query("INSERT INTO projects(id,name,client_name,client_email,note,share_token,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[id,name,String(req.body.client_name||"").trim(),String(req.body.client_email||"").trim(),defaultNote,shareToken,expires]);
  res.json({project:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not create project"})}
});
app.get("/api/projects/:id",admin,async(req,res)=>{
 try{
  const p=await pool.query("SELECT * FROM projects WHERE id=$1",[req.params.id]);if(!p.rowCount)return res.status(404).json({error:"Project not found"});
  const f=await pool.query("SELECT * FROM files WHERE project_id=$1 ORDER BY created_at DESC",[req.params.id]);
  res.json({project:p.rows[0],files:f.rows});
 }catch(e){console.error(e);res.status(500).json({error:"Could not load project"})}
});
app.patch("/api/projects/:id",admin,async(req,res)=>{
 try{
  const allowed=["name","client_name","client_email","note","expires_at","shared","archived"];const fields=[],values=[];let n=1;
  for(const k of allowed)if(Object.prototype.hasOwnProperty.call(req.body,k)){fields.push(`${k}=$${n++}`);values.push(k==="shared"||k==="archived"?Boolean(req.body[k]):req.body[k]===null?null:String(req.body[k]).trim())}
  if(!fields.length)return res.status(400).json({error:"Nothing to update"});
  fields.push("updated_at=now()");values.push(req.params.id);
  const r=await pool.query(`UPDATE projects SET ${fields.join(",")} WHERE id=$${n} RETURNING *`,values);if(!r.rowCount)return res.status(404).json({error:"Project not found"});
  res.json({project:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not update project"})}
});
app.delete("/api/projects/:id",admin,async(req,res)=>{
 try{
  if(!s3Ready())return res.status(503).json({error:"Cloud file storage is not ready."});
  const project=await pool.query("SELECT id,name FROM projects WHERE id=$1",[req.params.id]);
  if(!project.rowCount)return res.status(404).json({error:"Project not found"});
  const files=await pool.query("SELECT id,storage_path FROM files WHERE project_id=$1",[req.params.id]);
  const sessions=await pool.query("SELECT id,storage_key,multipart_upload_id,mode FROM upload_sessions WHERE project_id=$1 AND status='active'",[req.params.id]);
  for(const u of sessions.rows){
    if(u.mode==="multipart"&&u.multipart_upload_id){
      await s3.send(new AbortMultipartUploadCommand({Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id})).catch(function(){});
    }else if(u.storage_key){
      await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:u.storage_key})).catch(function(){});
    }
  }
  const keys=files.rows.map(f=>f.storage_path).filter(Boolean);
  for(let i=0;i<keys.length;i+=1000){
    const batch=keys.slice(i,i+1000);
    const out=await s3.send(new DeleteObjectsCommand({Bucket:bucket(),Delete:{Objects:batch.map(function(Key){return {Key:Key}}),Quiet:true}}));
    if(out.Errors&&out.Errors.length)throw new Error("Cloud storage could not delete one or more project files.");
  }
  await pool.query("DELETE FROM projects WHERE id=$1",[req.params.id]);
  res.json({ok:true,deleted_project_id:req.params.id,deleted_file_count:files.rowCount,project_name:project.rows[0].name});
 }catch(e){
  console.error("Project deletion failed:",e?.stack||e);
  res.status(500).json({error:"Could not completely delete the project. No database records were removed."});
 }
});

app.post("/api/projects/:id/regenerate-link",admin,async(req,res)=>{
 try{
  const r=await pool.query("UPDATE projects SET share_token=$1,shared=true,updated_at=now() WHERE id=$2 RETURNING *",[token(),req.params.id]);if(!r.rowCount)return res.status(404).json({error:"Project not found"});
  res.json({project:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not create share link"})}
});





app.post("/api/stream/auth",async(req,res)=>{
  try{
    const action=String(req.body.action||"");
    const pathValue=String(req.body.path||"").replace(/^\/+|\/+$/g,"");
    const query=parseQueryString(req.body.query);
    const presentedToken=String(req.body.token||query.token||"");
    const presentedPassword=String(req.body.password||"");
    if(!pathValue)return res.status(401).end();
    // MediaMTX authenticates not only the parent HLS path (live/<key>)
    // but also child playlists and media segments such as
    // live/<key>/video1_stream.m3u8. Resolve both the exact stream path
    // and any descendant path to the same stream record.
    const r=await pool.query(
      "SELECT * FROM streams WHERE stream_path=$1 OR $1 LIKE stream_path || '/%' ORDER BY length(stream_path) DESC LIMIT 1",
      [pathValue]
    );
    if(!r.rowCount)return res.status(403).end();
    const stream=r.rows[0];
    if(action==="publish"){
      const pathMatches=pathValue===stream.stream_path;
      if(!stream.enabled || (!pathMatches && presentedPassword!==stream.stream_key && presentedToken!==stream.stream_key))return res.status(403).end();
      await pool.query("UPDATE streams SET updated_at=now() WHERE id=$1",[stream.id]);
      return res.status(200).end();
    }
    if(action==="read"||action==="playback"){
      if(!stream.enabled || !stream.shared)return res.status(403).end();
      return res.status(200).end();
    }
    if(action==="api"||action==="metrics"||action==="pprof")return res.status(200).end();
    return res.status(403).end();
  }catch(e){console.error(e);res.status(500).end();}
});

app.get("/api/streams",admin,async(req,res)=>{
  try{
    const rows=await streamRows();
    const rtmpHost=String(process.env.STREAM_RTMP_HOST||"");
    const rtmpPort=String(process.env.STREAM_RTMP_PORT||"");
    res.json({streams:rows.map(s=>({
      ...s,
      stream_key:s.stream_key,
      stream_path:s.stream_path,
      rtmp_server:rtmpHost&&rtmpPort?`rtmp://${rtmpHost}:${rtmpPort}/live`:"",
      hls_url:streamHlsUrl(s),
      live_url:(PUBLIC_BASE_URL||`${req.protocol}://${req.get("host")}`)+"/live/"+s.id,viewer_url:(PUBLIC_BASE_URL||`${req.protocol}://${req.get("host")}`)+"/watch/"+s.viewer_token
    }))});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load live streams"});}
});

app.post("/api/streams",admin,async(req,res)=>{
  try{
    const name=String(req.body.name||"").trim();
    if(!name)return res.status(400).json({error:"Stream name is required."});
    const key=randomStreamKey(),viewer=randomViewerToken();
    const r=await pool.query(
      "INSERT INTO streams(id,name,title,description,stream_key,stream_path,viewer_token,shared,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,true,true) RETURNING *",
      [uid(),name,String(req.body.title||name).trim(),String(req.body.description||"").trim(),key,streamPathForKey(key),viewer]
    );
    res.json({stream:r.rows[0]});
  }catch(e){console.error(e);res.status(500).json({error:"Could not create stream"});}
});

app.get("/api/streams/:id",admin,async(req,res)=>{
  try{
    const r=await pool.query("SELECT * FROM streams WHERE id=$1",[req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:"Stream not found."});
    const s=await refreshStreamStatus(r.rows[0]);
    const viewers=await pool.query("SELECT count(*)::int AS total,count(*) FILTER (WHERE last_seen>=now()-interval '45 seconds')::int AS current FROM stream_viewers WHERE stream_id=$1",[s.id]);
    res.json({stream:{...s,rtmp_server:(process.env.STREAM_RTMP_HOST&&process.env.STREAM_RTMP_PORT)?`rtmp://${process.env.STREAM_RTMP_HOST}:${process.env.STREAM_RTMP_PORT}/live`:"",hls_url:streamHlsUrl(s),live_url:(PUBLIC_BASE_URL||`${req.protocol}://${req.get("host")}`)+"/live/"+s.id,viewer_url:(PUBLIC_BASE_URL||`${req.protocol}://${req.get("host")}`)+"/watch/"+s.viewer_token},viewers:viewers.rows[0]});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load stream"});}
});

app.patch("/api/streams/:id",admin,async(req,res)=>{
  try{
    const allowed=["name","title","description","shared","enabled","record_enabled"];
    const fields=[],values=[];let n=1;
    for(const k of allowed)if(Object.prototype.hasOwnProperty.call(req.body,k)){
      fields.push(`${k}=${n++}`);
      values.push(k==="shared"||k==="enabled"||k==="record_enabled"?Boolean(req.body[k]):String(req.body[k]??"").trim().slice(0,2000));
    }
    if(!fields.length)return res.status(400).json({error:"Nothing to update"});
    fields.push("updated_at=now()");values.push(req.params.id);
    const r=await pool.query(`UPDATE streams SET ${fields.join(",")} WHERE id=${n} RETURNING *`,values);
    if(!r.rowCount)return res.status(404).json({error:"Stream not found"});
    res.json({stream:r.rows[0]});
  }catch(e){console.error(e);res.status(500).json({error:"Could not update stream"});}
});

async function proxyHlsStream(req,res){
  try{
    const id=String(req.params.id||"");
    const q=await pool.query("SELECT * FROM streams WHERE id=$1 AND enabled=true",[id]);
    if(!q.rowCount)return res.status(404).end();
    const row=q.rows[0];

    const internalBase=(process.env.STREAM_HLS_INTERNAL||"http://fbi-live-ingest:8888").replace(/\/+$/,"");
    let sub=String(req.path||"/").replace(/^\/+/, "");
    // Accept URLs emitted by older cached players.
    if(/^index\.m3u8\/index\.m3u8$/i.test(sub))sub="index.m3u8";
    else if(/^index\.m3u8\//i.test(sub))sub=sub.slice("index.m3u8/".length);

    const upstreamPath="encoded/"+String(row.stream_key||"");
    const upstream=new URL(internalBase+"/"+upstreamPath+(sub?"/"+sub:""));

    for(const [k,v] of Object.entries(req.query||{}))upstream.searchParams.append(k,String(v));

    const incomingCookies=String(req.headers.cookie||"");
    const proxySession=(incomingCookies.match(/(?:^|;\s*)fbi_hls_session=([^;]+)/)||[])[1]||"";
    if(proxySession&&!upstream.searchParams.has("session"))upstream.searchParams.set("session",proxySession);

    // The first HLS request is intentionally made without MediaMTX's cookie.
    // cookieCheck=1 forces MediaMTX to emit a query-based HLS session.
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

      function proxyUri(raw){
        const value=String(raw||"").trim();
        if(!value)return value;
        try{
          const absolute=/^https?:\/\//i.test(value)?new URL(value):null;
          let pathname=absolute?absolute.pathname:value.split("?")[0];
          let query=absolute?absolute.search:value.includes("?")?"?"+value.split("?").slice(1).join("?"):"";
          const marker="/"+upstreamPath+"/";
          const markerIndex=pathname.indexOf(marker);
          if(markerIndex>=0)pathname=pathname.slice(markerIndex+marker.length);
          pathname=pathname.replace(/^\/+/,"");
          const proxyBase="/api/streams/"+encodeURIComponent(id)+"/hls/";
          const url=proxyBase+pathname;
          const sp=new URLSearchParams(query.replace(/^\?/,""));
          sp.delete("session");sp.delete("cookieCheck");
          const suffix=sp.toString();
          return url+(suffix?"?"+suffix:"");
        }catch{
          return value;
        }
      }

      textBody=textBody.split(/\r?\n/).map(function(line){
        const trimmed=line.trim();
        if(!trimmed)return line;
        if(/^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|MAP):/i.test(trimmed)){
          return line.replace(/URI="([^"]+)"/gi,function(_,uri){return 'URI="'+proxyUri(uri)+'"';});
        }
        if(trimmed[0]==="#")return line;
        return proxyUri(trimmed);
      }).join("\n");
      body=Buffer.from(textBody,"utf8");

      if(session){
        res.setHeader("Set-Cookie","fbi_hls_session="+encodeURIComponent(session)+"; Path=/api/streams/"+encodeURIComponent(id)+"/hls; HttpOnly; Secure; SameSite=Lax; Max-Age=1800");
      }
    }

    res.status(200)
      .set("Cache-Control",type.toLowerCase().includes("mpegurl")?"no-store, no-cache, must-revalidate":"no-cache")
      .type(type)
      .send(body);
  }catch(e){
    console.error("HLS proxy error:",e?.stack||e);
    res.status(502).json({error:"Live stream playback proxy unavailable."});
  }
}

app.use("/api/streams/:id/hls",admin,async(req,res)=>{
  await proxyHlsStream(req,res);
});

const publicHlsSegmentCache=new Map();
const publicHlsSegmentPending=new Map();
const PUBLIC_HLS_CACHE_TTL=6500;
const PUBLIC_HLS_CACHE_MAX_BYTES=48*1024*1024;
let publicHlsCacheBytes=0;
function publicHlsCacheKey(token,pathname,query){
  const q=new URLSearchParams(query||""); q.delete("session"); q.delete("cookieCheck");
  return String(token)+"|"+String(pathname||"")+"|"+q.toString();
}
function publicHlsCacheGet(key){
  const hit=publicHlsSegmentCache.get(key); if(!hit)return null;
  if(hit.expiresAt<Date.now()){publicHlsSegmentCache.delete(key);publicHlsCacheBytes=Math.max(0,publicHlsCacheBytes-hit.body.length);return null;}
  hit.lastUsed=Date.now(); return hit;
}
function publicHlsCacheSet(key,body,type){
  const bytes=body.length; if(bytes>8*1024*1024)return;
  const old=publicHlsSegmentCache.get(key); if(old)publicHlsCacheBytes=Math.max(0,publicHlsCacheBytes-old.body.length);
  publicHlsSegmentCache.set(key,{body,contentType:type||"application/octet-stream",expiresAt:Date.now()+PUBLIC_HLS_CACHE_TTL,lastUsed:Date.now()});
  publicHlsCacheBytes+=bytes;
  while(publicHlsCacheBytes>PUBLIC_HLS_CACHE_MAX_BYTES&&publicHlsSegmentCache.size){
    let oldestKey=null,oldest=Infinity;
    for(const [k,v] of publicHlsSegmentCache)if(v.lastUsed<oldest){oldest=v.lastUsed;oldestKey=k;}
    if(oldestKey===null)break;
    const v=publicHlsSegmentCache.get(oldestKey); publicHlsSegmentCache.delete(oldestKey);
    publicHlsCacheBytes=Math.max(0,publicHlsCacheBytes-v.body.length);
  }
}
const publicHlsSessionByToken=new Map();
function publicHlsSessionGet(token){
  const v=publicHlsSessionByToken.get(String(token||""));
  if(!v)return "";
  if(v.expiresAt<Date.now()){publicHlsSessionByToken.delete(String(token||""));return "";}
  return v.session;
}
function publicHlsSessionSet(token,session){
  if(!token||!session)return;
  publicHlsSessionByToken.set(String(token),{session:String(session),expiresAt:Date.now()+25*60*1000});
}
async function fetchPublicHlsBody(url,headers){
  const response=await fetch(url,{redirect:"follow",cache:"no-store",headers:headers||{}});
  const type=response.headers.get("content-type")||"application/octet-stream";
  const body=Buffer.from(await response.arrayBuffer());
  return {response,type,body};
}
function setPublicHlsCors(req,res){
  // Public viewer playback is intentionally cross-origin because the player page
  // lives on files.fbigh.com while HLS is served from live.fbigh.com.
  // The viewer token is the access control; no browser credentials are required
  // for the HLS media requests because the session is carried in rewritten URLs.
  res.set("Access-Control-Allow-Origin","*");
  res.set("Access-Control-Allow-Methods","GET,HEAD,OPTIONS");
  res.set("Access-Control-Allow-Headers","Range,Origin,Accept,Content-Type");
  res.set("Access-Control-Expose-Headers","Content-Length,Content-Range");
}

async function proxyPublicHlsStream(req,res){
  setPublicHlsCors(req,res);
  try{
    const token=String(req.params.token||"");
    const lookup=await publicStreamByToken(token);
    if(!lookup.rowCount)return res.status(404).end();
    const row=lookup.rows[0];
    const internalBase=(process.env.STREAM_HLS_INTERNAL||"http://fbi-live-ingest:8888").replace(/\/+$/,"");
    let sub=String(req.path||"/").replace(/^\/+/, "");
    if(/^index\.m3u8\/index\.m3u8$/i.test(sub))sub="index.m3u8";
    else if(/^index\.m3u8\//i.test(sub))sub=sub.slice("index.m3u8/".length);
    const upstreamPath="encoded/"+String(row.stream_key||"");
    const upstream=new URL(internalBase+"/"+upstreamPath+(sub?"/"+sub:""));
    for(const [k,v] of Object.entries(req.query||{}))upstream.searchParams.append(k,String(v));
    const incomingCookies=String(req.headers.cookie||"");
    const proxySession=(incomingCookies.match(/(?:^|;\s*)fbi_public_hls_session=([^;]+)/)||[])[1]||"";
    const sharedSession=publicHlsSessionGet(token);
    if(!upstream.searchParams.has("session")&&(proxySession||sharedSession)){
      upstream.searchParams.set("session",decodeURIComponent(proxySession||sharedSession));
    }
    const upstreamHeaders={};
    // MediaMTX v1.19.x establishes the HLS session through a cookieCheck
    // redirect. Send the cookie on the first playlist request so the proxy can
    // complete that handshake without depending on the browser or CDN to carry
    // Set-Cookie between requests.
    if(sub==="index.m3u8"&&!upstream.searchParams.has("session")&&!proxySession&&!sharedSession){
      upstreamHeaders.cookie="cookieCheck=1";
    }

    const isPlaylist=/\.m3u8$/i.test(sub);
    if(!isPlaylist){
      const cacheKey=publicHlsCacheKey(token,sub,upstream.search);
      const cached=publicHlsCacheGet(cacheKey);
      if(cached)return res.status(200).set("Cache-Control","public, max-age=2, s-maxage=6, stale-while-revalidate=4").set("CDN-Cache-Control","public, max-age=6, stale-while-revalidate=4").set("X-FBI-HLS-Cache","HIT").type(cached.contentType).send(cached.body);
      let pending=publicHlsSegmentPending.get(cacheKey);
      if(!pending){
        pending=(async()=>{
          const out=await fetchPublicHlsBody(upstream,upstreamHeaders);
          const result={status:out.response.status,type:out.type,body:out.body};
          if(out.response.ok)publicHlsCacheSet(cacheKey,out.body,out.type);
          return result;
        })();
        publicHlsSegmentPending.set(cacheKey,pending);
      }
      try{
        const out=await pending;
        if(out.status!==200)return res.status(out.status).type(out.type).send(out.body);
        const state=publicHlsCacheGet(cacheKey);
        return res.status(200).set("Cache-Control","public, max-age=2, s-maxage=6, stale-while-revalidate=4").set("CDN-Cache-Control","public, max-age=6, stale-while-revalidate=4").set("X-FBI-HLS-Cache",state&&state.body===out.body?"MISS":"DEDUP").type(out.type).send(out.body);
      }finally{
        if(publicHlsSegmentPending.get(cacheKey)===pending)publicHlsSegmentPending.delete(cacheKey);
      }
    }

    const out=await fetchPublicHlsBody(upstream,upstreamHeaders);
    const response=out.response,type=out.type;
    let body=out.body;
    if(!response.ok)return res.status(response.status).type(type).send(body);
    if(type.toLowerCase().includes("mpegurl")){
      let textBody=body.toString("utf8"),session="";
      const setCookies=typeof response.headers.getSetCookie==="function"?response.headers.getSetCookie():String(response.headers.get("set-cookie")||"").split(/,(?=\s*\w+=)/);
      for(const sc of setCookies){const m=String(sc).match(/(?:^|;\s*)hlsSession=([^;]+)/i);if(m){session=m[1];break;}}
      session=session||upstream.searchParams.get("session")||"";
      if(session)publicHlsSessionSet(token,session);
      function publicUri(raw){
        const value=String(raw||"").trim(); if(!value)return value;
        try{
          const absolute=/^https?:\/\//i.test(value)?new URL(value):null;
          let pathname=absolute?absolute.pathname:value.split("?")[0];
          let query=absolute?absolute.search:value.includes("?")?"?"+value.split("?").slice(1).join("?"):"";
          const marker="/"+upstreamPath+"/",markerIndex=pathname.indexOf(marker);
          if(markerIndex>=0)pathname=pathname.slice(markerIndex+marker.length);
          pathname=pathname.replace(/^\/+/,"");
          const base="/api/public/stream/"+encodeURIComponent(token)+"/hls/";
          const url=base+pathname,sp=new URLSearchParams(query.replace(/^\?/,""));
          // Keep each viewer's MediaMTX HLS session in the playlist URLs.
          // This is required because HLS sessions are viewer-specific. The
          // application cache still removes "session" from its cache key, so
          // identical media segments can be deduplicated without sharing one
          // MediaMTX session between different viewers.
          if(session&&!sp.has("session"))sp.set("session",session);
          sp.delete("cookieCheck");
          const suffix=sp.toString(); return url+(suffix?"?"+suffix:"");
        }catch{return value}
      }
      textBody=textBody.split(/\r?\n/).map(line=>{
        const trimmed=line.trim(); if(!trimmed)return line;
        if(/^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|MAP):/i.test(trimmed))return line.replace(/URI="([^"]+)"/gi,(_,uri)=>'URI="'+publicUri(uri)+'"');
        if(trimmed[0]==="#")return line;
        return publicUri(trimmed);
      }).join("\n");
      body=Buffer.from(textBody,"utf8");
      if(session)res.setHeader("Set-Cookie","fbi_public_hls_session="+encodeURIComponent(session)+"; Path=/api/public/stream/"+encodeURIComponent(token)+"/hls; HttpOnly; Secure; SameSite=Lax; Max-Age=1800");
    }
    res.status(200).set("Cache-Control","no-store, no-cache, must-revalidate").type(type).send(body);
  }catch(e){console.error("Public HLS proxy error:",e?.stack||e);res.status(502).json({error:"Live stream playback unavailable."});}
}

app.use("/api/public/stream/:token/hls",async(req,res)=>{
  await proxyPublicHlsStream(req,res);
});

app.get("/api/public/stream/:token/replay",async(req,res)=>{
  try{
    const r=await publicStreamByToken(req.params.token);
    if(!r.rowCount)return res.status(404).json({error:"Stream not found"});
    const stream=r.rows[0];
    const q=await pool.query("SELECT id,filename,status,size_bytes,started_at,ended_at,created_at,storage_key FROM stream_recordings WHERE stream_id=$1 AND status='completed' AND size_bytes>0 ORDER BY ended_at DESC NULLS LAST,created_at DESC LIMIT 1",[stream.id]);
    const recording=q.rows[0];
    if(!recording||!s3Ready())return res.json({available:false,status:recording?"completed":"none"});
    const meta=await headObjectWithRetry({Bucket:bucket(),Key:recording.storage_key});
    const total=Number(meta.ContentLength||recording.size_bytes||0);
    if(!Number.isFinite(total)||total<=0)return res.json({available:false,status:"empty"});
    const play_url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:recording.storage_key,ResponseContentType:"video/mp4",ResponseContentDisposition:"inline"}),{expiresIn:3600});
    res.json({available:true,status:"completed",play_url,recording:{id:recording.id,filename:recording.filename,size_bytes:total,started_at:recording.started_at,ended_at:recording.ended_at}});
  }catch(e){
    console.error("Public replay load failed:",e?.stack||e);
    res.status(500).json({error:"Could not load the stream replay."});
  }
});

app.get("/api/public/stream/:token/replay/file",async(req,res)=>{
  try{
    const r=await publicStreamByToken(req.params.token);
    if(!r.rowCount)return res.status(404).json({error:"Stream not found"});
    const stream=r.rows[0];
    const recordingId=String(req.query.recordingId||"").trim();
    const query=recordingId
      ? "SELECT id,filename,status,size_bytes,storage_key FROM stream_recordings WHERE stream_id=$1 AND id=$2 LIMIT 1"
      : "SELECT id,filename,status,size_bytes,storage_key FROM stream_recordings WHERE stream_id=$1 AND status='completed' AND size_bytes>0 ORDER BY ended_at DESC NULLS LAST,created_at DESC LIMIT 1";
    const q=recordingId
      ? await pool.query(query,[stream.id,recordingId])
      : await pool.query(query,[stream.id]);
    const recording=q.rows[0];
    if(!recording)return res.status(404).json({error:"Replay recording was not found."});
    if(recording.status!=="completed")return res.status(409).json({error:"Replay recording is still being finalized."});
    if(!s3Ready())return res.status(503).json({error:"Replay storage is not ready."});
    const meta=await headObjectWithRetry({Bucket:bucket(),Key:recording.storage_key});
    const total=Number(meta.ContentLength||recording.size_bytes||0);
    if(!Number.isFinite(total)||total<=0)return res.status(404).json({error:"Replay file is empty."});
    const range=String(req.headers.range||"").match(/^bytes=(\d*)-(\d*)$/i);
    let start=0,end=total-1;
    if(range){
      const requestedStart=range[1]?Number(range[1]):0;
      const requestedEnd=range[2]?Number(range[2]):total-1;
      if(!Number.isFinite(requestedStart)||!Number.isFinite(requestedEnd))return res.status(416).set("Content-Range","bytes */"+total).end();
      if(!range[1]&&range[2]){
        const suffix=Math.max(0,requestedEnd);
        start=Math.max(0,total-suffix);end=total-1;
      }else{
        start=Math.max(0,requestedStart);
        end=Math.min(total-1,requestedEnd);
      }
      if(start>=total||start>end)return res.status(416).set("Content-Range","bytes */"+total).end();
    }
    const partial=!!range;
    const contentLength=end-start+1;
    res.status(partial?206:200);
    res.set({
      "Content-Type":"video/mp4",
      "Content-Length":String(contentLength),
      "Accept-Ranges":"bytes",
      "Cache-Control":"no-store",
      ...(partial?{"Content-Range":"bytes "+start+"-"+end+"/"+total}:{}),
      "Content-Disposition":"inline; filename=\""+String(recording.filename||"replay.mp4").replace(/["\\]/g,"_")+"\""
    });
    res.setHeader("X-FBI-Replay-Recording",String(recording.id));
    res.setHeader("X-FBI-Replay-Bytes",String(total));
    if(req.method==="HEAD")return res.end();
    const get=await s3.send(new GetObjectCommand({
      Bucket:bucket(),
      Key:recording.storage_key,
      ...(partial?{Range:"bytes="+start+"-"+end}:{}),
      ResponseContentType:"video/mp4",
      ResponseContentDisposition:"inline"
    }));
    if(get.Body&&typeof get.Body.pipe==="function")get.Body.pipe(res);
    else if(get.Body&&typeof get.Body.transformToByteArray==="function")res.end(Buffer.from(await get.Body.transformToByteArray()));
    else res.end();
  }catch(e){
    console.error("Public replay file failed:",e?.stack||e);
    if(!res.headersSent)res.status(502).json({error:"Could not play the stream replay."});
    else res.end();
  }
});

app.get("/api/streams/:id/recordings",admin,async(req,res)=>{
  try{
    const q=await pool.query("SELECT * FROM stream_recordings WHERE stream_id=$1 ORDER BY created_at DESC LIMIT 50",[req.params.id]);
    const rows=await Promise.all(q.rows.map(async r=>{
      let play_url="";
      if(r.status==="completed"&&s3Ready())play_url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:r.storage_key}),{expiresIn:3600});
      return {...r,play_url};
    }));
    res.json({recordings:rows});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load stream recordings"});}
});
app.post("/api/streams/:id/regenerate-key",admin,async(req,res)=>{
  try{
    const key=randomStreamKey();
    const r=await pool.query("UPDATE streams SET stream_key=$1,stream_path=$2,updated_at=now(),status='offline',started_at=NULL,ended_at=now() WHERE id=$3 RETURNING *",[key,streamPathForKey(key),req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:"Stream not found"});
    res.json({stream:r.rows[0]});
  }catch(e){console.error(e);res.status(500).json({error:"Could not regenerate stream key"});}
});

app.delete("/api/streams/:id",admin,async(req,res)=>{
  try{
    const r=await pool.query("DELETE FROM streams WHERE id=$1 RETURNING id",[req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:"Stream not found"});
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"Could not delete stream"});}
});

app.post("/api/ndi/gateway/pair",admin,async(req,res)=>{
  try{
    const name=String(req.body.name||"FBI NDI Gateway").trim().slice(0,120)||"FBI NDI Gateway";
    const pair=randomNdiPairToken();
    const r=await pool.query("INSERT INTO ndi_gateways(id,name,pair_token,status,last_seen) VALUES($1,$2,$3,'pending',now()) RETURNING id,name,pair_token,status,created_at",[uid(),name,pair]);
    res.json({gateway:r.rows[0],studio_url:PUBLIC_BASE_URL||req.protocol+"://"+req.get("host")});
  }catch(e){console.error(e);res.status(500).json({error:"Could not create NDI pairing code"});}
});

app.get("/api/ndi/gateways",admin,async(req,res)=>{
  try{
    const r=await pool.query("SELECT id,name,version,capabilities,status,active_input,active_output,last_ip,last_seen,created_at,updated_at FROM ndi_gateways ORDER BY updated_at DESC");
    const rows=r.rows.map(g=>({...g,status:(g.last_seen&&Date.now()-new Date(g.last_seen).getTime()<30000)?(g.status||"connected"):"offline"}));
    res.json({gateways:rows});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load NDI gateways"});}
});

app.delete("/api/ndi/gateway/:id",admin,async(req,res)=>{
  try{
    const r=await pool.query("DELETE FROM ndi_gateways WHERE id=$1 RETURNING id",[req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:"Gateway not found"});
    res.json({ok:true});
  }catch(e){res.status(500).json({error:"Could not remove gateway"});}
});

app.post("/api/ndi/gateway/:pairToken/register",async(req,res)=>{
  try{
    const r=await pool.query("SELECT id,name FROM ndi_gateways WHERE pair_token=$1",[req.params.pairToken]);
    if(!r.rowCount)return res.status(403).json({error:"Invalid NDI pairing code"});
    const caps=req.body.capabilities&&typeof req.body.capabilities==="object"?req.body.capabilities:{};
    const name=String(req.body.name||r.rows[0].name||"FBI NDI Gateway").trim().slice(0,120);
    await pool.query("UPDATE ndi_gateways SET name=$1,version=$2,capabilities=$3,status='connected',last_ip=$4,last_seen=now(),updated_at=now() WHERE id=$5",[name,String(req.body.version||"").slice(0,80),JSON.stringify(caps),clientIp(req),r.rows[0].id]);
    res.json({ok:true,gateway_id:r.rows[0].id,studio_url:PUBLIC_BASE_URL||req.protocol+"://"+req.get("host")});
  }catch(e){console.error(e);res.status(500).json({error:"NDI gateway registration failed"});}
});

app.get("/api/ndi/gateway/:pairToken/config",async(req,res)=>{
  try{
    const r=await pool.query("SELECT id,name,status FROM ndi_gateways WHERE pair_token=$1",[req.params.pairToken]);
    if(!r.rowCount)return res.status(403).json({error:"Invalid NDI pairing code"});
    const streams=await streamRows();
    res.json({
      gateway:{id:r.rows[0].id,name:r.rows[0].name,status:r.rows[0].status},
      studio_url:PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"),
      rtmp_server:streamRtmpServer(),
      streams:streams.map(s=>({id:s.id,name:s.name,title:s.title,stream_key:s.stream_key,stream_path:s.stream_path,shared:s.shared,enabled:s.enabled,hls_url:streamHlsUrl(s),viewer_url:(PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/"+s.viewer_token}))
    });
  }catch(e){console.error(e);res.status(500).json({error:"Could not load NDI gateway configuration"});}
});

app.post("/api/ndi/gateway/:pairToken/heartbeat",async(req,res)=>{
  try{
    const r=await pool.query("SELECT id FROM ndi_gateways WHERE pair_token=$1",[req.params.pairToken]);
    if(!r.rowCount)return res.status(403).json({error:"Invalid NDI pairing code"});
    const state=req.body&&typeof req.body==="object"?req.body:{};
    await pool.query("UPDATE ndi_gateways SET status=$1,active_input=$2,active_output=$3,last_ip=$4,last_seen=now(),updated_at=now() WHERE id=$5",[String(state.status||"connected").slice(0,40),String(state.active_input||"").slice(0,200),String(state.active_output||"").slice(0,200),clientIp(req),r.rows[0].id]);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:"NDI heartbeat failed"});}
});

function publicStreamByToken(token){
  return pool.query("SELECT * FROM streams WHERE viewer_token=$1 AND enabled=true AND shared=true",[token]);
}
app.post("/api/public/stream/:token/heartbeat",async(req,res)=>{
  try{
    const r=await pool.query("SELECT id FROM streams WHERE viewer_token=$1 AND enabled=true AND shared=true",[req.params.token]);
    if(!r.rowCount)return res.status(404).json({error:"Stream not found"});
    const sessionKey=String(req.body.sessionKey||"").slice(0,120);
    if(!sessionKey)return res.status(400).json({error:"Session key required"});
    const existing=await pool.query("SELECT id FROM stream_viewers WHERE stream_id=$1 AND session_key=$2",[r.rows[0].id,sessionKey]);
    if(existing.rowCount){
      await pool.query("UPDATE stream_viewers SET last_seen=now(),ended_at=NULL,user_agent=$1,ip_address=$2 WHERE id=$3",[String(req.headers["user-agent"]||"").slice(0,1000),clientIp(req),existing.rows[0].id]);
    }else{
      await pool.query("INSERT INTO stream_viewers(id,stream_id,session_key,user_agent,ip_address) VALUES($1,$2,$3,$4,$5)",[uid(),r.rows[0].id,sessionKey,String(req.headers["user-agent"]||"").slice(0,1000),clientIp(req)]);
    }
    res.json({ok:true});
  }catch(e){res.status(500).json({error:"Heartbeat failed"});}
});

app.get("/api/public/stream/:token/status",async(req,res)=>{
  try{
    const r=await pool.query("SELECT * FROM streams WHERE viewer_token=$1 AND enabled=true AND shared=true",[req.params.token]);
    if(!r.rowCount)return res.status(404).json({error:"This stream link is invalid, disabled, or expired."});
    const s=await refreshStreamStatus(r.rows[0]);
    const v=await pool.query("SELECT count(*)::int AS current FROM stream_viewers WHERE stream_id=$1 AND last_seen>=now()-interval '45 seconds'",[s.id]);
    res.json({live:s.status==="live",title:s.title,name:s.name,current_viewers:v.rows[0].current});
  }catch(e){res.status(500).json({error:"Could not load stream status"});}
});

app.get("/api/public/stream/:token/comments",async(req,res)=>{
  try{
    const r=await publicStreamByToken(req.params.token);
    if(!r.rowCount)return res.status(404).json({error:"Stream not found"});
    const limit=Math.max(1,Math.min(100,Number(req.query.limit||60)));
    const q=await pool.query("SELECT id,display_name,comment,created_at FROM stream_comments WHERE stream_id=$1 ORDER BY created_at DESC LIMIT $2",[r.rows[0].id,limit]);
    res.json({comments:q.rows.reverse()});
  }catch(e){console.error("Comments load failed:",e);res.status(500).json({error:"Could not load comments"});}
});
const streamCommentRate=new Map();
app.post("/api/public/stream/:token/comments",async(req,res)=>{
  try{
    const r=await publicStreamByToken(req.params.token);
    if(!r.rowCount)return res.status(404).json({error:"Stream not found"});
    const ip=clientIp(req),now=Date.now(),last=streamCommentRate.get(ip)||0;
    if(now-last<1500)return res.status(429).json({error:"Please wait a moment before posting another comment."});
    const name=String(req.body.display_name||"Anonymous").trim().slice(0,60)||"Anonymous";
    const comment=String(req.body.comment||"").trim().slice(0,500);
    if(!comment)return res.status(400).json({error:"Comment cannot be empty."});
    streamCommentRate.set(ip,now);
    const q=await pool.query("INSERT INTO stream_comments(id,stream_id,display_name,comment) VALUES($1,$2,$3,$4) RETURNING id,display_name,comment,created_at",[uid(),r.rows[0].id,name,comment]);
    res.status(201).json({comment:q.rows[0]});
  }catch(e){console.error("Comment create failed:",e);res.status(500).json({error:"Could not post comment"});}
});

app.get("/live/:id",admin,async(req,res)=>{
  try{
    const r=await pool.query("SELECT id FROM streams WHERE id=$1 AND enabled=true",[req.params.id]);
    if(!r.rowCount)return res.status(404).send("Live stream not found.");
    res.redirect(302,"/?view=streams&stream="+encodeURIComponent(r.rows[0].id));
  }catch(e){
    console.error("Live studio route failed:",e);
    res.status(500).send("Could not open live stream.");
  }
});

app.get("/watch/:token",async(req,res)=>{
  try{
    const r=await publicStreamByToken(req.params.token);
    if(!r.rowCount)return res.status(404).send("Stream link is invalid or disabled.");
    const s=r.rows[0],viewerBase=String(process.env.PUBLIC_HLS_BASE_URL||"").replace(/\/+$/,"")||req.protocol+"://"+req.get("host"),hls=viewerBase+"/api/public/stream/"+encodeURIComponent(req.params.token)+"/hls/index.m3u8";
    const title=escHtml(s.title||s.name),tokenJs=JSON.stringify(req.params.token);
    res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} • FBI Live</title><script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script><script type="module" src="https://cdn.jsdelivr.net/npm/emoji-picker-element@1.29.1/index.js"></script><style>
body{margin:0;background:#09090a;color:#f6f6f7;font-family:Inter,system-ui,sans-serif;min-height:100vh}.wrap{max-width:1380px;margin:auto;padding:18px}.head{padding:14px 5px 18px}.brand{font-size:9px;letter-spacing:.12em;color:#8f8f98;text-transform:uppercase}.head h1{font-size:26px;margin:7px 0 4px}.head p{color:#9b9ba4;margin:0;font-size:11px}.badge{display:inline-block;padding:5px 9px;border-radius:999px;border:1px solid #29292e;font-size:9px}.live{color:#4ade80;border-color:rgba(74,222,128,.3);background:rgba(74,222,128,.05)}.error{color:#fb7185}.layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:14px;align-items:start}.card{background:#101012;border:1px solid #29292e;border-radius:18px;box-shadow:0 20px 70px rgba(0,0,0,.25)}.player{overflow:hidden;position:relative}.player video{display:block;width:100%;aspect-ratio:16/9;background:#000}.playerbar{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:10px 12px;border-top:1px solid #29292e;background:#111114}.nowq{font-size:9px;color:#aaaab2}.comments{display:flex;flex-direction:column;height:min(620px,calc(100vh - 170px));min-height:420px;overflow:hidden}.comments-head{padding:14px;border-bottom:1px solid #29292e;display:flex;align-items:center;justify-content:space-between}.comments-head h2{margin:0;font-size:13px}.comment-list{padding:10px 12px;overflow-y:auto;overflow-x:hidden;flex:1;min-height:0;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}.comment{padding:9px 0;border-bottom:1px solid #222226}.comment:last-child{border-bottom:0}.comment b{display:block;font-size:9px}.comment span{display:block;color:#9b9ba4;font-size:10px;line-height:1.45;margin-top:3px;word-break:break-word}.comment time{display:block;color:#66666e;font-size:7px;margin-top:4px}.comment-form{padding:12px;border-top:1px solid #29292e;display:grid;gap:7px;flex:none;background:#101012}.comment-form input,.comment-form textarea{width:100%;box-sizing:border-box;background:#0b0b0d;color:#f5f5f6;border:1px solid #303036;border-radius:9px;padding:9px;font:inherit;font-size:9px}.comment-form textarea{min-height:66px;resize:vertical}.comment-form button{border:0;border-radius:9px;padding:10px;background:#e8c448;color:#171719;font-weight:800}.comment-tools{display:flex;gap:7px;align-items:center}.comment-tools .emoji-open{width:40px;flex:0 0 40px;padding:8px;background:#19191c;color:#f1c84a;border:1px solid #35353b;border-radius:9px}.emoji-popover{position:static}.emoji-popover emoji-picker{position:fixed;left:50%;right:auto;bottom:78px;transform:translateX(-50%);width:min(92vw,340px);height:min(52vh,380px);display:none;z-index:9999;--background:#111114;--border-color:#34343a;--input-border-color:#34343a;--button-hover-background:#25252a;border:1px solid #34343a;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.55)}.emoji-popover.open emoji-picker{display:block}.statusline{font-size:9px;color:#8f8f98;margin-top:7px;min-height:13px}.foot{text-align:center;color:#66666e;font-size:9px;padding:18px}.offline{display:grid;place-items:center;min-height:360px;color:#9b9ba4;text-align:center;padding:20px}
@media(max-width:950px){.layout{grid-template-columns:1fr}.comments{height:min(560px,62vh);min-height:420px}}@media(max-width:480px){.wrap{padding:10px}.head h1{font-size:21px}.comments{height:520px;min-height:0}.comment-form textarea{min-height:58px}.emoji-popover emoji-picker{bottom:72px;width:min(94vw,340px);height:min(56vh,360px)}}
/* Mobile viewer interface only. Playback/HLS/replay engine remains unchanged. */
.mobile-live-ui{display:none}
@media(max-width:600px){
  .mobile-live-ui{display:block;position:absolute;inset:0;z-index:4;pointer-events:none}
  .mobile-viewer-badge{position:absolute;right:10px;top:10px;display:flex;gap:6px;align-items:center;padding:6px 8px;border-radius:999px;background:rgba(0,0,0,.48);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(12px);color:#f5f5f7;font-size:7px}
  .mobile-viewer-badge b{font-size:8px}
  .mobile-floating-comments{position:absolute;left:9px;right:66px;bottom:58px;display:flex;flex-direction:column;justify-content:flex-end;gap:5px;max-height:56%;overflow:hidden;mask-image:linear-gradient(to bottom,transparent 0,#000 17%,#000 100%)}
  .mobile-floating-comment{align-self:flex-start;max-width:92%;padding:6px 9px;border-radius:13px 13px 13px 5px;background:rgba(8,8,10,.58);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(10px);box-shadow:0 7px 22px rgba(0,0,0,.24);animation:mobileCommentRise .38s cubic-bezier(.2,.75,.25,1) both}
  .mobile-floating-comment b{font-size:7px;color:#fff;margin-right:5px}
  .mobile-floating-comment span{font-size:8px;line-height:1.3;color:#ededf1;word-break:break-word}
  .mobile-floating-comment time{font-size:6px;color:#8f8f98;margin-left:5px}
  .mobile-live-ui .mobile-reaction-rail{opacity:0;transform:translateY(8px) scale(.96);transition:opacity .2s ease,transform .2s ease;pointer-events:none}.mobile-live-ui.show-reactions .mobile-reaction-rail{opacity:1;transform:none;pointer-events:auto}.mobile-reaction-rail{position:absolute;right:8px;bottom:8px;display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:auto}
  .mobile-reaction-btn{width:38px;height:38px;padding:0;border-radius:50%;border:1px solid rgba(255,255,255,.15);background:rgba(18,18,21,.68);backdrop-filter:blur(12px);color:#fff;display:grid;place-items:center;font-size:17px;box-shadow:0 8px 25px rgba(0,0,0,.3);touch-action:manipulation}
  .mobile-reaction-btn.heart{width:46px;height:46px;font-size:23px;background:rgba(170,32,55,.3)}
  .mobile-reaction-btn:active{transform:scale(.9)}
  .mobile-reaction-floaters{position:absolute;right:16px;bottom:68px;width:42px;height:56%;overflow:visible}
  .mobile-reaction-floater{position:absolute;right:0;bottom:0;font-size:27px;line-height:1;filter:drop-shadow(0 4px 9px rgba(0,0,0,.38));animation:mobileReactionUp 2.2s ease-out both}
  .player{position:relative}
  .comments{height:0!important;min-height:0!important;display:block;overflow:visible;background:transparent;border:0;box-shadow:none}
  .comments-head,.comment-list{display:none!important}
  .comment-form{position:fixed;left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:50;padding:8px;border:1px solid rgba(255,255,255,.1);border-radius:15px;background:rgba(13,13,16,.88);backdrop-filter:blur(18px);box-shadow:0 15px 45px rgba(0,0,0,.46)}
  .comment-form input{height:33px;font-size:8px;padding:8px 10px}
  .comment-form textarea{min-height:45px;max-height:92px;font-size:8px;padding:8px 10px}
  .comment-tools{display:flex;gap:6px;align-items:center}
  .comment-tools .emoji-open{width:39px!important;height:36px!important;flex:0 0 39px!important;padding:0!important;display:grid!important;place-items:center!important;visibility:visible!important;opacity:1!important;font-size:18px!important;border-radius:10px!important}
  .comment-tools>button[type=submit]{height:36px!important;flex:1!important;padding:8px!important;font-size:8px!important}
  .emoji-popover{position:relative}
  .emoji-popover emoji-picker{bottom:calc(118px + env(safe-area-inset-bottom));width:min(94vw,360px);height:min(55vh,380px);z-index:99999}
  .mobile-live-status{position:absolute;left:10px;top:10px;padding:5px 8px;border-radius:999px;background:rgba(0,0,0,.48);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(12px);font-size:7px;color:#ddd}
  .mobile-live-status.live{color:#69ef8d}
  .foot{padding-bottom:calc(78px + env(safe-area-inset-bottom))}
  @keyframes mobileCommentRise{0%{opacity:0;transform:translateY(12px) scale(.98)}100%{opacity:1;transform:translateY(0) scale(1)}}
  @keyframes mobileReactionUp{0%{opacity:0;transform:translateY(18px) scale(.72)}12%{opacity:1}100%{opacity:0;transform:translateY(-185px) scale(1.25)}}
}
@media(max-width:380px){
  .mobile-floating-comments{right:60px;bottom:55px}
  .mobile-reaction-rail{right:6px}
  .mobile-reaction-btn{width:35px;height:35px}
  .mobile-reaction-btn.heart{width:43px;height:43px}
  .comment-form{left:6px;right:6px}
}/* Phone landscape: keep the same mobile viewing controls when the handset rotates. */
@media (max-width:900px) and (orientation:landscape) and (pointer:coarse){
  .mobile-live-ui{display:block;position:absolute;inset:0;z-index:4;pointer-events:none}
  .mobile-viewer-badge{position:absolute;right:10px;top:10px;display:flex;gap:6px;align-items:center;padding:6px 8px;border-radius:999px;background:rgba(0,0,0,.48);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(12px);color:#f5f5f7;font-size:7px}
  .mobile-viewer-badge b{font-size:8px}
  .mobile-floating-comments{position:absolute;left:9px;right:66px;bottom:58px;display:flex;flex-direction:column;justify-content:flex-end;gap:5px;max-height:58%;overflow:hidden;mask-image:linear-gradient(to bottom,transparent 0,#000 17%,#000 100%)}
  .mobile-floating-comment{align-self:flex-start;max-width:70%;padding:6px 9px;border-radius:13px 13px 13px 5px;background:rgba(8,8,10,.58);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(10px);box-shadow:0 7px 22px rgba(0,0,0,.24);animation:mobileCommentRise .38s cubic-bezier(.2,.75,.25,1) both}
  .mobile-floating-comment b{font-size:7px;color:#fff;margin-right:5px}
  .mobile-floating-comment span{font-size:8px;line-height:1.3;color:#ededf1;word-break:break-word}
  .mobile-floating-comment time{font-size:6px;color:#8f8f98;margin-left:5px}
  .mobile-reaction-rail{position:absolute;right:8px;bottom:8px;display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:auto}
  .mobile-reaction-btn{width:38px;height:38px;padding:0;border-radius:50%;border:1px solid rgba(255,255,255,.15);background:rgba(18,18,21,.68);backdrop-filter:blur(12px);color:#fff;display:grid;place-items:center;font-size:17px;box-shadow:0 8px 25px rgba(0,0,0,.3);touch-action:manipulation}
  .mobile-reaction-btn.heart{width:46px;height:46px;font-size:23px;background:rgba(170,32,55,.3)}
  .mobile-reaction-btn:active{transform:scale(.9)}
  .mobile-reaction-floaters{position:absolute;right:16px;bottom:68px;width:42px;height:56%;overflow:visible}
  .mobile-reaction-floater{position:absolute;right:0;bottom:0;font-size:27px;line-height:1;filter:drop-shadow(0 4px 9px rgba(0,0,0,.38));animation:mobileReactionUp 2.2s ease-out both}
  .player{position:relative}
  .comments{height:0!important;min-height:0!important;display:block;overflow:visible;background:transparent;border:0;box-shadow:none}
  .comments-head,.comment-list{display:none!important}
  .comment-form{position:fixed;left:10px;right:10px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:50;padding:7px;display:grid;gap:6px;border:1px solid rgba(255,255,255,.1);border-radius:15px;background:rgba(13,13,16,.88);backdrop-filter:blur(18px);box-shadow:0 15px 45px rgba(0,0,0,.46)}
  .comment-form input{height:32px;font-size:8px;padding:8px 10px}
  .comment-form textarea{min-height:42px;max-height:78px;font-size:8px;padding:8px 10px}
  .comment-tools{display:flex;gap:6px;align-items:center}
  .comment-tools .emoji-open{width:39px!important;height:36px!important;flex:0 0 39px!important;padding:0!important;display:grid!important;place-items:center!important;visibility:visible!important;opacity:1!important;font-size:18px!important;border-radius:10px!important}
  .comment-tools>button[type=submit]{height:36px!important;flex:1!important;padding:8px!important;font-size:8px!important}
  .emoji-popover{position:relative}
  .emoji-popover emoji-picker{bottom:calc(116px + env(safe-area-inset-bottom));width:min(70vw,360px);height:min(78vh,340px);z-index:99999}
  .mobile-live-status{position:absolute;left:10px;top:10px;padding:5px 8px;border-radius:999px;background:rgba(0,0,0,.48);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(12px);font-size:7px;color:#ddd}
  .mobile-live-status.live{color:#69ef8d}
  .foot{padding-bottom:calc(72px + env(safe-area-inset-bottom))}
}</style></head><body><div class="wrap"><div class="head"><div class="brand">FILM BEYOND IMAGINATION • FBI Live</div><div style="margin-top:8px"><span class="badge" id="status">Checking live status…</span></div><h1>${title}</h1><p id="viewers">FBI Live Stream</p></div><div class="layout"><section><div class="card player"><video id="video" controls playsinline autoplay muted></video><div id="offline" class="offline" style="display:none"></div><div class="mobile-live-ui"><span class="mobile-live-status" id="mobileLiveStatus">CONNECTING…</span><span class="mobile-viewer-badge"><b id="mobileViewerCount">0</b> watching</span><div id="mobileFloatingComments" class="mobile-floating-comments"></div><div id="mobileReactionFloaters" class="mobile-reaction-floaters"></div><div class="mobile-reaction-rail"><button type="button" class="mobile-reaction-btn" data-mobile-reaction="👏" aria-label="Clap">👏</button><button type="button" class="mobile-reaction-btn" data-mobile-reaction="❤️" aria-label="Love">❤️</button><button type="button" class="mobile-reaction-btn heart" data-mobile-reaction="❤️" aria-label="Send heart">♥</button></div></div><div class="playerbar"><span class="nowq" id="streamState">Connecting…</span></div></div></section><aside class="card comments"><div class="comments-head"><h2>Live Comments</h2><span class="badge" id="commentCount">0</span></div><div id="commentList" class="comment-list"><div style="color:#777;font-size:9px;padding:10px 0">No comments yet.</div></div><form id="commentForm" class="comment-form"><input id="commentName" maxlength="60" placeholder="Your name"><textarea id="commentText" maxlength="500" placeholder="Write a comment…"></textarea><div class="comment-tools"><div class="emoji-popover" id="emojiPopover"><button type="button" class="emoji-open" id="emojiOpen" title="Add emoji">😊</button><emoji-picker id="emojiPicker" locale="en"></emoji-picker></div><button type="submit">Post Comment</button></div><div class="statusline" id="commentStatus"></div></form></aside></div><div class="foot">FBI Live • Live broadcast and viewer comments • viewer-badge-sync-1</div></div><script>
const token=${tokenJs},hlsUrl=${JSON.stringify(hls)};const video=document.getElementById("video"),emojiOpen=document.getElementById("emojiOpen"),emojiPopover=document.getElementById("emojiPopover"),emojiPicker=document.getElementById("emojiPicker"),offline=document.getElementById("offline"),statusEl=document.getElementById("status"),viewers=document.getElementById("viewers"),streamState=document.getElementById("streamState"),commentList=document.getElementById("commentList"),commentCount=document.getElementById("commentCount"),commentForm=document.getElementById("commentForm"),commentName=document.getElementById("commentName"),commentText=document.getElementById("commentText"),commentStatus=document.getElementById("commentStatus");const sessionKey=crypto.randomUUID();let player=null,live=false,replayMode=false,replayTimer=0;const mobileFloatingComments=document.getElementById("mobileFloatingComments"),mobileReactionFloaters=document.getElementById("mobileReactionFloaters"),mobileViewerCount=document.getElementById("mobileViewerCount"),mobileLiveStatus=document.getElementById("mobileLiveStatus");let mobileReactionIndex=0;const mobileLiveUi=document.querySelector(".mobile-live-ui");let mobileReactionHideTimer=0;function revealMobileReactions(){if(!mobileLiveUi)return;mobileLiveUi.classList.add("show-reactions");clearTimeout(mobileReactionHideTimer);mobileReactionHideTimer=setTimeout(function(){mobileLiveUi.classList.remove("show-reactions")},3200)}video.addEventListener("pointerup",revealMobileReactions);
video.addEventListener("loadedmetadata",function(){if(replayMode)streamState.textContent="Replay ready"});
video.addEventListener("error",function(){if(!replayMode)return;const err=video.error;streamState.textContent=err?"Replay playback error ("+String(err.code)+")":"Replay playback error"});
function renderMobileOverlay(rows){
  if(mobileFloatingComments)mobileFloatingComments.innerHTML=(rows||[]).slice(-5).map(function(x,i){return '<div class="mobile-floating-comment" style="animation-delay:'+(i*60)+'ms"><b>'+esc(x.display_name)+'</b><span>'+esc(x.comment)+'</span><time>'+esc(fmtTime(x.created_at))+'</time></div>'}).join('');
}
function updateMobileViewerUi(count){
  // The badge inside the video must use the same authoritative count returned
  // by the public stream status endpoint. Do not derive it from the header text.
  let value=count;
  if(value===undefined||value===null){
    const text=String(viewers.textContent||''),m=text.match(/([0-9][0-9,]*)\s+watching/);
    value=m?m[1]:0;
  }
  if(mobileViewerCount)mobileViewerCount.textContent=String(value);
  if(mobileLiveStatus){
    const isLive=statusEl.classList.contains('live')&&!String(statusEl.textContent||'').includes('REPLAY');
    mobileLiveStatus.textContent=(statusEl.textContent||'CONNECTING…').replace('● ','').toUpperCase();
    mobileLiveStatus.className='mobile-live-status'+(isLive?' live':'');
  }
}
function showMobileReaction(emoji){
  if(!mobileReactionFloaters)return;
  const el=document.createElement('span');el.className='mobile-reaction-floater';el.textContent=emoji;
  el.style.right=((mobileReactionIndex%4)*9)+'px';el.style.bottom=((mobileReactionIndex%3)*7)+'px';mobileReactionIndex++;
  mobileReactionFloaters.appendChild(el);setTimeout(function(){el.remove()},2300);
}
document.querySelectorAll('[data-mobile-reaction]').forEach(function(btn){btn.addEventListener('click',function(){showMobileReaction(btn.getAttribute('data-mobile-reaction')||'❤️')})});
new MutationObserver(updateMobileViewerUi).observe(statusEl,{subtree:true,childList:true,characterData:true});
new MutationObserver(updateMobileViewerUi).observe(viewers,{subtree:true,childList:true,characterData:true});

try{commentName.value=localStorage.getItem("fbiLiveCommentName")||""}catch{}
if(emojiOpen&&emojiPicker){
  emojiOpen.onclick=function(e){e.stopPropagation();emojiPopover.classList.toggle("open")};
  emojiPicker.addEventListener("emoji-click",function(e){
    const emoji=e.detail&&e.detail.unicode||"";
    if(!emoji)return;
    const start=commentText.selectionStart??commentText.value.length;
    const end=commentText.selectionEnd??start;
    commentText.value=commentText.value.slice(0,start)+emoji+commentText.value.slice(end);
    const pos=start+emoji.length;
    commentText.focus();
    commentText.setSelectionRange(pos,pos);
    emojiPopover.classList.remove("open");
  });
  document.addEventListener("click",function(e){
    if(emojiPopover&&!emojiPopover.contains(e.target))emojiPopover.classList.remove("open");
  });
}
function clearPlayer(){if(player){try{player.destroy()}catch{}player=null}try{video.pause();video.removeAttribute("src");video.load()}catch{}}
function startPlayer(){replayMode=false;clearPlayer();offline.style.display="none";video.style.display="block";video.muted=true;streamState.textContent="Connecting…";if(window.Hls&&Hls.isSupported()){player=new Hls({enableWorker:true,lowLatencyMode:false,liveSyncDurationCount:4,liveMaxLatencyDurationCount:12,maxLiveSyncPlaybackRate:1.08,maxBufferLength:45,maxMaxBufferLength:90,backBufferLength:60,maxBufferHole:0.5,liveSyncOnStallIncrease:2});let retryTimer=0;player.on(Hls.Events.ERROR,function(_,data){if(!data)return;if(data.fatal&&data.type===Hls.ErrorTypes.NETWORK_ERROR){streamState.textContent="Network recovery…";try{player.startLoad(-1);return}catch{}}if(data.fatal&&data.type===Hls.ErrorTypes.MEDIA_ERROR){streamState.textContent="Recovering playback…";try{player.recoverMediaError();return}catch{}}if(data.fatal){streamState.textContent="Reconnecting…";clearTimeout(retryTimer);retryTimer=setTimeout(()=>{if(live)startPlayer()},1200)}});player.on(Hls.Events.MANIFEST_PARSED,function(){streamState.textContent="Live playback";video.play().catch(()=>{})});player.on(Hls.Events.BUFFER_STALLED_ERROR,function(){streamState.textContent="Buffering…"});player.loadSource(hlsUrl);player.attachMedia(video);return}video.src=hlsUrl;video.play().catch(()=>{});streamState.textContent="Live playback"}
async function loadReplay(){
  try{
    const r=await fetch("/api/public/stream/"+encodeURIComponent(token)+"/replay",{cache:"no-store"});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error);
    if(!d.available)return false;
    clearTimeout(replayTimer);
    replayMode=true;
    clearPlayer();
    video.style.display="block";
    offline.style.display="none";
    video.muted=false;
    const replayRecordingId=d.recording&&d.recording.id?encodeURIComponent(d.recording.id):"";
    video.src="/api/public/stream/"+encodeURIComponent(token)+"/replay/file"+(replayRecordingId?"?recordingId="+replayRecordingId:"");
    video.load();
    statusEl.textContent="REPLAY";
    statusEl.className="badge live";
    viewers.textContent="Replay of the completed broadcast";
    streamState.textContent="Replay playback";
    video.play().catch(()=>{});
    return true;
  }catch(e){
    streamState.textContent=e.message||"Replay unavailable";
    return false;
  }
}
async function showOfflineOrReplay(){
  if(await loadReplay())return;
  offline.style.display="grid";
  offline.textContent="The live stream has ended. Preparing the replay…";
  video.style.display="none";
  streamState.textContent="Replay is being saved…";
  clearTimeout(replayTimer);
  replayTimer=setTimeout(()=>{if(!live)refresh()},5000);
}
async function refresh(){try{const r=await fetch("/api/public/stream/"+encodeURIComponent(token)+"/status",{cache:"no-store"}),d=await r.json();if(!r.ok)throw new Error(d.error);if(d.live){clearTimeout(replayTimer);statusEl.textContent="● LIVE";statusEl.className="badge live";const viewerCount=Number(d.current_viewers||0);viewers.textContent=viewerCount+" watching now";updateMobileViewerUi(viewerCount);if(!live||replayMode){live=true;startPlayer()}await fetch("/api/public/stream/"+encodeURIComponent(token)+"/heartbeat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionKey})});}else{if(live){live=false;clearPlayer()}statusEl.textContent="OFFLINE";statusEl.className="badge";await showOfflineOrReplay()}}catch(e){statusEl.textContent="STREAM UNAVAILABLE";statusEl.className="badge error";streamState.textContent=e.message||"Unavailable"}}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function fmtTime(v){try{return new Date(v).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}catch{return ""}}
async function loadComments(){try{const r=await fetch("/api/public/stream/"+encodeURIComponent(token)+"/comments?limit=80",{cache:"no-store"}),d=await r.json();if(!r.ok)throw new Error(d.error);const rows=d.comments||[];commentCount.textContent=rows.length;commentList.innerHTML=rows.length?rows.map(x=>'<div class="comment"><b>'+esc(x.display_name)+'</b><span>'+esc(x.comment)+'</span><time>'+esc(fmtTime(x.created_at))+'</time></div>').join(""):'<div style="color:#777;font-size:9px;padding:10px 0">No comments yet. Start the conversation.</div>';commentList.scrollTop=commentList.scrollHeight;renderMobileOverlay(rows);updateMobileViewerUi()}catch(e){commentStatus.textContent=e.message||"Comments unavailable"}}
commentForm.onsubmit=async e=>{e.preventDefault();const name=commentName.value.trim()||"Anonymous",comment=commentText.value.trim();if(!comment)return;commentStatus.textContent="Posting…";try{const r=await fetch("/api/public/stream/"+encodeURIComponent(token)+"/comments",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({display_name:name,comment})}),d=await r.json();if(!r.ok)throw new Error(d.error);try{localStorage.setItem("fbiLiveCommentName",name)}catch{}commentText.value="";commentStatus.textContent="";await loadComments()}catch(e){commentStatus.textContent=e.message||"Could not post comment"}};
updateMobileViewerUi();refresh();loadComments();setInterval(loadComments,5000);setInterval(refresh,15000);
</script></body></html>`);
  }catch(e){res.status(500).send("Could not load stream.");}
});

app.get("/api/storage",admin,async(req,res)=>{
  try{
    const r=await pool.query(`
      SELECT
        COALESCE((SELECT sum(size_bytes) FROM files),0)::numeric AS used_bytes,
        COALESCE((SELECT sum(size_bytes) FROM upload_sessions WHERE status='active'),0)::numeric AS reserved_bytes,
        (SELECT count(*) FROM files)::int AS file_count,
        (SELECT count(*) FROM projects WHERE archived=false)::int AS project_count
    `);
    const row=r.rows[0]||{};
    const used=Number(row.used_bytes||0);
    const reserved=Number(row.reserved_bytes||0);
    const quota=Math.max(0,Number(STORAGE_QUOTA_BYTES||0));
    const available=Math.max(0,quota-used-reserved);
    const percent=quota?Math.min(100,((used+reserved)/quota)*100):0;
    res.json({
      storage:{
        quota_bytes:quota,
        used_bytes:used,
        reserved_bytes:reserved,
        available_bytes:available,
        usage_percent:percent,
        file_count:Number(row.file_count||0),
        project_count:Number(row.project_count||0),
        format_quota:formatStorageBytes(quota),
        format_used:formatStorageBytes(used),
        format_reserved:formatStorageBytes(reserved),
        format_available:formatStorageBytes(available),
        storage_ready:s3Ready(),
        bucket_name:String(process.env.S3_BUCKET||""),
        bucket_region:String(process.env.S3_REGION||"")
      }
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Could not load storage information"});
  }
});

app.get("/api/uploads/pending",admin,async(req,res)=>{
  try{
    const q=await pool.query(`
      SELECT u.id,u.project_id,u.original_name,u.relative_path,u.mime_type,u.size_bytes,
             u.part_size,u.mode,u.status,u.created_at,u.updated_at,
             p.name AS project_name,p.client_name,p.archived
      FROM upload_sessions u
      JOIN projects p ON p.id=u.project_id
      WHERE u.status='active'
      ORDER BY u.updated_at DESC
      LIMIT 100
    `);
    const rows=await Promise.all(q.rows.map(async function(u){
      try{
        const state=await inspectPendingUpload(u);
        const pct=u.size_bytes?Math.min(100,state.uploadedBytes/Number(u.size_bytes)*100):0;
        return {
          id:u.id,project_id:u.project_id,project_name:u.project_name,client_name:u.client_name||"",
          archived:!!u.archived,original_name:u.original_name,relative_path:u.relative_path||"",
          mime_type:u.mime_type,size_bytes:Number(u.size_bytes||0),part_size:Number(u.part_size||0),
          mode:u.mode,status:u.status,created_at:u.created_at,updated_at:u.updated_at,
          uploaded_bytes:state.uploadedBytes,total_parts:state.totalParts,completed_parts:state.completedParts,
          missing_parts:state.missingParts,progress_percent:pct,complete_ready:!!state.completeReady
        };
      }catch(e){
        if(e&&e.code==="UPLOAD_SESSION_GONE"){
          await pool.query("UPDATE upload_sessions SET status='aborted',updated_at=now() WHERE id=$1",[u.id]).catch(function(){});
          return null;
        }
        throw e;
      }
    }));
    res.json({uploads:rows.filter(Boolean)});
  }catch(e){
    console.error("Pending upload inspection failed:",e);
    res.status(500).json({error:"Could not load pending uploads."});
  }
});

app.post("/api/uploads/:id/finalize-pending",admin,async(req,res)=>{
  try{
    if(!s3Ready())return res.status(503).json({error:"Cloud storage is not ready."});
    const q=await pool.query("SELECT * FROM upload_sessions WHERE id=$1",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
    const u=q.rows[0];

    if(u.status==="completed"){
      const done=await pool.query("SELECT * FROM files WHERE storage_path=$1 LIMIT 1",[u.storage_key]);
      return res.json({ok:true,file:done.rows[0]||null,alreadyCompleted:true});
    }

    let state;
    try{
      state=await inspectPendingUpload(u);
    }catch(e){
      if(e&&e.code==="UPLOAD_SESSION_GONE"){
        await pool.query("UPDATE upload_sessions SET status='aborted',updated_at=now() WHERE id=$1",[u.id]).catch(function(){});
        return res.status(410).json({error:"The cloud multipart session is no longer available. Select the original file again to start a fresh upload.",code:"UPLOAD_SESSION_GONE"});
      }
      throw e;
    }
    if(!state.completeReady){
      return res.status(409).json({
        ok:false,ready:false,uploadedBytes:state.uploadedBytes,
        totalSize:Number(u.size_bytes||0),missingParts:state.missingParts,
        message:"The upload is not fully present in cloud storage yet. Resume the file upload to continue."
      });
    }

    if(u.mode==="multipart"){
      const parts=state.parts.map(function(p){return {ETag:String(p.etag||"").replace(/^"+|"+$/g,""),PartNumber:Number(p.partNumber)}});
      await s3.send(new CompleteMultipartUploadCommand({
        Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,
        MultipartUpload:{Parts:parts}
      }));
    }

    const head=await headObjectWithRetry({Bucket:bucket(),Key:u.storage_key},8,400);
    const actualSize=Number(head.ContentLength||0);
    if(actualSize!==Number(u.size_bytes)){
      return res.status(409).json({ok:false,ready:false,error:"Uploaded size mismatch. The stored object is not complete yet."});
    }

    const ins=await pool.query(
      "INSERT INTO files(id,project_id,original_name,storage_name,storage_path,mime_type,size_bytes,relative_path,content_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING *",
      [uid(),u.project_id,u.original_name,path.basename(u.storage_key),u.storage_key,u.mime_type,actualSize,u.relative_path,u.content_fingerprint||null]
    );
    const fileRow=ins.rows[0]||(await pool.query("SELECT * FROM files WHERE storage_path=$1 LIMIT 1",[u.storage_key])).rows[0];
    if(!fileRow)throw new Error("Stored object is ready but the file record could not be created.");

    await pool.query("UPDATE upload_sessions SET status='completed',updated_at=now() WHERE id=$1",[u.id]);
    await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[u.project_id]);
    res.json({ok:true,file:fileRow,recovered:true});
  }catch(e){
    console.error("Pending upload finalization failed:",e);
    res.status(500).json({error:"Could not finalize the pending upload. Resume the upload and try again."});
  }
});

app.get("/api/dashboard",admin,async(req,res)=>{
  try{
    const [counts,recentProjects,recentDownloads,typeRows]=await Promise.all([
      pool.query(`SELECT
        (SELECT count(*) FROM projects WHERE archived=false) active_projects,
        (SELECT count(*) FROM projects WHERE archived=true) archived_projects,
        (SELECT count(*) FROM projects WHERE shared=true AND archived=false) shared_projects,
        (SELECT count(*) FROM files) file_count,
        COALESCE((SELECT sum(size_bytes) FROM files),0) storage_bytes,
        ${STORAGE_QUOTA_BYTES}::numeric storage_quota_bytes,
        GREATEST(0,${STORAGE_QUOTA_BYTES}::numeric-COALESCE((SELECT sum(size_bytes) FROM files),0)) storage_available_bytes,
        (SELECT count(*) FROM downloads) download_count,
        (SELECT count(*) FROM downloads WHERE downloaded_at>=now()-interval '7 days') downloads_7d,
        (SELECT count(*) FROM downloads WHERE downloaded_at>=now()-interval '30 days') downloads_30d`),
      pool.query(`SELECT p.*,
        (SELECT count(*) FROM files f WHERE f.project_id=p.id) file_count,
        COALESCE((SELECT sum(size_bytes) FROM files f WHERE f.project_id=p.id),0) total_bytes
        FROM projects p ORDER BY p.updated_at DESC LIMIT 8`),
      pool.query(`SELECT d.id,d.downloaded_at,d.ip_address,d.user_agent,
        p.name project_name,f.original_name,f.size_bytes,f.mime_type
        FROM downloads d
        LEFT JOIN projects p ON p.id=d.project_id
        LEFT JOIN files f ON f.id=d.file_id
        ORDER BY d.downloaded_at DESC LIMIT 10`),
      pool.query(`SELECT
        CASE
          WHEN mime_type LIKE 'video/%' THEN 'Video'
          WHEN mime_type LIKE 'image/%' THEN 'Photo'
          WHEN mime_type LIKE 'audio/%' THEN 'Audio'
          WHEN mime_type='application/pdf' THEN 'PDF'
          WHEN mime_type LIKE 'application/zip%' OR mime_type LIKE '%compressed%' THEN 'Archive'
          ELSE 'Other'
        END AS type,
        count(*)::int AS files,
        COALESCE(sum(size_bytes),0) AS bytes
        FROM files GROUP BY 1 ORDER BY bytes DESC`)
    ]);
    res.json({summary:counts.rows[0],recentProjects:recentProjects.rows,recentDownloads:recentDownloads.rows,types:typeRows.rows});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load dashboard"})}
});

app.get("/api/downloads",admin,async(req,res)=>{
  try{
    const q=String(req.query.q||"").trim();
    const limit=Math.max(1,Math.min(250,Number(req.query.limit||100)));
    const where=[],values=[];
    if(q){values.push(`%${q}%`);where.push(`(p.name ILIKE ${values.length} OR f.original_name ILIKE ${values.length} OR d.ip_address ILIKE ${values.length})`);}
    values.push(limit);
    const r=await pool.query(`SELECT d.id,d.downloaded_at,d.ip_address,d.user_agent,
      p.name project_name,f.original_name,f.size_bytes,f.mime_type
      FROM downloads d
      LEFT JOIN projects p ON p.id=d.project_id
      LEFT JOIN files f ON f.id=d.file_id
      ${where.length?"WHERE "+where.join(" AND "):""}
      ORDER BY d.downloaded_at DESC LIMIT ${values.length}`,values);
    res.json({downloads:r.rows});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load download records"})}
});

app.get("/api/settings",admin,async(req,res)=>{
  try{
    const settings=await loadSettings();
    res.json({
      settings:{
        studio_name:settings.studio_name,
        portal_title:settings.portal_title,
        default_client_note:settings.default_client_note,
        default_expiry_days:settingInt(settings.default_expiry_days,30),
        log_downloads:settingBool(settings.log_downloads),
        allow_client_preview:settingBool(settings.allow_client_preview),
        show_file_size:settingBool(settings.show_file_size)
      },
      infrastructure:{
        storage: s3Ready(),
        database: !!process.env.DATABASE_URL,
        public_url: PUBLIC_BASE_URL || null
      }
    });
  }catch(e){console.error(e);res.status(500).json({error:"Could not load settings"})}
});

app.patch("/api/settings",admin,async(req,res)=>{
  try{
    const allowed={
      studio_name:String(req.body.studio_name??"FBI Client File Studio").trim().slice(0,120)||"FBI Client File Studio",
      portal_title:String(req.body.portal_title??"FBI Client File Delivery").trim().slice(0,120)||"FBI Client File Delivery",
      default_client_note:String(req.body.default_client_note??"").trim().slice(0,1000),
      default_expiry_days:String(settingInt(req.body.default_expiry_days,30)),
      log_downloads:String(Boolean(req.body.log_downloads)),
      allow_client_preview:String(Boolean(req.body.allow_client_preview)),
      show_file_size:String(Boolean(req.body.show_file_size))
    };
    for(const [key,value] of Object.entries(allowed)){
      await pool.query(`INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[key,value]);
    }
    res.json({ok:true,settings:allowed});
  }catch(e){console.error(e);res.status(500).json({error:"Could not save settings"})}
});

app.post("/api/settings/password",admin,async(req,res)=>{
  try{
    const current=String(req.body.current_password||"");
    const next=String(req.body.new_password||"");
    if(next.length<10)return res.status(400).json({error:"New password must be at least 10 characters."});
    if(!(await adminPasswordMatches(current)))return res.status(401).json({error:"Current password is incorrect."});
    const hash=await hashAdminPassword(next);
    await pool.query(`INSERT INTO app_settings(key,value) VALUES('admin_password_hash',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[hash]);
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"Could not change password"})}
});

app.post("/api/portal/uploads/init",portalUser,async(req,res)=>{
 try{
  if(!s3Ready())return res.status(503).json({error:"Cloud storage is not ready."});
  const projectId=String(req.body.projectId||""),originalName=String(req.body.name||"").trim(),relativePath=safeRelativePath(req.body.relativePath,originalName),size=Number(req.body.size||0),mimeType=String(req.body.mimeType||"application/octet-stream"),fingerprint=String(req.body.fingerprint||"").trim().slice(0,128);
  const project=await portalProjectOwned(req.portalUser.id,projectId);
  if(!project)return res.status(404).json({error:"Project not found."});
  if(!originalName||!Number.isFinite(size)||size<0||size>MAX_FILE_SIZE)return res.status(400).json({error:"Invalid file."});
  if(fingerprint){
   const dup=await pool.query("SELECT * FROM files WHERE project_id=$1 AND content_fingerprint=$2 AND size_bytes=$3 LIMIT 1",[projectId,fingerprint,size]);
   if(dup.rowCount)return res.json({uploadId:null,deduplicated:true,mode:"deduplicated",size:size,file:dup.rows[0]});
  }
  const existing=await pool.query("SELECT * FROM upload_sessions WHERE project_id=$1 AND original_name=$2 AND relative_path=$3 AND size_bytes=$4 AND status='active' AND content_fingerprint=$5 ORDER BY created_at DESC LIMIT 1",[projectId,originalName,relativePath,size,fingerprint||""]);
  if(existing.rowCount){
    const u=existing.rows[0];
    if(Number(u.upload_protocol_version||0)===UPLOAD_PROTOCOL_VERSION){
      if(u.mode==="multipart"&&await multipartUploadAlive(u)){
        return res.json({uploadId:u.id,mode:u.mode,partSize:Number(u.part_size),size:Number(u.size_bytes),multipartUploadId:u.multipart_upload_id,resumed:true});
      }
      if(u.mode==="single"){
        const singleUrl=await getSignedUrl(s3,new PutObjectCommand({Bucket:bucket(),Key:u.storage_key,ContentType:u.mime_type}),{expiresIn:24*60*60});
        return res.json({uploadId:u.id,mode:"single",size:Number(u.size_bytes),url:singleUrl,resumed:true});
      }
    }
    if(u.mode==="multipart"&&u.multipart_upload_id)await s3.send(new AbortMultipartUploadCommand({Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id})).catch(function(){});
    await pool.query("UPDATE upload_sessions SET status='aborted',updated_at=now() WHERE id=$1",[u.id]);
  }
  const id=uid(),partSize=choosePartSize(size||1),mode=size>=MIN_PART_SIZE?"multipart":"single",storageKey="projects/"+projectId+"/"+id+"/"+relativePath;
  let multipartUploadId=null,url=null,createdMultipartUploadId=null;
  try{
    if(mode==="multipart"){
      const created=await s3.send(new CreateMultipartUploadCommand({Bucket:bucket(),Key:storageKey,ContentType:mimeType}));
      multipartUploadId=created.UploadId;
      createdMultipartUploadId=multipartUploadId;
    }else{
      url=await getSignedUrl(s3,new PutObjectCommand({Bucket:bucket(),Key:storageKey,ContentType:mimeType}),{expiresIn:3600});
    }
    await pool.query("INSERT INTO upload_sessions(id,project_id,original_name,relative_path,storage_key,mime_type,size_bytes,part_size,multipart_upload_id,mode,status,content_fingerprint,upload_protocol_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12)",[id,projectId,originalName,relativePath,storageKey,mimeType,size,mode==="multipart"?partSize:size,multipartUploadId,mode,fingerprint||null,UPLOAD_PROTOCOL_VERSION]);
  }catch(createOrRecordError){
    if(createdMultipartUploadId){
      await s3.send(new AbortMultipartUploadCommand({Bucket:bucket(),Key:storageKey,UploadId:createdMultipartUploadId})).catch(function(){});
    }
    throw createOrRecordError;
  }
  res.json({uploadId:id,mode:mode,partSize:mode==="multipart"?partSize:size,size:size,url:url,multipartUploadId:multipartUploadId});
 }catch(e){console.error(e);res.status(500).json({error:"Could not initialize cloud upload."})}
});
app.get("/api/portal/uploads/:id/state",portalUser,async(req,res)=>{
 try{
  const q=await pool.query("SELECT u.* FROM upload_sessions u JOIN projects p ON p.id=u.project_id WHERE u.id=$1 AND p.owner_id=$2",[req.params.id,req.portalUser.id]);
  if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
  const u=q.rows[0];
  if(u.mode!=="multipart")return res.json({uploadId:u.id,mode:u.mode,status:u.status,parts:[]});
  const parts=[];let marker=0;
  while(true){
   const r=await s3.send(new ListPartsCommand({Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,PartNumberMarker:marker||undefined,MaxParts:1000}));
   for(const p of r.Parts||[])parts.push({partNumber:p.PartNumber,etag:p.ETag,size:p.Size});
   if(!r.IsTruncated)break;marker=r.NextPartNumberMarker;
  }
  res.json({uploadId:u.id,mode:u.mode,status:u.status,partSize:Number(u.part_size),size:Number(u.size_bytes),parts:parts});
 }catch(e){
  const code=String(e?.Code||e?.name||"");
  const status=Number(e?.$metadata?.httpStatusCode||0);
  if(code==="NoSuchUpload"||code==="InvalidUploadId"||status===404){
    await pool.query("UPDATE upload_sessions SET status='aborted',updated_at=now() WHERE id=$1",[req.params.id]).catch(function(){});
    return res.status(410).json({error:"The cloud multipart session is no longer available.",code:"UPLOAD_SESSION_GONE"});
  }
  console.error(e);res.status(500).json({error:"Could not read upload state."});
 }
});
app.post("/api/portal/uploads/:id/parts",portalUser,async(req,res)=>{
 try{
  const q=await pool.query("SELECT u.* FROM upload_sessions u JOIN projects p ON p.id=u.project_id WHERE u.id=$1 AND p.owner_id=$2",[req.params.id,req.portalUser.id]);
  if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
  const u=q.rows[0];
  await pool.query("UPDATE upload_sessions SET updated_at=now() WHERE id=$1 AND status='active'",[u.id]);
  if(u.mode!=="multipart"||!u.multipart_upload_id)return res.status(400).json({error:"This upload does not use multipart storage."});
  const alive=await multipartUploadAlive(u);
  if(!alive){
    await pool.query("UPDATE upload_sessions SET status='aborted',updated_at=now() WHERE id=$1",[u.id]);
    return res.status(409).json({error:"The cloud multipart session is no longer available. A new upload session is required.",code:"UPLOAD_SESSION_GONE"});
  }
  const totalParts=Math.max(1,Math.ceil(Number(u.size_bytes||0)/Math.max(1,Number(u.part_size||MIN_PART_SIZE))));
  const requestedRaw=(Array.isArray(req.body.parts)?req.body.parts:[]).map(function(x){return {partNumber:Number(x.partNumber)}});
  const requested=Array.from(new Set(requestedRaw.filter(function(x){return Number.isInteger(x.partNumber)&&x.partNumber>0&&x.partNumber<=MAX_PARTS&&x.partNumber<=totalParts}).map(function(x){return x.partNumber}))).map(function(partNumber){return {partNumber:partNumber}});
  if(!requested.length||requested.length>25)return res.status(400).json({error:"Provide 1 to 25 part numbers."});
  const parts=await Promise.all(requested.map(async function(x){
   const partUrl=await getSignedUrl(s3,new UploadPartCommand({Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,PartNumber:x.partNumber}),{expiresIn:PRESIGN_SECONDS});
   return {partNumber:x.partNumber,url:partUrl,checksum:null};
  }));
  res.json({parts:parts,expiresIn:PRESIGN_SECONDS});
 }catch(e){console.error(e);res.status(500).json({error:"Could not create upload URLs."})}
});
app.post("/api/portal/uploads/:id/complete",portalUser,async(req,res)=>{
 try{
  const q=await pool.query("SELECT u.* FROM upload_sessions u JOIN projects p ON p.id=u.project_id WHERE u.id=$1 AND p.owner_id=$2",[req.params.id,req.portalUser.id]);
  if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
  const u=q.rows[0];

  if(u.status==="completed"){
    const done=await pool.query("SELECT * FROM files WHERE storage_path=$1 LIMIT 1",[u.storage_key]);
    return res.json({ok:true,file:done.rows[0]||null,alreadyCompleted:true});
  }

  const alreadyStored=await pool.query("SELECT * FROM files WHERE storage_path=$1 LIMIT 1",[u.storage_key]);
  if(alreadyStored.rowCount){
    await pool.query("UPDATE upload_sessions SET status='completed',updated_at=now() WHERE id=$1",[u.id]);
    await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[u.project_id]);
    return res.json({ok:true,file:alreadyStored.rows[0],alreadyCompleted:true});
  }

  if(u.mode==="multipart"){
   let objectReady=false;
   try{
    await headObjectWithRetry({Bucket:bucket(),Key:u.storage_key},2,300);
    objectReady=true;
   }catch{}

   if(!objectReady){
    const state=await inspectPendingUpload(u);
    const expectedParts=Math.max(1,Math.ceil(Number(u.size_bytes||0)/Number(u.part_size||MIN_PART_SIZE)));
    if(state.completedParts!==expectedParts||state.uploadedBytes!==Number(u.size_bytes||0)){
      return res.status(409).json({error:"Multipart upload is not complete yet.",ready:false,uploadedBytes:state.uploadedBytes,totalSize:Number(u.size_bytes||0),completedParts:state.completedParts,totalParts:expectedParts,missingParts:state.missingParts});
    }
    const parts=state.parts.map(function(p){return {ETag:String(p.etag||"").replace(/^"+|"+$/g,""),PartNumber:Number(p.partNumber)}}).filter(function(p){return p.ETag&&Number.isInteger(p.PartNumber)&&p.PartNumber>0}).sort(function(a,b){return a.PartNumber-b.PartNumber});
    await s3.send(new CompleteMultipartUploadCommand({Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,MultipartUpload:{Parts:parts}}));
   }
  }

  const head=await headObjectWithRetry({Bucket:bucket(),Key:u.storage_key},8,400);
  const actualSize=Number(head.ContentLength||0);
  if(actualSize!==Number(u.size_bytes))return res.status(400).json({error:"Uploaded size mismatch. The transfer is complete but the stored size is different; please resume and complete again."});

  const ins=await pool.query(
    "INSERT INTO files(id,project_id,original_name,storage_name,storage_path,mime_type,size_bytes,relative_path,content_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING *",
    [uid(),u.project_id,u.original_name,path.basename(u.storage_key),u.storage_key,u.mime_type,actualSize,u.relative_path,u.content_fingerprint||null]
  );
  const fileRow=ins.rows[0]||(await pool.query("SELECT * FROM files WHERE storage_path=$1 LIMIT 1",[u.storage_key])).rows[0];
  if(!fileRow)throw new Error("Stored object is ready but the file record could not be created.");

  await pool.query("UPDATE upload_sessions SET status='completed',updated_at=now() WHERE id=$1",[u.id]);
  await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[u.project_id]);
  res.json({ok:true,file:fileRow});
 }catch(e){console.error("Portal upload finalization failed:",e);res.status(500).json({error:"Upload reached storage but could not be registered in the project. Please resume the upload; it will safely continue from the stored data."})}
});
app.post("/api/portal/uploads/:id/abort",portalUser,async(req,res)=>{
 try{
  const q=await pool.query("SELECT u.* FROM upload_sessions u JOIN projects p ON p.id=u.project_id WHERE u.id=$1 AND p.owner_id=$2",[req.params.id,req.portalUser.id]);
  if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
  const u=q.rows[0];
  if(u.mode==="multipart"&&u.multipart_upload_id)await s3.send(new AbortMultipartUploadCommand({Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id})).catch(function(){});
  else await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:u.storage_key})).catch(function(){});
  await pool.query("UPDATE upload_sessions SET status='aborted',updated_at=now() WHERE id=$1",[u.id]);
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Could not cancel upload."})}
});
app.post("/api/uploads/init",admin,async(req,res)=>{
  try{
    if(!s3Ready())return res.status(503).json({error:"Cloud storage is not ready."});
    var projectId=String(req.body.projectId||"");
    var originalName=String(req.body.name||"").trim();
    var relativePath=safeRelativePath(req.body.relativePath,originalName);
    var size=Number(req.body.size||0);
    var mimeType=String(req.body.mimeType||"application/octet-stream");
    var fingerprint=String(req.body.fingerprint||"").trim().slice(0,128);
    var checksum=String(req.body.checksum||"").trim().slice(0,128);
    if(!projectId||!originalName)return res.status(400).json({error:"Project and file name are required."});
    if(!Number.isFinite(size)||size<0||size>MAX_FILE_SIZE)return res.status(400).json({error:"File size is outside the supported range."});
    var pr=await pool.query("SELECT id FROM projects WHERE id=$1 AND archived=false",[projectId]);
    if(!pr.rowCount)return res.status(404).json({error:"Project not found."});

    var existingSql="SELECT * FROM upload_sessions WHERE project_id=$1 AND original_name=$2 AND relative_path=$3 AND size_bytes=$4 AND status='active'";
    var existingValues=[projectId,originalName,relativePath,size];
    if(fingerprint){
      existingSql+=" AND content_fingerprint=$5";
      existingValues.push(fingerprint);
    }else{
      existingSql+=" AND content_fingerprint IS NULL";
    }
    existingSql+=" ORDER BY created_at DESC LIMIT 1";
    var existing=await pool.query(existingSql,existingValues);
    var restartedLegacy=false;
    if(existing.rowCount){
      var u=existing.rows[0];
      if(Number(u.upload_protocol_version||0)!==UPLOAD_PROTOCOL_VERSION){
        // Retire sessions created by an older multipart protocol. Selecting the
        // same file again then creates a clean current-protocol session automatically.
        if(u.mode==="multipart"&&u.multipart_upload_id){
          await s3.send(new AbortMultipartUploadCommand({
            Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id
          })).catch(function(){});
        }else{
          await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:u.storage_key})).catch(function(){});
        }
        await pool.query("UPDATE upload_sessions SET status='aborted',updated_at=now() WHERE id=$1",[u.id]);
        restartedLegacy=true;
      }else if(u.mode==="multipart"){
        // The database row can outlive the underlying S3 multipart session.
        // Validate the real object-storage upload before handing the session
        // back to the browser. If it is gone, retire the stale row and create
        // a clean multipart session below.
        const alive=await multipartUploadAlive(u);
        if(alive){
          return res.json({
            uploadId:u.id,mode:u.mode,partSize:Number(u.part_size),size:Number(u.size_bytes),
            multipartUploadId:u.multipart_upload_id,resumed:true
          });
        }

        // A multipart session can disappear because it was already completed
        // just before the browser lost the final response. Before creating a
        // replacement session, check whether the final object already exists.
        let recoveredObject=null;
        try{
          recoveredObject=await headObjectWithRetry({Bucket:bucket(),Key:u.storage_key},3,300);
        }catch{}
        if(recoveredObject&&Number(recoveredObject.ContentLength||0)===Number(u.size_bytes)){
          const existingFile=await pool.query("SELECT * FROM files WHERE storage_path=$1 LIMIT 1",[u.storage_key]);
          let fileRow=existingFile.rows[0];
          if(!fileRow){
            const ins=await pool.query(
              "INSERT INTO files(id,project_id,original_name,storage_name,storage_path,mime_type,size_bytes,relative_path,content_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING *",
              [uid(),u.project_id,u.original_name,path.basename(u.storage_key),u.storage_key,u.mime_type,Number(recoveredObject.ContentLength),u.relative_path,u.content_fingerprint||null]
            );
            fileRow=ins.rows[0]||(await pool.query("SELECT * FROM files WHERE storage_path=$1 LIMIT 1",[u.storage_key])).rows[0];
          }
          if(fileRow){
            await pool.query("UPDATE upload_sessions SET status='completed',updated_at=now() WHERE id=$1",[u.id]);
            await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[u.project_id]);
            return res.json({uploadId:u.id,mode:"multipart",size:Number(u.size_bytes),resumed:true,alreadyCompleted:true,file:fileRow});
          }
        }

        await s3.send(new AbortMultipartUploadCommand({
          Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id
        })).catch(function(){});
        await pool.query("UPDATE upload_sessions SET status='aborted',updated_at=now() WHERE id=$1",[u.id]);
        restartedLegacy=true;
      }else{
        var singleUrl=await getSignedUrl(
          s3,
          new PutObjectCommand({Bucket:bucket(),Key:u.storage_key,ContentType:u.mime_type}),
          {expiresIn:24*60*60}
        );
        return res.json({uploadId:u.id,mode:"single",size:Number(u.size_bytes),url:singleUrl,resumed:true});
      }
    }

    if(fingerprint){
      var dup=await pool.query(
        "SELECT * FROM files WHERE project_id=$1 AND content_fingerprint=$2 AND size_bytes=$3 ORDER BY created_at DESC LIMIT 1",
        [projectId,fingerprint,size]
      );
      if(dup.rowCount){
        return res.json({uploadId:null,deduplicated:true,resumed:false,mode:"deduplicated",size:size,file:dup.rows[0]});
      }
    }
    var usage=await pool.query(
      "SELECT COALESCE((SELECT sum(size_bytes) FROM files),0)::numeric stored, COALESCE((SELECT sum(size_bytes) FROM upload_sessions WHERE status='active'),0)::numeric reserved"
    );
    var stored=Number(usage.rows[0]?.stored||0),reserved=Number(usage.rows[0]?.reserved||0);
    if(stored+reserved+size>STORAGE_QUOTA_BYTES){
      return res.status(413).json({error:"Studio storage quota reached.",quotaBytes:STORAGE_QUOTA_BYTES,usedBytes:stored,reservedBytes:reserved,availableBytes:Math.max(0,STORAGE_QUOTA_BYTES-stored-reserved)});
    }
    var id=uid();
    var partSize=choosePartSize(size||1);
    var mode=size>=MIN_PART_SIZE?"multipart":"single";
    var storageKey="projects/"+projectId+"/"+id+"/"+relativePath;
    var multipartUploadId=null;
    var url=null;
    var createdMultipartUploadId=null;
    try{
      if(mode==="multipart"){
        // Plain multipart upload. Browser uploads do not pre-hash multi-GB files,
        // so do not opt into composite SHA-256 checksums for those uploads.
        var created=await s3.send(new CreateMultipartUploadCommand({
          Bucket:bucket(),Key:storageKey,ContentType:mimeType
        }));
        multipartUploadId=created.UploadId;
        createdMultipartUploadId=multipartUploadId;
      }else{
        var putInput={Bucket:bucket(),Key:storageKey,ContentType:mimeType};
        if(checksum)putInput.ChecksumSHA256=checksum;
        url=await getSignedUrl(s3,new PutObjectCommand(putInput),{expiresIn:3600});
      }
      await pool.query(
        "INSERT INTO upload_sessions(id,project_id,original_name,relative_path,storage_key,mime_type,size_bytes,part_size,multipart_upload_id,mode,status,content_fingerprint,upload_protocol_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12)",
        [id,projectId,originalName,relativePath,storageKey,mimeType,size,mode==="multipart"?partSize:size,multipartUploadId,mode,fingerprint||null,UPLOAD_PROTOCOL_VERSION]
      );
    }catch(createOrRecordError){
      if(createdMultipartUploadId){
        await s3.send(new AbortMultipartUploadCommand({
          Bucket:bucket(),Key:storageKey,UploadId:createdMultipartUploadId
        })).catch(function(){});
      }
      throw createOrRecordError;
    }
    res.json({uploadId:id,mode,partSize,size,url,multipartUploadId,checksum:checksum||null,fingerprint:fingerprint||null,restartedLegacy});
  }catch(e){console.error(e);res.status(500).json({error:"Could not initialize cloud upload."})}
});

app.post("/api/uploads/:id/heartbeat",admin,async(req,res)=>{
  try{
    const q=await pool.query("UPDATE upload_sessions SET updated_at=now() WHERE id=$1 AND status='active' RETURNING id,updated_at",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Upload session not found or already completed."});
    res.json({ok:true,updatedAt:q.rows[0].updated_at});
  }catch(e){
    console.error("Upload heartbeat failed:",e);
    res.status(500).json({error:"Could not update upload heartbeat."});
  }
});

app.get("/api/uploads/:id/state",admin,async(req,res)=>{
  try{
    var q=await pool.query("SELECT * FROM upload_sessions WHERE id=$1",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
    var u=q.rows[0];
    if(u.mode!=="multipart")return res.json({uploadId:u.id,mode:u.mode,status:u.status,parts:[]});
    var parts=[];
    var marker=0;
    while(true){
      var r=await s3.send(new ListPartsCommand({
        Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,
        PartNumberMarker:marker||undefined,MaxParts:1000
      }));
      for(var i=0;i<(r.Parts||[]).length;i++){
        var p=r.Parts[i];
        parts.push({partNumber:p.PartNumber,etag:p.ETag,size:p.Size});
      }
      if(!r.IsTruncated)break;
      marker=r.NextPartNumberMarker;
    }
    res.json({uploadId:u.id,mode:u.mode,status:u.status,partSize:Number(u.part_size),size:Number(u.size_bytes),parts:parts});
  }catch(e){
    const code=String(e?.Code||e?.name||"");
    const status=Number(e?.$metadata?.httpStatusCode||0);
    if(code==="NoSuchUpload"||code==="InvalidUploadId"||status===404){
      await pool.query("UPDATE upload_sessions SET status='aborted',updated_at=now() WHERE id=$1",[req.params.id]).catch(function(){});
      return res.status(410).json({error:"The cloud multipart session is no longer available.",code:"UPLOAD_SESSION_GONE"});
    }
    console.error(e);
    res.status(500).json({error:"Could not read upload state."});
  }
});

app.post("/api/uploads/:id/parts",admin,async(req,res)=>{
  try{
    if(!s3Ready())return res.status(503).json({error:"Cloud storage is not ready."});
    var q=await pool.query("SELECT * FROM upload_sessions WHERE id=$1",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
    var u=q.rows[0];
    await pool.query("UPDATE upload_sessions SET updated_at=now() WHERE id=$1 AND status='active'",[u.id]);
    if(u.mode!=="multipart"||!u.multipart_upload_id)return res.status(400).json({error:"This upload does not use multipart storage."});
    const alive=await multipartUploadAlive(u);
    if(!alive){
      await pool.query("UPDATE upload_sessions SET status='aborted',updated_at=now() WHERE id=$1",[u.id]);
      return res.status(409).json({error:"The cloud multipart session is no longer available. A new upload session is required.",code:"UPLOAD_SESSION_GONE"});
    }
    var requested=Array.isArray(req.body.parts)?req.body.parts.map(function(x){return {partNumber:Number(x.partNumber),checksum:String(x.checksum||"").trim()};}):[];
    if(!requested.length&&Array.isArray(req.body.partNumbers)){
      requested=req.body.partNumbers.map(function(n){return {partNumber:Number(n),checksum:""};});
    }
    var totalParts=Math.max(1,Math.ceil(Number(u.size_bytes||0)/Math.max(1,Number(u.part_size||MIN_PART_SIZE))));
    requested=requested.filter(function(x){return Number.isInteger(x.partNumber)&&x.partNumber>0&&x.partNumber<=MAX_PARTS&&x.partNumber<=totalParts;});
    requested=Array.from(new Set(requested.map(function(x){return x.partNumber;}))).map(function(partNumber){return {partNumber:partNumber,checksum:""};});
    if(!requested.length||requested.length>25)return res.status(400).json({error:"Provide 1 to 25 part numbers."});
    var parts=[];
    for(var i=0;i<requested.length;i++){
      var partNumber=requested[i].partNumber;
      var checksum=requested[i].checksum;
      var commandInput={Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,PartNumber:partNumber};
      if(checksum)commandInput.ChecksumSHA256=checksum;
      var partUrl=await getSignedUrl(s3,new UploadPartCommand(commandInput),{expiresIn:PRESIGN_SECONDS});
      parts.push({partNumber:partNumber,url:partUrl,checksum:checksum||null});
    }
    res.json({parts:parts,expiresIn:PRESIGN_SECONDS});
  }catch(e){console.error(e);res.status(500).json({error:"Could not create upload URLs."})}
});

app.post("/api/uploads/:id/complete",admin,async(req,res)=>{
  try{
    if(!s3Ready())return res.status(503).json({error:"Cloud storage is not ready."});
    var q=await pool.query("SELECT * FROM upload_sessions WHERE id=$1",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
    var u=q.rows[0];

    if(u.status==="completed"){
      var done=await pool.query("SELECT * FROM files WHERE storage_path=$1 LIMIT 1",[u.storage_key]);
      return res.json({ok:true,file:done.rows[0]||null,alreadyCompleted:true});
    }

    var alreadyStored=await pool.query("SELECT * FROM files WHERE storage_path=$1 LIMIT 1",[u.storage_key]);
    if(alreadyStored.rowCount){
      await pool.query("UPDATE upload_sessions SET status='completed',updated_at=now() WHERE id=$1",[u.id]);
      await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[u.project_id]);
      return res.json({ok:true,file:alreadyStored.rows[0],alreadyCompleted:true});
    }

    if(u.mode==="multipart"){
      // The bucket is the authoritative source of completed parts. Do not trust
      // the browser's in-memory part list because a successful PUT can be followed
      // by a lost response, a tab refresh, or a service restart.
      let objectReady=false;
      try{
        await headObjectWithRetry({Bucket:bucket(),Key:u.storage_key},2,300);
        objectReady=true;
      }catch{}

      if(!objectReady){
        const state=await inspectPendingUpload(u);
        const expectedParts=Math.max(1,Math.ceil(Number(u.size_bytes||0)/Number(u.part_size||MIN_PART_SIZE)));
        if(state.completedParts!==expectedParts || state.uploadedBytes!==Number(u.size_bytes||0)){
          return res.status(409).json({
            error:"Multipart upload is not complete yet.",
            ready:false,
            uploadedBytes:state.uploadedBytes,
            totalSize:Number(u.size_bytes||0),
            completedParts:state.completedParts,
            totalParts:expectedParts,
            missingParts:state.missingParts
          });
        }
        const parts=state.parts.map(function(p){
          return {ETag:String(p.etag||"").replace(/^"+|"+$/g,""),PartNumber:Number(p.partNumber)};
        }).filter(function(p){return p.ETag&&Number.isInteger(p.PartNumber)&&p.PartNumber>0;})
          .sort(function(a,b){return a.PartNumber-b.PartNumber;});
        await s3.send(new CompleteMultipartUploadCommand({
          Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,
          MultipartUpload:{Parts:parts}
        }));
      }
    }

    var head=await headObjectWithRetry({Bucket:bucket(),Key:u.storage_key},8,400);
    var actualSize=Number(head.ContentLength||0);
    if(actualSize!==Number(u.size_bytes)){
      return res.status(400).json({error:"Uploaded size mismatch. The transfer is complete but the stored size is different; please resume and complete again."});
    }

    var ins=await pool.query(
      "INSERT INTO files(id,project_id,original_name,storage_name,storage_path,mime_type,size_bytes,relative_path,content_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING *",
      [uid(),u.project_id,u.original_name,path.basename(u.storage_key),u.storage_key,u.mime_type,actualSize,u.relative_path,u.content_fingerprint||null]
    );
    var fileRow=ins.rows[0];
    if(!fileRow)fileRow=(await pool.query("SELECT * FROM files WHERE storage_path=$1 LIMIT 1",[u.storage_key])).rows[0];
    if(!fileRow)throw new Error("Stored object is ready but the file record could not be created.");

    await pool.query("UPDATE upload_sessions SET status='completed',updated_at=now() WHERE id=$1",[u.id]);
    await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[u.project_id]);
    res.json({ok:true,file:fileRow});
  }catch(e){console.error("Admin upload finalization failed:",e);res.status(500).json({error:"Upload reached storage but could not be registered in the project. Please resume the upload; it will safely continue from the stored data."})}
});
app.post("/api/uploads/:id/abort",admin,async(req,res)=>{
  try{
    var q=await pool.query("SELECT * FROM upload_sessions WHERE id=$1",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
    var u=q.rows[0];
    if(u.mode==="multipart"&&u.multipart_upload_id){
      await s3.send(new AbortMultipartUploadCommand({Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id})).catch(function(){});
    }else if(s3Ready()){
      await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:u.storage_key})).catch(function(){});
    }
    await pool.query("UPDATE upload_sessions SET status='aborted',updated_at=now() WHERE id=$1",[u.id]);
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"Could not cancel upload."})}
});

app.post("/api/projects/:id/files",admin,(req,res)=>{
 if(!s3Ready())return res.status(503).json({error:"Cloud file storage is not ready yet. Try again in a moment."});
 const projectId=req.params.id;
 const bb=Busboy({headers:req.headers,limits:{files:100,fileSize:MAX_FILE_SIZE}});
 const jobs=[];const staged=[];let uploadError=null;

 bb.on("field",()=>{});
 bb.on("file",(field,file,info)=>{
   if(field!=="files"){file.resume();return}
   const id=uid();
   const originalName=String(info.filename||"file");
   const storagePath=`projects/${projectId}/${id}/${safeName(originalName)}`;
   let tooLarge=false;
   file.on("limit",()=>{tooLarge=true;uploadError=new Error("A file exceeded the 10 GB limit.")});
   const uploader=new Upload({
     client:s3,
     params:{Bucket:bucket(),Key:storagePath,Body:file,ContentType:info.mimeType||"application/octet-stream"}
   });
   const job=uploader.done().then(async()=>{
     if(tooLarge)throw new Error("A file exceeded the 10 GB limit.");
     const head=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:storagePath}));
     const size=Number(head.ContentLength||0);
     const r=await pool.query("INSERT INTO files(id,project_id,original_name,storage_name,storage_path,mime_type,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[id,projectId,originalName,path.basename(storagePath),storagePath,info.mimeType||"application/octet-stream",size]);
     staged.push({id,storagePath});
     return r.rows[0];
   }).catch(e=>{uploadError=e;throw e});
   jobs.push(job);
 });
 bb.on("finish",async()=>{
   try{
     const project=await pool.query("SELECT id FROM projects WHERE id=$1",[projectId]);if(!project.rowCount)throw new Error("Project not found");
     const results=await Promise.all(jobs);
     await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[projectId]);
     res.json({files:results});
   }catch(e){
     console.error(e);
     for(const x of staged)await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:x.storagePath})).catch(()=>{});
     res.status(400).json({error:uploadError?.message||e.message||"Upload failed"});
   }
 });
 bb.on("error",e=>{console.error(e);if(!res.headersSent)res.status(400).json({error:e.message||"Upload failed"})});
 req.pipe(bb);
});

app.delete("/api/files/:id",admin,async(req,res)=>{
 try{
  const r=await pool.query("SELECT * FROM files WHERE id=$1",[req.params.id]);if(!r.rowCount)return res.status(404).json({error:"File not found"});
  const f=r.rows[0];if(s3Ready())await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:f.storage_path}));
  await pool.query("DELETE FROM files WHERE id=$1",[f.id]);await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[f.project_id]);
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Could not delete file"})}
});

async function signedFileUrl(fileId,tokenValue=null){
 const q=await pool.query("SELECT f.*,p.shared,p.share_token,p.expires_at FROM files f JOIN projects p ON p.id=f.project_id WHERE f.id=$1",[fileId]);if(!q.rowCount)return null;
 const f=q.rows[0];
 if(tokenValue!==null){
   if(f.share_token!==tokenValue||!f.shared||(f.expires_at&&new Date(f.expires_at).getTime()<Date.now()))return null;
 } 
 if(!s3Ready())throw new Error("Cloud file storage is not ready");
 const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:f.storage_path}),{expiresIn:900});
 return {f,url};
}

app.get("/api/admin/file/:id",admin,async(req,res)=>{
 try{
  const out=await signedFileUrl(req.params.id);if(!out)return res.status(404).send("File not found");
  res.redirect(out.url);
 }catch(e){console.error(e);res.status(500).send("Unable to serve file")}
});

app.get("/api/admin/thumb/:id",admin,async(req,res)=>{
 try{
  const q=await pool.query("SELECT id,original_name,storage_path,mime_type FROM files WHERE id=$1",[req.params.id]);
  if(!q.rowCount)return res.status(404).send("File not found");
  const f=q.rows[0];
  const width=Math.max(160,Math.min(640,Number(req.query.w||360))),height=Math.max(160,Math.min(720,Number(req.query.h||540)));
  const kind=thumbKind(f),cacheKind=kind==="video"?"video-v2":kind;
  const cacheKey="admin:"+f.id+":"+cacheKind+":"+width+"x"+height,cached=getThumbCache(cacheKey);
  if(cached)return res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").set("X-Content-Type-Options","nosniff").send(cached.buffer);
  const thumbKey="__admin-thumbnails/"+crypto.createHash("sha1").update(String(f.id)+"|"+cacheKind+"|"+width+"|"+height).digest("hex")+".webp";
  try{
    const head=await s3.send(new HeadObjectCommand({Bucket:bucket(),Key:thumbKey}));
    if(head.ContentLength){
      const got=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:thumbKey}));
      const bytes=got.Body?.transformToByteArray?Buffer.from(await got.Body.transformToByteArray()):Buffer.from(await new Promise((resolve,reject)=>{const chunks=[];got.Body.on("data",c=>chunks.push(c));got.Body.on("end",()=>resolve(Buffer.concat(chunks)));got.Body.on("error",reject)}));
      setThumbCache(cacheKey,bytes);
      return res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").set("X-Content-Type-Options","nosniff").send(bytes);
    }
  }catch(_e){}
  const webp=await generateThumbnail(f,width,height);
  setThumbCache(cacheKey,webp);
  try{
    await s3.send(new PutObjectCommand({Bucket:bucket(),Key:thumbKey,Body:webp,ContentType:"image/webp",CacheControl:"private, max-age=31536000, immutable",Metadata:{source_file_id:String(f.id),generated_by:"fbi-client-file-studio-admin-media-aware"}}));
  }catch(err){console.warn("Could not persist admin thumbnail",err?.message||err)}
  res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").set("X-Content-Type-Options","nosniff").send(webp);
 }catch(e){console.error("Admin thumbnail generation failed",e?.stack||e);res.status(500).send("Unable to generate thumbnail");}
});
app.get("/api/public/share/:token",async(req,res)=>{
 try{
  const q=await pool.query("SELECT id,name,client_name,note,expires_at FROM projects WHERE share_token=$1 AND shared=true",[req.params.token]);
  if(!q.rowCount)return res.status(404).json({error:"This delivery link is invalid, disabled, or expired."});
  const p=q.rows[0];if(p.expires_at&&new Date(p.expires_at).getTime()<Date.now())return res.status(404).json({error:"This delivery link has expired."});
  const f=await pool.query("SELECT id,original_name,relative_path,mime_type,size_bytes,created_at FROM files WHERE project_id=$1 ORDER BY relative_path ASC,created_at DESC",[p.id]);
  const base=PUBLIC_BASE_URL||`${req.protocol}://${req.get("host")}`;
  const settings=await loadSettings();
  res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma","no-cache");
  res.set("Expires","0");
  res.json({project:p,settings:{portal_title:settings.portal_title,allow_client_preview:settingBool(settings.allow_client_preview),show_file_size:settingBool(settings.show_file_size)},files:f.rows.map(x=>({...x,download_url:`${base}/api/public/file/${x.id}?token=${encodeURIComponent(req.params.token)}`}))});
 }catch(e){console.error(e);res.status(500).json({error:"Could not load delivery"})}
});

app.get("/api/public/thumb/:id",async(req,res)=>{
 try{
  const out=await signedFileUrl(req.params.id,String(req.query.token||""));
  if(!out)return res.status(404).send("Invalid or expired delivery link.");
  const width=Math.max(240,Math.min(720,Number(req.query.w||420))),height=Math.max(160,Math.min(720,Number(req.query.h||540)));
  const kind=thumbKind(out.f),cacheKind=kind==="video"?"video-v2":kind;
  const cacheKey=out.f.id+":"+cacheKind+":"+width+"x"+height+":natural";
  const cached=getThumbCache(cacheKey);
  if(cached)return res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").set("X-Content-Type-Options","nosniff").send(cached.buffer);
  const thumbKey="__thumbnails/"+crypto.createHash("sha1").update(String(out.f.id)+"|"+cacheKind+"|"+width+"|"+height+"|natural").digest("hex")+".webp";
  try{
    const head=await s3.send(new HeadObjectCommand({Bucket:bucket(),Key:thumbKey}));
    if(head.ContentLength){
      const got=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:thumbKey}));
      const bytes=got.Body?.transformToByteArray?Buffer.from(await got.Body.transformToByteArray()):Buffer.from(await new Promise((resolve,reject)=>{const chunks=[];got.Body.on("data",c=>chunks.push(c));got.Body.on("end",()=>resolve(Buffer.concat(chunks)));got.Body.on("error",reject)}));
      setThumbCache(cacheKey,bytes);
      return res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").set("X-Content-Type-Options","nosniff").send(bytes);
    }
  }catch(_e){}
  const webp=await generateThumbnail(out.f,width,height);
  setThumbCache(cacheKey,webp);
  try{
    await s3.send(new PutObjectCommand({Bucket:bucket(),Key:thumbKey,Body:webp,ContentType:"image/webp",CacheControl:"private, max-age=31536000, immutable",Metadata:{source_file_id:String(out.f.id),generated_by:"fbi-client-file-studio-media-aware"}}));
  }catch(err){console.warn("Could not persist public thumbnail",err?.message||err)}
  res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").set("X-Content-Type-Options","nosniff").send(webp);
 }catch(e){console.error("Thumbnail generation failed",e?.stack||e);res.status(500).send("Unable to generate thumbnail");}
});
app.get("/api/public/preview/:id",async(req,res)=>{
 try{
  const out=await signedFileUrl(req.params.id,String(req.query.token||""));
  if(!out)return res.status(404).send("Invalid or expired delivery link.");
  if(!/^image\//i.test(out.f.mime_type||""))return res.status(415).send("Image preview only.");
  const width=Math.max(600,Math.min(1800,Number(req.query.w||1400)));
  const height=Math.max(400,Math.min(1200,Number(req.query.h||1000)));
  const cacheKey=out.f.id+":preview:"+width+"x"+height;
  const cached=getThumbCache(cacheKey);
  if(cached){
    return res.status(200).type("image/webp").set("Cache-Control","private, max-age=3600, stale-while-revalidate=86400").send(cached.buffer);
  }
  const previewKey="__previews/"+crypto.createHash("sha1").update(String(out.f.id)+"|"+width+"|"+height).digest("hex")+".webp";
  try{
    const head=await s3.send(new HeadObjectCommand({Bucket:bucket(),Key:previewKey}));
    if(head.ContentLength){
      const got=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:previewKey}));
      const bytes=got.Body?.transformToByteArray ? Buffer.from(await got.Body.transformToByteArray()) : Buffer.from(await new Promise((resolve,reject)=>{
        const chunks=[];got.Body.on("data",c=>chunks.push(c));got.Body.on("end",()=>resolve(Buffer.concat(chunks)));got.Body.on("error",reject);
      }));
      setThumbCache(cacheKey,bytes);
      return res.status(200).type("image/webp").set("Cache-Control","private, max-age=3600, stale-while-revalidate=86400").send(bytes);
    }
  }catch(_e){}
  const obj=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:out.f.storage_path}));
  const input=obj.Body?.transformToByteArray ? Buffer.from(await obj.Body.transformToByteArray()) : Buffer.from(await new Promise((resolve,reject)=>{
    const chunks=[];obj.Body.on("data",c=>chunks.push(c));obj.Body.on("end",()=>resolve(Buffer.concat(chunks)));obj.Body.on("error",reject);
  }));
  const webp=await sharp(input).rotate().resize({width,height,fit:"inside",withoutEnlargement:true}).webp({quality:82,method:4}).toBuffer();
  setThumbCache(cacheKey,webp);
  try{await s3.send(new PutObjectCommand({Bucket:bucket(),Key:previewKey,Body:webp,ContentType:"image/webp",CacheControl:"private, max-age=31536000, immutable",Metadata:{source_file_id:String(out.f.id),generated_by:"fbi-client-file-studio"}}))}catch(err){console.warn("Could not persist preview",err?.message||err)}
  res.status(200).type("image/webp").set("Cache-Control","private, max-age=3600, stale-while-revalidate=86400").send(webp);
 }catch(e){
  console.error("Image preview generation failed",e?.stack||e);
  res.status(500).send("Unable to generate preview");
 }
});

app.get("/api/public/file/:id",async(req,res)=>{
 try{
  const out=await signedFileUrl(req.params.id,String(req.query.token||""));if(!out)return res.status(404).send("Invalid or expired delivery link.");
  const settings=await loadSettings();
  if(settingBool(settings.log_downloads)){
    await pool.query("INSERT INTO downloads(project_id,file_id,user_agent,ip_address) VALUES($1,$2,$3,$4)",[out.f.project_id,out.f.id,String(req.headers["user-agent"]||"").slice(0,1000),clientIp(req)]);
  }
  const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:out.f.storage_path}),{expiresIn:900,responseContentDisposition:req.query.download==="1"?`attachment; filename*=UTF-8''${encodeURIComponent(out.f.original_name)}`:`inline; filename*=UTF-8''${encodeURIComponent(out.f.original_name)}`});
  res.redirect(url);
 }catch(e){console.error(e);res.status(500).send("Unable to serve file")}
});

app.get("/share/:token/manifest.webmanifest",async(req,res)=>{
  try{
    const tokenValue=String(req.params.token||"");
    const q=await pool.query("SELECT id,name,expires_at FROM projects WHERE share_token=$1 AND shared=true",[tokenValue]);
    if(!q.rowCount)return res.status(404).type("text/plain").send("Delivery not found");
    const p=q.rows[0];
    if(p.expires_at&&new Date(p.expires_at).getTime()<Date.now())return res.status(404).type("text/plain").send("Delivery expired");
    const short=String(p.name||"FBI Client Delivery").trim().slice(0,24)||"FBI Client Delivery";
    const manifest={
      name:"FBI Client Delivery",
      short_name:short,
      start_url:"/share/"+encodeURIComponent(tokenValue),
      scope:"/share/",
      display:"standalone",
      orientation:"any",
      background_color:"#09090a",
      theme_color:"#0a0a0b",
      description:"Secure client delivery from Film Beyond Imagination.",
      icons:[
        {src:"/pwa-icon.svg",sizes:"any",type:"image/svg+xml",purpose:"any maskable"}
      ]
    };
    res.type("application/manifest+json").send(JSON.stringify(manifest));
  }catch(e){
    console.error(e);
    res.status(500).type("text/plain").send("Unable to build delivery manifest");
  }
});

app.get("/manifest.webmanifest",(req,res)=>{
  res.type("application/manifest+json").sendFile(path.join(ROOT,"manifest.webmanifest"));
});
app.get("/official-logo.png",(req,res)=>{
  res.type("image/png").set("Cache-Control","public, max-age=31536000, immutable").sendFile(path.join(ROOT,"official-logo.png"));
});
app.get("/official-logo.svg",(req,res)=>{
  res.type("image/svg+xml").set("Cache-Control","public, max-age=31536000, immutable").sendFile(path.join(ROOT,"official-logo.svg"));
});
app.get("/pwa-icon.svg",(req,res)=>{
  res.type("image/svg+xml").sendFile(path.join(ROOT,"pwa-icon.svg"));
});
app.get("/sw.js",(req,res)=>{
  res.type("application/javascript").set("Cache-Control","no-cache").sendFile(path.join(ROOT,"sw.js"));
});
app.post("/portal",async(req,res)=>{
 try{
  const mode=String(req.body.auth_mode||"signup");
  const email=String(req.body.email||"").trim().toLowerCase();
  const password=String(req.body.password||"");
  const page=(title,message,href,text)=>res.status(400).type("html").send("<!doctype html><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>"+title+"</title><body style=\"font-family:system-ui;padding:40px;background:#09090a;color:#fff\"><h2>"+title+"</h2><p>"+message+"</p><p><a href=\""+href+"\" style=\"color:#f4d56d\">"+text+"</a></p></body>");
  if(mode==="login"){
   const r=await pool.query("SELECT id,email,full_name,password_hash FROM users WHERE email=$1",[email]);
   if(!r.rowCount||!(await userPasswordMatches(password,r.rows[0].password_hash)))return page("Sign in failed","Invalid email or password.","/portal?mode=login","Back to sign in");
   const u={id:r.rows[0].id,email:r.rows[0].email,full_name:r.rows[0].full_name};
   res.setHeader("Set-Cookie","fbi_user_session="+encodeURIComponent(userSession(u))+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000");
   return res.redirect(303,"/portal");
  }
  const fullName=String(req.body.full_name||"").trim().slice(0,120);
  if(!fullName)return page("Account creation failed","Full name is required.","/portal","Back to account creation");
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return page("Account creation failed","Enter a valid email address.","/portal","Back to account creation");
  if(password.length<10)return page("Account creation failed","Password must be at least 10 characters.","/portal","Back to account creation");
  const existing=await pool.query("SELECT id FROM users WHERE email=$1",[email]);
  if(existing.rowCount)return page("Account already exists","Use the sign-in option for this email.","/portal?mode=login","Sign in");
  const id=uid(),hash=await hashUserPassword(password);
  const r=await pool.query("INSERT INTO users(id,email,full_name,password_hash) VALUES($1,$2,$3,$4) RETURNING id,email,full_name",[id,email,fullName,hash]);
  res.setHeader("Set-Cookie","fbi_user_session="+encodeURIComponent(userSession(r.rows[0]))+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000");
  return res.redirect(303,"/portal");
 }catch(e){console.error("Portal form fallback failed:",e);return res.status(500).type("html").send("<!doctype html><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Portal error</title><body style=\"font-family:system-ui;padding:40px;background:#09090a;color:#fff\"><h2>Portal error</h2><p>Please try again.</p><p><a href=\"/portal\" style=\"color:#f4d56d\">Back to portal</a></p></body>")}
});
app.get("/portal.html",(req,res)=>{res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");res.type("html").sendFile(path.join(ROOT,"portal.html"))});
app.get("/portal",(req,res)=>{res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");res.type("html").sendFile(path.join(ROOT,"portal.html"))});
app.get("/",(req,res)=>{
  res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma","no-cache");
  res.set("Expires","0");
  res.type("html").sendFile(path.join(ROOT,process.env.FBI_LIVE_STANDALONE==="1"?"live-standalone.html":"index.html"));
});
app.get("/live",(req,res)=>{
  if(process.env.FBI_LIVE_STANDALONE!=="1")return res.redirect("/");
  res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.type("html").sendFile(path.join(ROOT,"live-standalone.html"));
});
app.get("/editor.html",(req,res)=>{
  if(!validSession(req))return res.redirect("/");
  res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma","no-cache");
  res.set("Expires","0");
  res.type("html").sendFile(path.join(ROOT,"editor.html"));
});

app.use((req,res)=>res.sendFile(path.join(ROOT,"index.html")));

initDb().then(async()=>{
  await finalizeStaleOfflineRecordings();await ensureBucketCors();app.listen(PORT,"0.0.0.0",()=>console.log("FBI Client File Studio listening on port "+PORT))}).catch(e=>{console.error(e);process.exit(1)});