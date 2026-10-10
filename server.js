const express=require("express");
const Busboy=require("busboy");
const {Pool}=require("pg");
const crypto=require("crypto");
const LV=require("./live-viewer");
const fs=require("fs");
const fsp=fs.promises;
const path=require("path");
const {spawn}=require("child_process");
let ffmpegPath="";try{ffmpegPath=require("ffmpeg-static")||""}catch(e){console.warn("ffmpeg-static is unavailable; video thumbnails will use fallback cards.")}
let webpush=null;try{webpush=require("web-push")}catch(e){console.warn("web-push is unavailable; push notifications disabled.")}
const {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand,DeleteObjectsCommand,HeadObjectCommand,CreateMultipartUploadCommand,UploadPartCommand,CompleteMultipartUploadCommand,AbortMultipartUploadCommand,ListPartsCommand,PutBucketCorsCommand}=require("@aws-sdk/client-s3");
const {Upload}=require("@aws-sdk/lib-storage");
const {getSignedUrl}=require("@aws-sdk/s3-request-presigner");
const sharp=require("sharp");
let LibRaw=null;
try{
  LibRaw=require("lightdrift-libraw").LibRaw;
  console.log("LibRaw RAW photo support enabled.");
}catch(e){
  console.warn("LibRaw RAW photo support is unavailable:",e?.message||e);
}
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


const RAW_EXTENSIONS=new Set(["CR2","CR3","CRW","NEF","NRW","ARW","SRF","SR2","RAF","RW2","ORF","PEF","RWL","DNG","DCR","KDC","MRW","3FR","X3F","ERF","MEF","MOS"]);
function isRawPhoto(file){
  const mime=String(file?.mime_type||"").toLowerCase();
  const ext=thumbExt(file?.original_name);
  return RAW_EXTENSIONS.has(ext) ||
    /raw|canon|nikon|sony|adobe-dng|fujifilm|olympus|panasonic/i.test(mime);
}
async function rawBufferFromObject(file){
  if(!LibRaw)throw new Error("RAW photo decoder is not available on this server.");
  const obj=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:file.storage_path}));
  return obj.Body?.transformToByteArray
    ?Buffer.from(await obj.Body.transformToByteArray())
    :Buffer.from(await new Promise((resolve,reject)=>{
      const chunks=[];obj.Body.on("data",c=>chunks.push(c));obj.Body.on("end",()=>resolve(Buffer.concat(chunks)));obj.Body.on("error",reject);
    }));
}
async function generateRawThumbnail(file,width,height){
  const input=await rawBufferFromObject(file);
  const raw=new LibRaw();
  try{
    await raw.loadBuffer(input);
    try{
      const embedded=await raw.createThumbnailJPEGBuffer({width:Math.min(1200,Math.max(480,Number(width)||720)),height:Math.min(1200,Math.max(480,Number(height)||900)),quality:88});
      if(embedded?.data&&embedded.data.length){
        return sharp(embedded.data).rotate().resize({width,height,fit:"inside",withoutEnlargement:true}).webp({quality:82,method:4}).toBuffer();
      }
    }catch(e){
      console.warn("Embedded RAW thumbnail unavailable; rendering RAW:",file?.original_name,e?.message||e);
    }
    const rendered=await raw.createJPEGBuffer({width:Math.min(1800,Math.max(600,Number(width)||1400)),quality:88,fastMode:true});
    if(!rendered?.data||!rendered.data.length)throw new Error("LibRaw returned no rendered image data.");
    return sharp(rendered.data).rotate().resize({width,height,fit:"inside",withoutEnlargement:true}).webp({quality:82,method:4}).toBuffer();
  }finally{
    await raw.close().catch(()=>{});
  }
}
async function generateRawPreview(file,width,height){
  const input=await rawBufferFromObject(file);
  const raw=new LibRaw();
  try{
    await raw.loadBuffer(input);
    const rendered=await raw.createJPEGBuffer({width:Math.min(2400,Math.max(900,Number(width)||1600)),quality:92,fastMode:false});
    if(!rendered?.data||!rendered.data.length)throw new Error("LibRaw returned no rendered preview.");
    return sharp(rendered.data).rotate().resize({width,height,fit:"inside",withoutEnlargement:true}).webp({quality:90,method:4}).toBuffer();
  }finally{
    await raw.close().catch(()=>{});
  }
}

const DESIGN_EXTENSIONS=new Set(["PSD","PSB","AI","EPS","INDD","IDML","SKETCH","XD","FIG","AFPHOTO","AFDESIGN","CDR"]);
function isDesignFile(file){return DESIGN_EXTENSIONS.has(thumbExt(file?.original_name));}
// Best-effort extraction of a PSD/PSB embedded composite preview (JPEG), pure JS, no deps.
function parsePsdThumbJpeg(buf){
  try{
    if(!buf||buf.length<30||buf.toString("ascii",0,4)!=="8BPS")return null;
    let off=26;                                   // file header is 26 bytes
    const cmLen=buf.readUInt32BE(off); off+=4+cmLen;        // Color Mode Data
    if(off+4>buf.length)return null;
    const irLen=buf.readUInt32BE(off); off+=4;              // Image Resources
    const end=Math.min(buf.length,off+irLen);
    while(off+12<=end){
      if(buf.toString("ascii",off,off+4)!=="8BIM")break; off+=4;
      const id=buf.readUInt16BE(off); off+=2;
      let nlen=buf[off]; let nameField=1+nlen; if(nameField%2)nameField++; off+=nameField; // Pascal name, even-padded
      if(off+4>end)break;
      const size=buf.readUInt32BE(off); off+=4;
      const dataStart=off; const padded=size+(size%2);
      if((id===1033||id===1036)&&dataStart+28<=buf.length){  // thumbnail resource
        const fmt=buf.readUInt32BE(dataStart);               // 1 = kJpegRGB
        const jpegStart=dataStart+28, jpegEnd=Math.min(buf.length,dataStart+size);
        if(fmt===1&&jpegEnd>jpegStart)return buf.slice(jpegStart,jpegEnd);
      }
      off=dataStart+padded;
    }
  }catch(e){/* fall through to card */}
  return null;
}
async function psdEmbeddedPreview(file,width,height){
  // Range-fetch only the start of the file; embedded thumbnails live in the header region.
  const obj=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:file.storage_path,Range:"bytes=0-6291455"}));
  const buf=await bodyToBuffer(obj.Body);
  const jpg=parsePsdThumbJpeg(buf);
  if(!jpg||!jpg.length)return null;
  return sharp(jpg).rotate().resize({width,height,fit:"inside",withoutEnlargement:true}).webp({quality:82,method:4}).toBuffer();
}
function thumbKind(file){
  if(isRawPhoto(file))return"raw";
  if(isDesignFile(file))return"design";
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
  if(["PSD","PSB","AI","EPS","INDD","IDML","SKETCH","XD","FIG","AFPHOTO","AFDESIGN","CDR"].includes(ext))return ext;
  return ext||"FILE";
}
function thumbXml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}
function documentThumbSvg(file,width){
  const ext=thumbDocFamily(file?.original_name,file?.mime_type);
  const rawName=String(file?.original_name||"Document");
  const base=rawName.split("/").pop()||rawName;
  const label=base.length>26?base.slice(0,23)+"…":base;
  const family=ext==="PDF"?"PDF":(["DOC","DOCX","ODT","RTF","TXT"].includes(ext)?"DOCUMENT":(["XLS","XLSX","ODS","CSV"].includes(ext)?"SPREADSHEET":(["PPT","PPTX","ODP"].includes(ext)?"PRESENTATION":(["ZIP","RAR","7Z"].includes(ext)?"ARCHIVE":(["PSD","PSB"].includes(ext)?"PHOTOSHOP":(ext==="AI"?"ILLUSTRATOR":(ext==="EPS"?"VECTOR EPS":(["INDD","IDML"].includes(ext)?"INDESIGN":(["SKETCH","XD","FIG"].includes(ext)?"UI DESIGN":(["AFPHOTO","AFDESIGN"].includes(ext)?"AFFINITY":(ext==="CDR"?"CORELDRAW":"FILE")))))))))));
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

function probeVideoDuration(url){
  return new Promise((resolve)=>{
    if(!ffmpegPath)return resolve(0);
    const args=["-hide_banner","-i",url,"-f","null","-"];
    const child=spawn(ffmpegPath,args,{stdio:["ignore","ignore","pipe"]});
    let text="";
    const timer=setTimeout(()=>{try{child.kill("SIGKILL")}catch{};resolve(0)},20000);
    child.stderr.on("data",c=>{text=(text+String(c||"")).slice(-12000)});
    child.on("error",()=>{clearTimeout(timer);resolve(0)});
    child.on("close",()=>{
      clearTimeout(timer);
      const m=/Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
      if(!m)return resolve(0);
      resolve(Number(m[1])*3600+Number(m[2])*60+Number(m[3]));
    });
  });
}

async function makeVideoContactSheet(url,width,height){
  const duration=await probeVideoDuration(url);
  let points;
  if(duration>0){
    const safe=Math.max(0,duration-1);
    points=[
      Math.min(safe,Math.max(0,duration*.05)),
      Math.min(safe,Math.max(0,duration*.33)),
      Math.min(safe,Math.max(0,duration*.66)),
      Math.min(safe,Math.max(0,duration*.92))
    ];
  }else{
    points=[1,10,25,45];
  }

  const frameW=Math.max(240,Math.round(width/2));
  const frameH=Math.max(160,Math.round(height/2));
  const frames=[];
  for(const seek of points){
    try{
      const frame=await runFfmpegPoster(url,seek);
      const out=await sharp(frame).rotate().resize({width:frameW,height:frameH,fit:"cover",position:"centre"}).jpeg({quality:82}).toBuffer();
      frames.push(out);
    }catch(e){
      console.warn("Video contact-sheet frame failed:",seek,e?.message||e);
    }
  }
  while(frames.length<4){
    frames.push(await sharp({
      create:{width:frameW,height:frameH,channels:3,background:{r:17,g:17,b:19}}
    }).jpeg({quality:80}).toBuffer());
  }

  const canvasW=frameW*2,canvasH=frameH*2;
  const playSvg=Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180">'+
      '<circle cx="90" cy="90" r="72" fill="rgba(0,0,0,.62)" stroke="#e8c956" stroke-width="6"/>'+
      '<path d="M72 57 L128 90 L72 123 Z" fill="#ffffff"/>'+
    '</svg>'
  );
  const videoBadgeSvg=Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="260" height="54" viewBox="0 0 260 54">'+
      '<rect x="2" y="2" width="256" height="50" rx="25" fill="rgba(7,7,8,.78)" stroke="rgba(255,255,255,.22)"/>'+
      '<circle cx="28" cy="27" r="9" fill="#e1bf4f"/>'+
      '<path d="M24 21 L34 27 L24 33 Z" fill="#141414"/>'+
      '<text x="49" y="34" font-family="Arial,Helvetica,sans-serif" font-size="21" font-weight="800" letter-spacing="3" fill="#ffffff">VIDEO</text>'+
    '</svg>'
  );
  return sharp({
    create:{width:canvasW,height:canvasH,channels:3,background:{r:7,g:7,b:8}}
  }).composite([
    {input:frames[0],left:0,top:0},
    {input:frames[1],left:frameW,top:0},
    {input:frames[2],left:0,top:frameH},
    {input:frames[3],left:frameW,top:frameH},
    {input:playSvg,left:Math.round(canvasW/2-90),top:Math.round(canvasH/2-90)},
    {input:videoBadgeSvg,left:16,top:16}
  ]).webp({quality:82,method:4}).toBuffer();
}

async function generateThumbnail(file,width,height){
  const kind=thumbKind(file);
  if(kind==="raw")return generateRawThumbnail(file,width,height);
  if(kind==="document")return sharp(documentThumbSvg(file,width)).webp({quality:86,method:4}).toBuffer();
  if(kind==="design"){
    const ext=thumbExt(file);
    if(ext==="PSD"||ext==="PSB"){
      try{const p=await psdEmbeddedPreview(file,width,height);if(p)return p;}
      catch(e){console.warn("PSD embedded preview unavailable; using card:",file?.original_name,e?.message||e);}
    }
    return sharp(documentThumbSvg(file,width)).webp({quality:86,method:4}).toBuffer();
  }
  if(kind==="audio")return sharp(audioThumbSvg(file,width)).webp({quality:84,method:4}).toBuffer();
  if(kind==="video"){
    try{
      const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:file.storage_path}),{expiresIn:600});
      return await makeVideoContactSheet(url,width,height);
    }catch(e){
      console.warn("Video contact-sheet fallback:",file?.original_name,e?.message||e);
      return sharp(Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+Math.round(width*.5625)+'">'+
        '<rect width="100%" height="100%" fill="#101012"/>'+
        '<circle cx="'+(width/2)+'" cy="'+(Math.round(width*.5625)/2)+'" r="'+Math.min(60,width*.15)+'" fill="#c7a53d"/>'+
        '<path d="M '+(width/2-16)+' '+(Math.round(width*.5625)/2-24)+' L '+(width/2+22)+' '+(Math.round(width*.5625)/2)+' L '+(width/2-16)+' '+(Math.round(width*.5625)/2+24)+' Z" fill="#101012"/>'+
        '<text x="50%" y="'+(Math.round(width*.5625)-22)+'" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="18" font-weight="800" fill="#ffffff">VIDEO</text>'+
        '</svg>'
      )).webp({quality:84,method:4}).toBuffer();
    }
  }
  const obj=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:file.storage_path}));
  const input=obj.Body?.transformToByteArray?Buffer.from(await obj.Body.transformToByteArray()):Buffer.from(await new Promise((resolve,reject)=>{const chunks=[];obj.Body.on("data",c=>chunks.push(c));obj.Body.on("end",()=>resolve(Buffer.concat(chunks)));obj.Body.on("error",reject)}));
  try{
    return await sharp(input).rotate().resize({width:width,height:height,fit:"inside",withoutEnlargement:true}).webp({quality:68,method:4}).toBuffer();
  }catch(e){
    console.warn("Image thumbnail could not be decoded; using file card:",file?.original_name,e?.message||e);
    return sharp(documentThumbSvg(file,width)).webp({quality:86,method:4}).toBuffer();
  }
}

const app=express();
const PORT=Number(process.env.PORT||3000);
const ROOT=path.join(__dirname,"site");
const ADMIN_EMAIL=(process.env.ADMIN_EMAIL||"filmbyfbi@gmail.com").trim().toLowerCase();
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";
const SESSION_SECRET=process.env.SESSION_SECRET||crypto.randomBytes(32).toString("hex");
const ANNOUNCEMENT_ADMINS=new Set((process.env.ANNOUNCEMENT_ADMINS||ADMIN_EMAIL).split(",").map(s=>s.trim().toLowerCase()).filter(Boolean));
function isAnnouncementAdmin(email){return ANNOUNCEMENT_ADMINS.has(String(email||"").toLowerCase());}
const VAPID_PUBLIC_KEY=(process.env.VAPID_PUBLIC_KEY||"").trim();
const VAPID_PRIVATE_KEY=(process.env.VAPID_PRIVATE_KEY||"").trim();
const VAPID_SUBJECT=(process.env.VAPID_SUBJECT||("mailto:"+ADMIN_EMAIL)).trim();
let pushReady=false;
if(webpush&&VAPID_PUBLIC_KEY&&VAPID_PRIVATE_KEY){
  try{webpush.setVapidDetails(VAPID_SUBJECT,VAPID_PUBLIC_KEY,VAPID_PRIVATE_KEY);pushReady=true;}
  catch(e){console.warn("VAPID configuration failed; push disabled:",e?.message||e)}
}
async function sendPushToAll(payloadObj){
  if(!pushReady)return {sent:0,skipped:true};
  let subs=[];
  try{subs=(await pool.query("SELECT id,endpoint,p256dh,auth FROM push_subscriptions")).rows;}catch(e){return {sent:0,error:"no_table"};}
  const data=JSON.stringify(payloadObj||{});
  let sent=0;
  await Promise.all(subs.map(async s=>{
    try{await webpush.sendNotification({endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth}},data);sent++;}
    catch(err){const code=err&&err.statusCode;if(code===404||code===410){await pool.query("DELETE FROM push_subscriptions WHERE id=$1",[s.id]).catch(()=>{});}}
  }));
  return {sent,total:subs.length};
}
const PUBLIC_BASE_URL=(process.env.PUBLIC_BASE_URL||"").replace(/\/+$/,"");
const MAX_FILE_SIZE=5*1000*1000*1000*1000;
const STORAGE_QUOTA_BYTES=Number(process.env.STORAGE_QUOTA_BYTES||100000000000000);
const MIN_PART_SIZE=32*1024*1024;
const TURBO_PART_SIZE=64*1024*1024;
const MAX_PARTS=10000;
const PRESIGN_SECONDS=24*60*60;
const UPLOAD_PART_STALL_MS=2*60*1000;
const UPLOAD_PROTOCOL_VERSION=5;

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
function shareSession(tokenValue,email){
  const exp=Date.now()+30*86400000;
  const payload=Buffer.from(JSON.stringify({token:String(tokenValue),email:String(email).toLowerCase(),exp})).toString("base64url");
  const sig=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
  return payload+"."+sig;
}
function validShareSession(req,tokenValue){
  const s=cookies(req).fbi_share_session;if(!s)return null;
  const parts=s.split("."),payload=parts[0],sig=parts[1];if(!payload||!sig)return null;
  try{
    const expected=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
    if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;
    const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
    if(String(data.token)!==String(tokenValue)||!data.email||Number(data.exp)<=Date.now())return null;
    return {email:String(data.email).toLowerCase()};
  }catch{return null}
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
async function portalProjectAccessible(userId,projectId){
  const r=await pool.query(
    "SELECT p.* FROM projects p LEFT JOIN project_collaborators pc ON pc.project_id=p.id AND pc.user_id=$2 WHERE p.id=$1 AND (p.owner_id=$2 OR pc.user_id=$2)",
    [projectId,userId]
  );
  return r.rows[0]||null;
}
async function portalFileAccessible(userId,fileId){
  const r=await pool.query(
    "SELECT f.*,p.name project_name,p.client_name,p.owner_id FROM files f JOIN projects p ON p.id=f.project_id LEFT JOIN project_collaborators pc ON pc.project_id=p.id AND pc.user_id=$2 WHERE f.id=$1 AND (p.owner_id=$2 OR pc.user_id=$2)",
    [fileId,userId]
  );
  return r.rows[0]||null;
}

function clientIp(req){return String(req.headers["x-forwarded-for"]||req.socket.remoteAddress||"").split(",")[0].trim().slice(0,120)}
function s3Ready(){return Boolean(process.env.S3_BUCKET&&process.env.S3_ENDPOINT&&process.env.S3_ACCESS_KEY_ID&&process.env.S3_SECRET_ACCESS_KEY&&process.env.S3_REGION)}
const s3=s3Ready()?new S3Client({
  region:process.env.S3_REGION,
  endpoint:process.env.S3_ENDPOINT,
  forcePathStyle:false,
  maxAttempts:8,
  credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY}
}):null;
const bucket=()=>process.env.S3_BUCKET;

function choosePartSize(size){
  // Use 64 MiB parts as the normal floor. Scale only when needed to keep the
  // upload below the S3-compatible 10,000-part ceiling.
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
  const byPart=new Map();

  for(const p of allParts){
    const pn=Number(p.partNumber);
    if(!Number.isInteger(pn)||pn<1||pn>totalParts)continue;
    const expectedSize=pn===totalParts
      ? Math.max(0,totalSize-partSize*(totalParts-1))
      : partSize;
    // A successfully uploaded object section must have exactly the byte count
    // expected for its position. Wrong-sized sections are re-uploaded.
    if(Number(p.size)===expectedSize&&p.etag){
      byPart.set(pn,p);
    }
  }

  const missingParts=[];
  for(let i=1;i<=totalParts;i++)if(!byPart.has(i))missingParts.push(i);
  const parts=Array.from(byPart.values()).sort((a,b)=>a.partNumber-b.partNumber);
  const uploadedBytes=parts.reduce((sum,p)=>sum+Number(p.size||0),0);

  return {
    uploadedBytes,
    totalParts,
    completedParts:parts.length,
    missingParts,
    completeReady:missingParts.length===0&&uploadedBytes===totalSize,
    parts
  };
}
async function finalizeStoredUpload(u){
  const projectId=u.project_id;
  const expectedSize=Number(u.size_bytes||0);

  if(u.status==="completed"){
    const done=await pool.query("SELECT * FROM files WHERE storage_path=$1 LIMIT 1",[u.storage_key]);
    return done.rows[0]||null;
  }

  const alreadyStored=await pool.query("SELECT * FROM files WHERE storage_path=$1 LIMIT 1",[u.storage_key]);
  if(alreadyStored.rowCount){
    const fileRow=alreadyStored.rows[0];
    await pool.query("UPDATE upload_sessions SET status='completed',updated_at=now() WHERE id=$1",[u.id]);
    await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[projectId]);
    return fileRow;
  }

  // Recover the rare case where the multipart session has already disappeared
  // but the final object exists because the browser lost the completion response.
  let existingObject=null;
  try{existingObject=await headObjectWithRetry({Bucket:bucket(),Key:u.storage_key},3,400)}catch{}
  if(existingObject&&Number(existingObject.ContentLength||0)===expectedSize){
    const ins=await pool.query(
      "INSERT INTO files(id,project_id,original_name,storage_name,storage_path,mime_type,size_bytes,relative_path,content_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING *",
      [uid(),projectId,u.original_name,path.basename(u.storage_key),u.storage_key,u.mime_type,expectedSize,u.relative_path,u.content_fingerprint||null]
    );
    const fileRow=ins.rows[0]||(await pool.query("SELECT * FROM files WHERE storage_path=$1 LIMIT 1",[u.storage_key])).rows[0];warmMediaCache(fileRow);
    if(!fileRow)throw new Error("Stored object is ready but the file record could not be created.");
    await pool.query("UPDATE upload_sessions SET status='completed',updated_at=now() WHERE id=$1",[u.id]);
    await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[projectId]);
    return fileRow;
  }

  if(u.mode==="multipart"){
    let state;
    try{
      state=await inspectPendingUpload(u);
    }catch(e){
      if(e&&e.code==="UPLOAD_SESSION_GONE")throw e;
      throw e;
    }
    if(!state.completeReady){
      const err=new Error("Multipart upload is not complete yet.");
      err.code="UPLOAD_INCOMPLETE";
      err.state=state;
      throw err;
    }

    const parts=state.parts.map(function(p){
      return {
        ETag:String(p.etag||"").replace(/^"+|"+$/g,""),
        PartNumber:Number(p.partNumber)
      };
    }).filter(function(p){return p.ETag&&Number.isInteger(p.PartNumber)&&p.PartNumber>0})
      .sort(function(a,b){return a.PartNumber-b.PartNumber});

    await s3.send(new CompleteMultipartUploadCommand({
      Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,
      MultipartUpload:{Parts:parts}
    }));
  }

  const head=await headObjectWithRetry({Bucket:bucket(),Key:u.storage_key},8,500);
  const actualSize=Number(head.ContentLength||0);
  if(actualSize!==expectedSize){
    const err=new Error("Uploaded size mismatch.");
    err.code="UPLOAD_SIZE_MISMATCH";
    throw err;
  }

  const ins=await pool.query(
    "INSERT INTO files(id,project_id,original_name,storage_name,storage_path,mime_type,size_bytes,relative_path,content_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING *",
    [uid(),projectId,u.original_name,path.basename(u.storage_key),u.storage_key,u.mime_type,actualSize,u.relative_path,u.content_fingerprint||null]
  );
  const fileRow=ins.rows[0]||(await pool.query("SELECT * FROM files WHERE storage_path=$1 LIMIT 1",[u.storage_key])).rows[0];warmMediaCache(fileRow);
  if(!fileRow)throw new Error("Stored object is ready but the file record could not be created.");

  await pool.query("UPDATE upload_sessions SET status='completed',updated_at=now() WHERE id=$1",[u.id]);
  await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[projectId]);
  return fileRow;
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

    CREATE TABLE IF NOT EXISTS creative_settings(
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      business_name text NOT NULL DEFAULT '',
      portal_title text NOT NULL DEFAULT 'Private Client Gallery',
      accent_color text NOT NULL DEFAULT '#d4af37',
      logo_key text NOT NULL DEFAULT '',
      watermark_enabled boolean NOT NULL DEFAULT false,
      watermark_type text NOT NULL DEFAULT 'logo',
      watermark_text text NOT NULL DEFAULT '',
      watermark_opacity numeric NOT NULL DEFAULT 0.32,
      watermark_position text NOT NULL DEFAULT 'bottom-right',
      watermark_size integer NOT NULL DEFAULT 22,
      watermark_on_download boolean NOT NULL DEFAULT true,
      watermark_presets jsonb NOT NULL DEFAULT '[]'::jsonb,
      email_templates jsonb NOT NULL DEFAULT '{}'::jsonb,
      preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
      integrations jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

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
    CREATE TABLE IF NOT EXISTS editor_sequences(
      project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      sequence_name text NOT NULL DEFAULT 'Untitled Sequence',
      sequence jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS editor_render_jobs(
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'queued',
      progress integer NOT NULL DEFAULT 0,
      output_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
      output_name text NOT NULL DEFAULT '',
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      error text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_editor_render_jobs_project ON editor_render_jobs(project_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS downloads(
      id bigserial PRIMARY KEY,
      project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
      file_id uuid REFERENCES files(id) ON DELETE SET NULL,
      downloaded_at timestamptz NOT NULL DEFAULT now(),
      user_agent text DEFAULT '',
      ip_address text DEFAULT '',
      client_email text DEFAULT ''
    );
    ALTER TABLE downloads ADD COLUMN IF NOT EXISTS client_email text DEFAULT '';
    CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);
    CREATE INDEX IF NOT EXISTS idx_downloads_project ON downloads(project_id);
    CREATE TABLE IF NOT EXISTS client_selections(
      id uuid PRIMARY KEY,
      project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
      client_name text DEFAULT '',
      client_email text DEFAULT '',
      note text DEFAULT '',
      file_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_client_selections_project ON client_selections(project_id,created_at DESC);

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
    ALTER TABLE files ADD COLUMN IF NOT EXISTS favorite boolean NOT NULL DEFAULT false;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS trashed_at timestamptz;
    CREATE INDEX IF NOT EXISTS idx_files_fingerprint ON files(project_id,content_fingerprint,size_bytes);
    CREATE INDEX IF NOT EXISTS idx_files_owner_recent ON files(project_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_files_trash ON files(trashed_at);
    CREATE TABLE IF NOT EXISTS project_collaborators(
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(project_id,user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_collaborators_user ON project_collaborators(user_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_collaborators_project ON project_collaborators(project_id,created_at DESC);
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
    CREATE TABLE IF NOT EXISTS subscription_plans(
      id text PRIMARY KEY,
      name text NOT NULL,
      storage_bytes bigint NOT NULL,
      monthly_price_ghs numeric(12,2) NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO subscription_plans(id,name,storage_bytes,monthly_price_ghs,active) VALUES
      ('trial','Free Trial',10000000000,0,true),
      ('starter','Starter',100000000000,50,true),
      ('creator','Creator',500000000000,150,true),
      ('professional','Professional',1000000000000,300,true),
      ('studio','Studio',2000000000000,550,true)
    ON CONFLICT (id) DO UPDATE SET
      name=excluded.name,
      storage_bytes=excluded.storage_bytes,
      monthly_price_ghs=excluded.monthly_price_ghs,
      active=excluded.active,
      updated_at=now();

    CREATE TABLE IF NOT EXISTS creator_subscriptions(
      id uuid PRIMARY KEY,
      user_id uuid UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id text NOT NULL REFERENCES subscription_plans(id),
      status text NOT NULL DEFAULT 'trialing',
      storage_bytes bigint NOT NULL DEFAULT 10000000000,
      monthly_price_ghs numeric(12,2) NOT NULL DEFAULT 0,
      current_period_start timestamptz NOT NULL DEFAULT now(),
      current_period_end timestamptz NOT NULL,
      canceled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_creator_subscriptions_status ON creator_subscriptions(status,current_period_end);

    CREATE TABLE IF NOT EXISTS payment_transactions(
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subscription_id uuid REFERENCES creator_subscriptions(id) ON DELETE SET NULL,
      plan_id text NOT NULL REFERENCES subscription_plans(id),
      amount_ghs numeric(12,2) NOT NULL,
      currency text NOT NULL DEFAULT 'GHS',
      provider text NOT NULL DEFAULT 'moolre',
      external_ref text UNIQUE NOT NULL,
      provider_ref text DEFAULT '',
      status text NOT NULL DEFAULT 'pending',
      authorization_url text DEFAULT '',
      customer_email text DEFAULT '',
      provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      paid_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_payment_transactions_user ON payment_transactions(user_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payment_transactions_status ON payment_transactions(status,created_at DESC);

    CREATE TABLE IF NOT EXISTS payment_webhook_events(
      id uuid PRIMARY KEY,
      provider text NOT NULL DEFAULT 'moolre',
      event_key text UNIQUE NOT NULL,
      external_ref text DEFAULT '',
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      received_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_external_ref ON payment_webhook_events(external_ref,received_at DESC);

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
  // "Save for later" table. Kept in its own try/catch so that a problem here can
  // never stop the server from starting; it would only disable that feature.
  try{await pool.query(LV.SAVED_SCHEMA_SQL)}catch(e){console.error("Save-for-later schema failed:",e?.message||e)}
  // What's New announcements + per-user read state + web-push subscriptions.
  try{await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements(
      id uuid PRIMARY KEY,
      title text NOT NULL,
      body_md text NOT NULL DEFAULT '',
      category text NOT NULL DEFAULT 'update',
      created_by text NOT NULL DEFAULT '',
      published boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements(created_at DESC);
    CREATE TABLE IF NOT EXISTS announcement_reads(
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
      read_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(user_id,announcement_id)
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions(
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint text UNIQUE NOT NULL,
      p256dh text NOT NULL,
      auth text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_push_sub_user ON push_subscriptions(user_id);
  `)}catch(e){console.error("Announcements schema failed:",e?.message||e)}
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
const DEFAULT_CREATIVE_SETTINGS={business_name:"",portal_title:"Private Client Gallery",accent_color:"#d4af37",logo_key:"",watermark_enabled:false,watermark_type:"logo",watermark_text:"",watermark_opacity:0.32,watermark_position:"bottom-right",watermark_size:22,watermark_on_download:true,watermark_presets:[],email_templates:{delivery_subject:"Your files are ready",delivery_body:"Hi {{client_name}}, your files are ready in your private gallery.\n\n{{share_link}}",reminder_subject:"Your gallery is still available",reminder_body:"Hi {{client_name}}, your private gallery is available here:\n\n{{share_link}}"},preferences:{default_expiry_days:30,allow_client_preview:true,show_file_size:true,auto_share:false},integrations:{download_tracking:true,email_notifications:false}};

const CREATOR_TRIAL_BYTES=10*1000*1000*1000;
const CREATOR_BILLING_CURRENCY=String(process.env.MOOLRE_CURRENCY||"GHS").trim().toUpperCase()||"GHS";
const CREATOR_PLAN_IDS=["starter","creator","professional","studio"];

function moolreBaseUrl(){return String(process.env.MOOLRE_API_BASE||"https://api.moolre.com").replace(/\/+$/,"");}
function moolreConfigured(){return Boolean(String(process.env.MOOLRE_API_USER||"").trim()&&String(process.env.MOOLRE_API_PUBKEY||"").trim()&&String(process.env.MOOLRE_ACCOUNT_NUMBER||"").trim());}
async function getMoolreWebhookSecret(){
  const envSecret=String(process.env.MOOLRE_WEBHOOK_SECRET||"").trim();
  if(envSecret)return envSecret;
  try{
    const r=await pool.query("SELECT value FROM app_settings WHERE key='moolre_webhook_secret' LIMIT 1");
    return String(r.rows[0]?.value||"").trim();
  }catch(e){
    console.warn("Could not load stored Moolre webhook secret:",e?.message||e);
    return "";
  }
}
async function rememberMoolreWebhookSecret(secret){
  const value=String(secret||"").trim();
  if(!value)return;
  try{
    await pool.query(
      "INSERT INTO app_settings(key,value) VALUES('moolre_webhook_secret',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      [value]
    );
    console.log("Moolre webhook secret stored securely in the app database.");
  }catch(e){
    console.warn("Could not persist Moolre webhook secret:",e?.message||e);
  }
}
function moolreBusinessEmail(){return String(process.env.MOOLRE_BUSINESS_EMAIL||ADMIN_EMAIL||"").trim().toLowerCase();}
function appPublicBaseUrl(req){return String(PUBLIC_BASE_URL||(`${req.protocol}://${req.get("host")}`)).replace(/\\+$/,"");}
function addOneMonth(value){
  const d=new Date(value||Date.now());
  const day=d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth()+1);
  if(d.getUTCDate()!==day)d.setUTCDate(0);
  return d;
}
async function ensureCreatorSubscription(userId){
  const existing=await pool.query("SELECT * FROM creator_subscriptions WHERE user_id=$1 LIMIT 1",[userId]);
  if(existing.rowCount)return existing.rows[0];
  const start=new Date(),end=addOneMonth(start),id=uid();
  const r=await pool.query(
    "INSERT INTO creator_subscriptions(id,user_id,plan_id,status,storage_bytes,monthly_price_ghs,current_period_start,current_period_end) VALUES($1,$2,'trial','trialing',$3,0,$4,$5) ON CONFLICT(user_id) DO NOTHING RETURNING *",
    [id,userId,CREATOR_TRIAL_BYTES,start,end]
  );
  if(r.rowCount)return r.rows[0];
  return (await pool.query("SELECT * FROM creator_subscriptions WHERE user_id=$1 LIMIT 1",[userId])).rows[0]||null;
}
async function getCreatorSubscription(userId){
  return ensureCreatorSubscription(userId);
}
async function creatorStorageUsage(userId){
  const [used,reserved]=await Promise.all([
    pool.query("SELECT COALESCE(SUM(f.size_bytes),0) bytes FROM files f JOIN projects p ON p.id=f.project_id WHERE p.owner_id=$1",[userId]),
    pool.query("SELECT COALESCE(SUM(u.size_bytes),0) bytes FROM upload_sessions u JOIN projects p ON p.id=u.project_id WHERE p.owner_id=$1 AND u.status='active'",[userId])
  ]);
  return {usedBytes:Number(used.rows[0]?.bytes||0),reservedBytes:Number(reserved.rows[0]?.bytes||0)};
}
async function creatorQuota(userId){
  const sub=await getCreatorSubscription(userId);
  const now=new Date();
  const active=!!sub&&["trialing","active"].includes(String(sub.status))&&new Date(sub.current_period_end).getTime()>now.getTime();
  const quota=active?Number(sub.storage_bytes||0):0;
  const usage=await creatorStorageUsage(userId);
  const available=Math.max(0,quota-usage.usedBytes-usage.reservedBytes);
  return {subscription:sub,active,quotaBytes:quota,usedBytes:usage.usedBytes,reservedBytes:usage.reservedBytes,availableBytes:available};
}
async function assertCreatorQuotaForUpload(userId,uploadId,sizeBytes){
  const q=await creatorQuota(userId);
  if(!q.active) {
    const err=new Error("Your storage plan is not active. Please subscribe to continue uploading.");
    err.code="SUBSCRIPTION_REQUIRED";
    err.quota=q;
    throw err;
  }
  const otherReserved=await pool.query(
    "SELECT COALESCE(SUM(u.size_bytes),0) bytes FROM upload_sessions u JOIN projects p ON p.id=u.project_id WHERE p.owner_id=$1 AND u.status='active' AND u.id<>$2",
    [userId,uploadId||"00000000-0000-0000-0000-000000000000"]
  );
  const projected=q.usedBytes+Number(otherReserved.rows[0]?.bytes||0)+Number(sizeBytes||0);
  if(projected>q.quotaBytes){
    const err=new Error("This upload would exceed your current storage plan. Upgrade your plan to continue.");
    err.code="STORAGE_QUOTA_EXCEEDED";
    err.quota={...q,otherReservedBytes:Number(otherReserved.rows[0]?.bytes||0),projectedBytes:projected};
    throw err;
  }
  return q;
}
async function fetchMoolre(pathname,body){
  if(!moolreConfigured()){
    const err=new Error("Moolre payment is not configured. Add MOOLRE_API_USER, MOOLRE_API_PUBKEY and MOOLRE_ACCOUNT_NUMBER in Railway.");
    err.code="MOOLRE_NOT_CONFIGURED";
    throw err;
  }
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  try{
    const r=await fetch(moolreBaseUrl()+pathname,{
      method:"POST",
      headers:{"Content-Type":"application/json","X-API-USER":String(process.env.MOOLRE_API_USER),"X-API-PUBKEY":String(process.env.MOOLRE_API_PUBKEY)},
      body:JSON.stringify(body),
      signal:controller.signal
    });
    const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{}
    if(!r.ok)throw new Error(String(data.message||data.error||("Moolre API HTTP "+r.status)));
    return data;
  }finally{clearTimeout(timer)}
}
async function verifyMoolrePayment(externalRef){
  const result=await fetchMoolre("/open/transact/status",{
    type:1,idtype:1,id:String(externalRef),accountnumber:String(process.env.MOOLRE_ACCOUNT_NUMBER)
  });
  const data=result?.data&&typeof result.data==="object"?result.data:{};
  return {ok:Number(data.txstatus)===1||String(data.txstatus)==="1",status:Number(data.txstatus||0),data,result};
}
async function activateSubscriptionFromPayment(payment,providerPayload){
  const plan=(await pool.query("SELECT * FROM subscription_plans WHERE id=$1",[payment.plan_id])).rows[0];
  if(!plan)throw new Error("Subscription plan not found.");
  const now=new Date();
  await pool.query(
    "UPDATE payment_transactions SET status='success',provider_ref=$2,provider_payload=$3,paid_at=COALESCE(paid_at,$4),updated_at=now() WHERE id=$1",
    [payment.id,String(providerPayload?.transactionid||providerPayload?.reference||providerPayload?.id||""),JSON.stringify(providerPayload||{}),now]
  );
  await pool.query(
    "UPDATE creator_subscriptions SET plan_id=$2,status='active',storage_bytes=$3,monthly_price_ghs=$4,current_period_start=$5,current_period_end=$6,canceled_at=NULL,updated_at=now() WHERE user_id=$1",
    [payment.user_id,plan.id,Number(plan.storage_bytes),Number(plan.monthly_price_ghs),now,addOneMonth(now)]
  );
  return (await pool.query("SELECT * FROM creator_subscriptions WHERE user_id=$1 LIMIT 1",[payment.user_id])).rows[0];
}
async function processMoolreWebhookPayload(body){
  const root=body&&typeof body==="object"?body:{};
  const data=root.data&&typeof root.data==="object"?root.data:root;
  const externalRef=String(data.externalref||root.externalref||"").trim();
  const txstatus=Number(data.txstatus??data.status??root.txstatus??0);
  if(!externalRef)return {ok:false,reason:"Missing external reference."};
  const paymentQ=await pool.query("SELECT * FROM payment_transactions WHERE external_ref=$1 LIMIT 1",[externalRef]);
  if(!paymentQ.rowCount)return {ok:false,reason:"Unknown payment reference.",externalRef};
  const payment=paymentQ.rows[0];
  if(payment.status==="success"){
    return {ok:true,success:true,alreadyProcessed:true,externalRef};
  }
  const incomingAmount=Number(data.amount??data.value??root.amount??0);
  if(incomingAmount>0&&Math.abs(incomingAmount-Number(payment.amount_ghs))>0.01){
    return {ok:false,reason:"Payment amount does not match the pending transaction.",externalRef};
  }
  const incomingAccount=String(data.accountnumber||root.accountnumber||"").trim();
  if(incomingAccount&&String(process.env.MOOLRE_ACCOUNT_NUMBER||"").trim()&&incomingAccount!==String(process.env.MOOLRE_ACCOUNT_NUMBER).trim()){
    return {ok:false,reason:"Moolre account number does not match.",externalRef};
  }
  if(["success","successful","paid","completed"].includes(String(data.status||root.status||"").toLowerCase())) {
    // Some webhook variants expose status as text while the documented flow uses txstatus=1.
  }
  if(txstatus===1){
    if(String(process.env.MOOLRE_VERIFY_WEBHOOK||"1")!=="0"){
      try{
        const verified=await verifyMoolrePayment(externalRef);
        if(!verified.ok){
          console.warn("Moolre webhook received a success callback but status verification is not yet successful:",externalRef);
          return {ok:false,reason:"Payment status could not be verified yet.",externalRef};
        }
      }catch(e){
        console.warn("Moolre webhook status verification failed:",e?.message||e);
        return {ok:false,reason:"Payment verification is temporarily unavailable.",externalRef};
      }
    }
    const sub=await activateSubscriptionFromPayment(payment,data);
    return {ok:true,success:true,externalRef,subscription:sub};
  }
  const statusText=String(data.message||root.message||"Payment not completed.");
  await pool.query("UPDATE payment_transactions SET status='failed',provider_payload=$2,updated_at=now() WHERE id=$1 AND status<>'success'",[payment.id,JSON.stringify(data||root)]);
  return {ok:true,success:false,externalRef,message:statusText};
}
async function loadCreativeSettings(userId){
  const r=await pool.query("SELECT * FROM creative_settings WHERE user_id=$1",[userId]);
  if(!r.rowCount)return {...DEFAULT_CREATIVE_SETTINGS,email_templates:{...DEFAULT_CREATIVE_SETTINGS.email_templates},preferences:{...DEFAULT_CREATIVE_SETTINGS.preferences},integrations:{...DEFAULT_CREATIVE_SETTINGS.integrations}};
  const x=r.rows[0];
  const parse=(v,f)=>{try{return typeof v==="object"&&v!==null?v:JSON.parse(v||"")}catch{return f}};
  return {business_name:String(x.business_name||""),portal_title:String(x.portal_title||"Private Client Gallery"),accent_color:String(x.accent_color||"#d4af37"),logo_key:String(x.logo_key||""),watermark_enabled:Boolean(x.watermark_enabled),watermark_type:String(x.watermark_type||"logo"),watermark_text:String(x.watermark_text||""),watermark_opacity:Math.max(.05,Math.min(1,Number(x.watermark_opacity)||.32)),watermark_position:String(x.watermark_position||"bottom-right"),watermark_size:Math.max(8,Math.min(45,Math.round(Number(x.watermark_size)||22))),watermark_on_download:x.watermark_on_download!==false,watermark_presets:Array.isArray(parse(x.watermark_presets,[]))?parse(x.watermark_presets,[]):[],email_templates:{...DEFAULT_CREATIVE_SETTINGS.email_templates,...parse(x.email_templates,{})},preferences:{...DEFAULT_CREATIVE_SETTINGS.preferences,...parse(x.preferences,{})},integrations:{...DEFAULT_CREATIVE_SETTINGS.integrations,...parse(x.integrations,{})}};
}
async function ensureCreativeSettings(userId){await pool.query("INSERT INTO creative_settings(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING",[userId]);}
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

// Additive MCR Program route. Normal OBS/vMix publishing and the proven
// encoded/<key> playback path remain unchanged until this route is activated.
const activeProgramRoutes=new Map();
const pendingProgramRoutes=new Map();
function streamProgramRtmpUrl(row){
  const base=streamRtmpServer();
  return base&&row?.stream_key?base.replace(/\/live$/,"/program")+"/"+row.stream_key:"";
}
function programRouteActive(streamId){
  const item=activeProgramRoutes.get(String(streamId));
  if(!item)return false;
  if(Date.now()-Number(item)>6*60*60*1000){activeProgramRoutes.delete(String(streamId));return false;}
  return true;
}
function programRoutePending(streamId){
  const item=pendingProgramRoutes.get(String(streamId));
  if(!item)return false;
  if(Date.now()-Number(item)>10*60*1000){pendingProgramRoutes.delete(String(streamId));return false;}
  return true;
}
function prepareProgramRoute(streamId){
  pendingProgramRoutes.set(String(streamId),Date.now());
}
function activateProgramRoute(streamId){
  pendingProgramRoutes.delete(String(streamId));
  activeProgramRoutes.set(String(streamId),Date.now());
}
function deactivateProgramRoute(streamId){
  pendingProgramRoutes.delete(String(streamId));
  activeProgramRoutes.delete(String(streamId));
}

const activeStreamAudioMeters=new Map();

function stopStreamAudioMeter(streamId){
  const item=activeStreamAudioMeters.get(String(streamId));
  if(!item)return;
  activeStreamAudioMeters.delete(String(streamId));
  try{item.proc.kill("SIGTERM")}catch{}
  setTimeout(()=>{try{if(!item.proc.killed)item.proc.kill("SIGKILL")}catch{}},1500);
}

function ensureStreamAudioMeter(row){
  const key=String(row?.id||"");
  if(!key||!ffmpegPath)return null;
  const existing=activeStreamAudioMeters.get(key);
  if(existing&&!existing.proc.killed)return existing;

  // Use the same HLS input that the existing recording engine already
  // uses successfully. This keeps metering on the proven live media path and
  // avoids depending on a separate RTMP connection.
  const hlsBase=streamInputHlsUrl(row);
  const input=hlsBase&&hlsBase.startsWith("http")?hlsBase+"/index.m3u8":streamInputRtmpUrl(row);
  if(!input)return null;

  const state={level:-60,lastAt:Date.now(),proc:null};
  const proc=spawn(ffmpegPath,[
    "-hide_banner","-loglevel","info","-nostats",
    "-i",input,
    "-vn",
    "-af","aresample=48000,asetnsamples=n=4800,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:direct=1",
    "-f","null","-"
  ],{stdio:["ignore","ignore","pipe"]});
  state.proc=proc;

  let buffer="";
  proc.stderr.on("data",chunk=>{
    buffer+=chunk.toString();
    const lines=buffer.split(/\r?\n/);
    buffer=lines.pop()||"";
    for(const line of lines){
      const textLine=String(line);
      const m=textLine.match(/lavfi\.astats\.Overall\.RMS_level=(-?(?:\d+(?:\.\d*)?|\.\d+))/)
        ||textLine.match(/RMS level dB:\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/i);
      if(!m)continue;
      const level=Math.max(-60,Math.min(0,Number(m[1])));
      if(Number.isFinite(level)){
        state.level=level;
        state.lastAt=Date.now();
      }
    }
  });

  proc.on("error",err=>{
    console.warn("Live audio meter process error:",err?.message||err);
    stopStreamAudioMeter(key);
  });
  proc.on("close",()=>activeStreamAudioMeters.delete(key));
  activeStreamAudioMeters.set(key,state);
  return state;
}

const activeStreamRecordings=new Map();
const streamRecordingStarts=new Map();
const streamStatusRefreshes=new Map();
const streamOfflineSince=new Map();
const STREAM_OFFLINE_GRACE_MS=15000;

async function startStreamRecording(row){
  if(!row?.id||activeStreamRecordings.has(row.id)||!row.record_enabled||!ffmpegPath||!s3Ready())return;
  const inFlight=streamRecordingStarts.get(row.id);
  if(inFlight)return inFlight;
  const task=startStreamRecordingImpl(row);
  streamRecordingStarts.set(row.id,task);
  try{return await task}
  finally{if(streamRecordingStarts.get(row.id)===task)streamRecordingStarts.delete(row.id)}
}
async function startStreamRecordingImpl(row){
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

  let finalizePromise=null;
  const finalize=(status,errorText)=>{
    if(finalizePromise)return finalizePromise;
    finalizePromise=(async()=>{
      try{await uploadDone}catch(uploadErr){
        status="failed";
        errorText=String(uploadErr?.message||uploadErr);
        console.error("Stream recording object upload failed:",JSON.stringify({
          streamId:row.id,recordingId:id,bytes,error:errorText
        }));
      }
      try{
        await pool.query(
          "UPDATE stream_recordings SET status=$2,ended_at=COALESCE(ended_at,now()),size_bytes=$3,error=$4 WHERE id=$1",
          [id,status,bytes,String(errorText||"")]
        );
      }catch(dbErr){
        console.error("Recording database finalization failed:",dbErr?.message||dbErr);
      }finally{
        // Keep one active recorder until its object upload and DB finalization finish.
        if(activeStreamRecordings.get(row.id)?.id===id)activeStreamRecordings.delete(row.id);
      }
    })();
    return finalizePromise;
  };

  const active={id,proc,stopRequested:false,finish:()=>finalize("completed","")};
  activeStreamRecordings.set(row.id,active);

  proc.on("error",async err=>{
    try{pass.destroy(err)}catch{}
    await finalize("failed",String(err?.message||err));
  });

  proc.on("close",async(code,signal)=>{
    try{if(!proc.stdout.readableEnded)pass.end()}catch{}
    // FFmpeg commonly exits non-zero when it is deliberately interrupted to
    // close a live MP4. Preserve valid bytes from an intentional stop.
    const normalStop=active.stopRequested;
    const status=bytes>0&&(code===0||normalStop)?"completed":"failed";
    const failure=status==="failed"
      ?(stderr||((code===null?"FFmpeg was terminated by signal "+String(signal||"unknown"):"FFmpeg exited with code "+String(code))+"; bytes captured: "+bytes))
      :"";
    if(status==="failed")console.error("Stream recording FFmpeg failure:",JSON.stringify({
      streamId:row.id,recordingId:id,code,signal,bytes,stderr:stderr.slice(-3000)
    }));
    await finalize(status,failure);
  });
}

async function stopStreamRecording(streamId){
  const active=activeStreamRecordings.get(streamId);
  if(!active)return;

  active.stopRequested=true;
  try{active.proc.kill("SIGINT")}catch{}
  await new Promise(r=>setTimeout(r,5000));

  if(activeStreamRecordings.has(streamId)&&active.proc.exitCode===null&&active.proc.signalCode===null){
    try{active.proc.kill("SIGTERM")}catch{}
    await new Promise(r=>setTimeout(r,4000));
  }

  if(activeStreamRecordings.has(streamId)&&active.proc.exitCode===null&&active.proc.signalCode===null){
    try{active.proc.kill("SIGKILL")}catch{}
    await new Promise(r=>setTimeout(r,1000));
  }

  // finalize() owns removal from the map after the upload and DB update finish.
  // Do not clear it here: a slow object-storage upload must not look like a new,
  // unrecorded stream on the next monitor tick.
  await Promise.race([
    active.finish(),
    new Promise(r=>setTimeout(r,8000))
  ]);
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
  if(!row?.id)return row;
  const inFlight=streamStatusRefreshes.get(row.id);
  if(inFlight)return inFlight;
  const task=refreshStreamStatusImpl(row);
  streamStatusRefreshes.set(row.id,task);
  try{return await task}
  finally{if(streamStatusRefreshes.get(row.id)===task)streamStatusRefreshes.delete(row.id)}
}
async function refreshStreamStatusImpl(row){
  const liveCheck=await checkStreamLive(row);
  let live=liveCheck;
  const now=Date.now();

  if(liveCheck){
    streamOfflineSince.delete(row.id);
  }else if(row.status==="live"){
    // Public/control-room polls can briefly miss an HLS playlist while a live
    // source is reconnecting. Do not kill a valid recording on one failed probe.
    const since=streamOfflineSince.get(row.id)??now;
    streamOfflineSince.set(row.id,since);
    if(now-since<STREAM_OFFLINE_GRACE_MS){
      return {...row,status:"live"};
    }
  }

  if(!live)streamOfflineSince.delete(row.id);
  const status=live?"live":"offline";
  if(!live)stopStreamAudioMeter(row?.id);
  else ensureStreamAudioMeter({...row,status:"live"});

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

// Railway terminates TLS at one trusted proxy hop; use the client IP for throttling.
app.set("trust proxy",1);
app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:true}));

// Small, bounded in-process rate limiter. It deliberately avoids a new dependency
// and protects password hashing / payment creation on the current app instance.
// If the service is scaled to multiple replicas, move this store to a shared limiter.
const requestRateLimitStore=new Map();
function rateLimit(options){
  const scope=String(options.scope||"api");
  const windowMs=Math.max(1000,Number(options.windowMs)||60000);
  const max=Math.max(1,Number(options.max)||10);
  return function(req,res,next){
    const now=Date.now();
    let identity="unknown";
    try{identity=String(typeof options.key==="function"?options.key(req):(req.ip||req.socket?.remoteAddress||"unknown")||"unknown")}catch{}
    const key=scope+":"+identity.slice(0,240);
    let state=requestRateLimitStore.get(key);
    if(!state||state.resetAt<=now){
      if(!state){
        for(const [oldKey,oldState] of requestRateLimitStore){
          if(oldState.resetAt<=now)requestRateLimitStore.delete(oldKey);
          if(requestRateLimitStore.size<10000)break;
        }
        while(requestRateLimitStore.size>=10000){
          const oldest=requestRateLimitStore.keys().next().value;
          if(oldest===undefined)break;
          requestRateLimitStore.delete(oldest);
        }
      }
      state={count:0,resetAt:now+windowMs};
      requestRateLimitStore.set(key,state);
    }
    state.count+=1;
    const remaining=Math.max(0,max-state.count);
    res.setHeader("RateLimit-Limit",String(max));
    res.setHeader("RateLimit-Remaining",String(remaining));
    res.setHeader("RateLimit-Reset",String(Math.ceil(state.resetAt/1000)));
    if(state.count>max){
      res.setHeader("Retry-After",String(Math.max(1,Math.ceil((state.resetAt-now)/1000))));
      return res.status(429).json({error:"Too many attempts. Please wait a little and try again."});
    }
    next();
  };
}
const adminLoginRateLimit=rateLimit({scope:"admin-login",windowMs:15*60*1000,max:8});
const portalLoginRateLimit=rateLimit({scope:"portal-login",windowMs:15*60*1000,max:10});
const portalRegisterRateLimit=rateLimit({scope:"portal-register",windowMs:60*60*1000,max:5});
const galleryAccessRateLimit=rateLimit({scope:"gallery-access",windowMs:15*60*1000,max:20});
const billingCheckoutRateLimit=rateLimit({scope:"billing-checkout",windowMs:15*60*1000,max:5,key:req=>req.portalUser?.id||req.ip||"unknown"});

app.get("/health",(req,res)=>res.json({ok:true,service:"FBI Client File Studio",storage:s3Ready()?"railway-object-storage":"not-ready",time:new Date().toISOString()}));

app.post("/api/auth/login",adminLoginRateLimit,async(req,res)=>{
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
app.get("/api/admin/creative-users",admin,async(req,res)=>{
 try{
  const search=String(req.query.search||"").trim().slice(0,120);
  const [users,summary]=await Promise.all([
   pool.query(`
    SELECT
      u.id,u.full_name,u.email,u.created_at,u.updated_at,
      COALESCE(sp.name,CASE WHEN sub.plan_id='trial' THEN 'Trial' WHEN sub.plan_id IS NOT NULL THEN sub.plan_id ELSE 'Not configured' END) AS plan_name,
      COALESCE(sub.status,'not_configured') AS subscription_status,
      COALESCE(sub.storage_bytes,0)::bigint AS storage_quota_bytes,
      COALESCE(account_usage.storage_used_bytes,0)::bigint AS storage_used_bytes,
      COALESCE(account_usage.project_count,0)::int AS project_count,
      COALESCE(account_usage.file_count,0)::int AS file_count,
      latest_payment.status AS latest_payment_status,
      latest_payment.amount_ghs AS latest_payment_amount_ghs,
      latest_payment.created_at AS latest_payment_created_at
    FROM users u
    LEFT JOIN creator_subscriptions sub ON sub.user_id=u.id
    LEFT JOIN subscription_plans sp ON sp.id=sub.plan_id
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(SUM(f.size_bytes),0)::bigint AS storage_used_bytes,
        COUNT(DISTINCT p.id)::int AS project_count,
        COUNT(f.id)::int AS file_count
      FROM projects p
      LEFT JOIN files f ON f.project_id=p.id AND f.trashed_at IS NULL
      WHERE p.owner_id=u.id
    ) account_usage ON TRUE
    LEFT JOIN LATERAL (
      SELECT pt.status,pt.amount_ghs,pt.created_at
      FROM payment_transactions pt
      WHERE pt.user_id=u.id
      ORDER BY pt.created_at DESC
      LIMIT 1
    ) latest_payment ON TRUE
    WHERE ($1='' OR u.full_name ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%')
    ORDER BY u.created_at DESC
    LIMIT 500
   `,[search]),
   pool.query(`
    SELECT COUNT(*)::int AS total_users,
           COUNT(*) FILTER (WHERE created_at >= now()-interval '30 days')::int AS new_last_30_days
    FROM users
   `)
  ]);
  const totals=summary.rows[0]||{};
  res.set("Cache-Control","no-store").json({
   total_users:Number(totals.total_users||0),
   new_last_30_days:Number(totals.new_last_30_days||0),
   shown:users.rowCount,
   search,
   users:users.rows.map(u=>({
    ...u,
    storage_quota_bytes:Number(u.storage_quota_bytes||0),
    storage_used_bytes:Number(u.storage_used_bytes||0),
    project_count:Number(u.project_count||0),
    file_count:Number(u.file_count||0),
    latest_payment_amount_ghs:u.latest_payment_amount_ghs==null?null:Number(u.latest_payment_amount_ghs)
   }))
  });
 }catch(e){
  console.error("Admin creative-user directory failed:",e);
  res.status(500).json({error:"Could not load creative accounts."});
 }
});
app.post("/api/portal/register",portalRegisterRateLimit,async(req,res)=>{
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
  await ensureCreatorSubscription(id);
  res.setHeader("Set-Cookie","fbi_user_session="+encodeURIComponent(userSession(r.rows[0]))+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000");
  res.json({ok:true,user:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not create your account."})}
});
app.post("/api/portal/login",portalLoginRateLimit,async(req,res)=>{
 try{
  const email=String(req.body.email||"").trim().toLowerCase(),password=String(req.body.password||"");
  const r=await pool.query("SELECT id,email,full_name,password_hash FROM users WHERE email=$1",[email]);
  if(!r.rowCount||!(await userPasswordMatches(password,r.rows[0].password_hash)))return res.status(401).json({error:"Invalid email or password."});
  const u={id:r.rows[0].id,email:r.rows[0].email,full_name:r.rows[0].full_name};
  await ensureCreatorSubscription(u.id);
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
  await ensureCreatorSubscription(req.portalUser.id);
  res.json({authenticated:true,user:r.rows[0]});
 }catch(e){res.status(500).json({error:"Could not load account."})}
});


app.get("/api/portal/billing",portalUser,async(req,res)=>{
 try{
  const sub=await getCreatorSubscription(req.portalUser.id);
  const q=await creatorQuota(req.portalUser.id);
  const plans=(await pool.query("SELECT id,name,storage_bytes,monthly_price_ghs FROM subscription_plans WHERE active=true AND id<>$1 ORDER BY monthly_price_ghs ASC",["trial"])).rows;
  const payments=(await pool.query("SELECT id,plan_id,amount_ghs,currency,provider,external_ref,provider_ref,status,authorization_url,created_at,paid_at FROM payment_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 8",[req.portalUser.id])).rows;
  const plan=(await pool.query("SELECT id,name,storage_bytes,monthly_price_ghs FROM subscription_plans WHERE id=$1",[sub?.plan_id||"trial"])).rows[0]||null;
  res.json({
    plans:plans.map(p=>({id:p.id,name:p.name,storage_bytes:Number(p.storage_bytes),monthly_price_ghs:Number(p.monthly_price_ghs)})),
    current:sub?{...sub,storage_bytes:Number(sub.storage_bytes),monthly_price_ghs:Number(sub.monthly_price_ghs),plan:plan?{id:plan.id,name:plan.name,storage_bytes:Number(sub.storage_bytes??plan.storage_bytes),monthly_price_ghs:Number(sub.monthly_price_ghs??plan.monthly_price_ghs)}:null}:null,
    usage:{quota_bytes:q.quotaBytes,used_bytes:q.usedBytes,reserved_bytes:q.reservedBytes,available_bytes:q.availableBytes,usage_percent:q.quotaBytes?Math.min(100,(q.usedBytes+q.reservedBytes)/q.quotaBytes*100):0},
    moolre:{configured:moolreConfigured(),checkout_available:moolreConfigured(),currency:CREATOR_BILLING_CURRENCY}
  });
 }catch(e){console.error("Portal billing load failed:",e);res.status(500).json({error:"Could not load subscription details."})}
});
app.post("/api/portal/billing/checkout",portalUser,billingCheckoutRateLimit,async(req,res)=>{
 try{
  const planId=String(req.body.plan_id||"").trim();
  if(!CREATOR_PLAN_IDS.includes(planId))return res.status(400).json({error:"Select a valid storage plan."});
  const planQ=await pool.query("SELECT * FROM subscription_plans WHERE id=$1 AND active=true",[planId]);
  if(!planQ.rowCount)return res.status(404).json({error:"Storage plan not found."});
  const plan=planQ.rows[0];
  const sub=await getCreatorSubscription(req.portalUser.id);
  const externalRef="FBI-CFS-"+Date.now()+"-"+crypto.randomBytes(6).toString("hex");
  const paymentId=uid();
  await pool.query(
    "INSERT INTO payment_transactions(id,user_id,subscription_id,plan_id,amount_ghs,currency,provider,external_ref,status,customer_email) VALUES($1,$2,$3,$4,$5,$6,'moolre',$7,'pending',$8)",
    [paymentId,req.portalUser.id,sub?.id||null,plan.id,Number(plan.monthly_price_ghs),CREATOR_BILLING_CURRENCY,externalRef,String(req.portalUser.email||"").toLowerCase()]
  );
  let response;
  try{
    response=await fetchMoolre("/embed/link",{
      type:1,
      amount:Number(plan.monthly_price_ghs).toFixed(2),
      email:moolreBusinessEmail(),
      externalref:externalRef,
      callback:appPublicBaseUrl(req)+"/api/payments/moolre/webhook",
      redirect:appPublicBaseUrl(req)+"/portal?payment=complete&ref="+encodeURIComponent(externalRef),
      reusable:"0",
      expiration_time:30,
      currency:CREATOR_BILLING_CURRENCY,
      accountnumber:String(process.env.MOOLRE_ACCOUNT_NUMBER),
      metadata:{platform:"FBI Client File Studio",user_id:req.portalUser.id,plan_id:plan.id,payment_id:paymentId,creator_email:req.portalUser.email}
    });
  }catch(e){
    await pool.query("UPDATE payment_transactions SET status='failed',provider_payload=$2,updated_at=now() WHERE id=$1",[paymentId,JSON.stringify({error:e.message||"Moolre request failed"})]).catch(()=>{});
    const status=e.code==="MOOLRE_NOT_CONFIGURED"?503:502;
    return res.status(status).json({error:e.message||"Moolre checkout could not be started.",code:e.code||"MOOLRE_ERROR"});
  }
  const data=response?.data&&typeof response.data==="object"?response.data:{};
  const authorizationUrl=String(data.authorization_url||"");
  if(!authorizationUrl){
    await pool.query("UPDATE payment_transactions SET status='failed',provider_payload=$2,updated_at=now() WHERE id=$1",[paymentId,JSON.stringify(response||{})]);
    return res.status(502).json({error:String(response?.message||"Moolre did not return a payment URL.")});
  }
  await pool.query("UPDATE payment_transactions SET authorization_url=$2,provider_ref=$3,provider_payload=$4,updated_at=now() WHERE id=$1",[paymentId,authorizationUrl,String(data.reference||""),JSON.stringify(response||{})]);
  res.json({ok:true,authorization_url:authorizationUrl,external_ref:externalRef,plan:{id:plan.id,name:plan.name,monthly_price_ghs:Number(plan.monthly_price_ghs),storage_bytes:Number(plan.storage_bytes)}});
 }catch(e){console.error("Portal billing checkout failed:",e);res.status(500).json({error:"Could not create the payment checkout."})}
});
app.get("/api/portal/billing/check",portalUser,async(req,res)=>{
 try{
  const externalRef=String(req.query.ref||"").trim();
  if(!externalRef)return res.status(400).json({error:"Payment reference is required."});
  const paymentQ=await pool.query("SELECT * FROM payment_transactions WHERE external_ref=$1 AND user_id=$2 LIMIT 1",[externalRef,req.portalUser.id]);
  if(!paymentQ.rowCount)return res.status(404).json({error:"Payment transaction not found."});
  let payment=paymentQ.rows[0];
  if(payment.status==="pending"&&moolreConfigured()){
    try{
      const verified=await verifyMoolrePayment(externalRef);
      if(verified.ok){
        const payload=verified.data||{};
        await activateSubscriptionFromPayment(payment,payload);
      }else if(verified.status>1){
        await pool.query("UPDATE payment_transactions SET status='failed',provider_payload=$2,updated_at=now() WHERE id=$1 AND status='pending'",[payment.id,JSON.stringify(verified.data||verified.result||{})]);
      }
    }catch(e){console.warn("Moolre payment status check failed:",e.message||e)}
  }
  payment=(await pool.query("SELECT * FROM payment_transactions WHERE id=$1",[payment.id])).rows[0]||payment;
  const sub=await getCreatorSubscription(req.portalUser.id);
  res.json({ok:true,status:payment.status,external_ref:externalRef,subscription:{plan_id:sub?.plan_id||"trial",status:sub?.status||"trialing",current_period_end:sub?.current_period_end||null}});
 }catch(e){console.error("Portal billing check failed:",e);res.status(500).json({error:"Could not check payment status."})}
});
app.post("/api/payments/moolre/webhook",async(req,res)=>{
 try{
  const body=req.body&&typeof req.body==="object"?req.body:{};
  const configuredSecret=await getMoolreWebhookSecret();
  const data=body.data&&typeof body.data==="object"?body.data:body;
  const providedSecret=String(data.secret||body.secret||"").trim();
  if(configuredSecret&&(providedSecret!==configuredSecret))return res.status(401).json({error:"Invalid webhook secret."});
  const externalRef=String(data.externalref||body.externalref||"").trim();
  const eventKey=crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
  await pool.query("INSERT INTO payment_webhook_events(id,event_key,external_ref,payload) VALUES($1,$2,$3,$4) ON CONFLICT(event_key) DO NOTHING",[uid(),eventKey,externalRef,JSON.stringify(body)]);
  const result=await processMoolreWebhookPayload(body);
  if(result.externalRef){
    // When the merchant secret has not yet been configured in Railway, a genuine
    // successful Moolre callback can bootstrap the secret into our database.
    // The callback is only trusted for this bootstrap after the payment status
    // endpoint has independently confirmed the transaction as successful.
    if(!configuredSecret&&providedSecret&&result.ok&&result.success&&!result.alreadyProcessed){
      await rememberMoolreWebhookSecret(providedSecret);
    }
    await pool.query("UPDATE payment_webhook_events SET processed_at=now() WHERE event_key=$1",[eventKey]).catch(()=>{});
  }
  return res.status(result.ok?200:202).json(result);
 }catch(e){console.error("Moolre webhook processing failed:",e);res.status(500).json({error:"Webhook processing failed."})}
});

app.get("/api/portal/settings",portalUser,async(req,res)=>{
 try{await ensureCreativeSettings(req.portalUser.id);const settings=await loadCreativeSettings(req.portalUser.id);res.json({settings:{...settings,logo_url:settings.logo_key?"/api/portal/settings/logo":""}})}
 catch(e){console.error(e);res.status(500).json({error:"Could not load creative settings."})}
});
app.patch("/api/portal/settings",portalUser,async(req,res)=>{
 try{
  await ensureCreativeSettings(req.portalUser.id);
  const cur=await loadCreativeSettings(req.portalUser.id),b=req.body||{};
  const types=["logo","text","both"],positions=["top-left","top-right","center","bottom-left","bottom-right"];
  const prefs={...cur.preferences,...(b.preferences&&typeof b.preferences==="object"?b.preferences:{})};
  const integ={...cur.integrations,...(b.integrations&&typeof b.integrations==="object"?b.integrations:{})};
  const emails={...cur.email_templates,...(b.email_templates&&typeof b.email_templates==="object"?b.email_templates:{})};
  const presets=Array.isArray(b.watermark_presets)?b.watermark_presets:cur.watermark_presets;
  await pool.query("UPDATE creative_settings SET business_name=$2,portal_title=$3,accent_color=$4,watermark_enabled=$5,watermark_type=$6,watermark_text=$7,watermark_opacity=$8,watermark_position=$9,watermark_size=$10,watermark_on_download=$11,watermark_presets=$12::jsonb,email_templates=$13::jsonb,preferences=$14::jsonb,integrations=$15::jsonb,updated_at=now() WHERE user_id=$1",[req.portalUser.id,String(b.business_name??cur.business_name).trim().slice(0,160),String(b.portal_title??cur.portal_title).trim().slice(0,160)||"Private Client Gallery",String(b.accent_color??cur.accent_color).trim().slice(0,20)||"#d4af37",Boolean(b.watermark_enabled??cur.watermark_enabled),types.includes(String(b.watermark_type))?String(b.watermark_type):cur.watermark_type,String(b.watermark_text??cur.watermark_text).trim().slice(0,180),Math.max(.05,Math.min(1,Number(b.watermark_opacity??cur.watermark_opacity)||.32)),positions.includes(String(b.watermark_position))?String(b.watermark_position):cur.watermark_position,Math.max(8,Math.min(45,Math.round(Number(b.watermark_size??cur.watermark_size)||22))),Boolean(b.watermark_on_download??cur.watermark_on_download),JSON.stringify(presets),JSON.stringify(emails),JSON.stringify(prefs),JSON.stringify(integ)]);
  const settings=await loadCreativeSettings(req.portalUser.id);res.json({ok:true,settings:{...settings,logo_url:settings.logo_key?"/api/portal/settings/logo":""}});
 }catch(e){console.error(e);res.status(500).json({error:"Could not save creative settings."})}
});
app.post("/api/portal/settings/logo",portalUser,async(req,res)=>{
 try{
  if(!s3Ready())return res.status(503).json({error:"Cloud storage is not ready."});
  await ensureCreativeSettings(req.portalUser.id);
  const dataUrl=String(req.body?.dataUrl||""),m=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if(!m)return res.status(400).json({error:"Please upload a PNG, JPG or WebP logo."});
  const input=Buffer.from(m[2],"base64");if(input.length>4*1024*1024)return res.status(400).json({error:"Logo must be smaller than 4 MB."});
  const out=await sharp(input).rotate().resize({width:1400,height:800,fit:"contain",background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
  const cur=await loadCreativeSettings(req.portalUser.id),key="creative-branding/"+req.portalUser.id+"/logo-"+Date.now()+".png";
  await s3.send(new PutObjectCommand({Bucket:bucket(),Key:key,Body:out,ContentType:"image/png",CacheControl:"private, max-age=31536000"}));
  if(cur.logo_key&&cur.logo_key!==key)await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:cur.logo_key})).catch(()=>{});
  await pool.query("UPDATE creative_settings SET logo_key=$2,updated_at=now() WHERE user_id=$1",[req.portalUser.id,key]);res.json({ok:true,logo_url:"/api/portal/settings/logo"});
 }catch(e){console.error("Creative logo upload failed:",e);res.status(500).json({error:"Could not save your logo."})}
});
app.delete("/api/portal/settings/logo",portalUser,async(req,res)=>{try{const cur=await loadCreativeSettings(req.portalUser.id);if(cur.logo_key&&s3Ready())await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:cur.logo_key})).catch(()=>{});await pool.query("UPDATE creative_settings SET logo_key='',updated_at=now() WHERE user_id=$1",[req.portalUser.id]);res.json({ok:true})}catch(e){res.status(500).json({error:"Could not remove your logo."})}});
app.get("/api/portal/settings/logo",portalUser,async(req,res)=>{try{const cur=await loadCreativeSettings(req.portalUser.id);if(!cur.logo_key||!s3Ready())return res.status(404).end();const got=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:cur.logo_key}));res.type("png").set("Cache-Control","private, max-age=300");if(got.Body?.pipe)return got.Body.pipe(res);res.end(Buffer.from(await got.Body.transformToByteArray()))}catch(e){res.status(404).end()}});
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
  const id=uid(),shareToken=token(),settings=await loadSettings(),creative=await loadCreativeSettings(req.portalUser.id);
  const defaultNote=String(req.body.note||"").trim()||settings.default_client_note||"";
  const days=settingInt(creative.preferences?.default_expiry_days,settingInt(settings.default_expiry_days,30));
  const expires=days?new Date(Date.now()+days*86400000):null;
  const autoShare=creative.preferences?.auto_share===true;
  const r=await pool.query("INSERT INTO projects(id,owner_id,name,client_name,client_email,note,share_token,expires_at,shared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",[id,req.portalUser.id,name,String(req.body.client_name||"").trim(),String(req.body.client_email||"").trim(),defaultNote,shareToken,expires,autoShare]);
  res.json({project:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not create project."})}
});
app.get("/api/portal/projects/:id",portalUser,async(req,res)=>{
 try{const p=await portalProjectAccessible(req.portalUser.id,req.params.id);if(!p)return res.status(404).json({error:"Project not found."});const f=await pool.query("SELECT * FROM files WHERE project_id=$1 AND trashed_at IS NULL ORDER BY created_at DESC",[p.id]);res.json({project:p,files:f.rows,read_only:p.owner_id!==req.portalUser.id});}
 catch(e){console.error(e);res.status(500).json({error:"Could not load project."})}
});
app.patch("/api/portal/projects/:id",portalUser,async(req,res)=>{
 try{const p=await portalProjectOwned(req.portalUser.id,req.params.id);if(!p)return res.status(404).json({error:"Project not found."});const fields=[],values=[];let n=1;for(const k of ["name","client_name","client_email","note","expires_at","shared","archived"])if(Object.prototype.hasOwnProperty.call(req.body,k)){fields.push(k+"=$"+n++);values.push(k==="shared"||k==="archived"?Boolean(req.body[k]):req.body[k]===null?null:String(req.body[k]).trim())}if(!fields.length)return res.status(400).json({error:"Nothing to update."});fields.push("updated_at=now()");values.push(p.id,req.portalUser.id);const r=await pool.query("UPDATE projects SET "+fields.join(",")+" WHERE id=$"+n+" AND owner_id=$"+(n+1)+" RETURNING *",values);if(!r.rowCount)return res.status(404).json({error:"Project not found."});res.json({project:r.rows[0]});}
 catch(e){console.error(e);res.status(500).json({error:"Could not update project."})}
});
app.get("/api/portal/projects/:id/selections",portalUser,async(req,res)=>{
 try{
  const p=await portalProjectAccessible(req.portalUser.id,req.params.id);if(!p)return res.status(404).json({error:"Project not found."});
  const r=await pool.query("SELECT id,client_name,client_email,note,file_ids,created_at FROM client_selections WHERE project_id=$1 ORDER BY created_at DESC LIMIT 50",[p.id]);
  const allIds=[...new Set(r.rows.flatMap(x=>Array.isArray(x.file_ids)?x.file_ids:[]))];
  const names=new Map();
  if(allIds.length){const f=await pool.query("SELECT id,original_name FROM files WHERE project_id=$1 AND id::text = ANY($2::text[])",[p.id,allIds]);f.rows.forEach(x=>names.set(String(x.id),x.original_name))}
  res.json({selections:r.rows.map(x=>({id:x.id,client_name:x.client_name,client_email:x.client_email,note:x.note,created_at:x.created_at,files:(x.file_ids||[]).map(id=>({id,name:names.get(String(id))||"(removed file)"}))}))});
 }catch(e){console.error(e);res.status(500).json({error:"Could not load client picks."})}
});
app.post("/api/portal/projects/:id/share",portalUser,async(req,res)=>{
 try{const p=await portalProjectOwned(req.portalUser.id,req.params.id);if(!p)return res.status(404).json({error:"Project not found."});const r=await pool.query("UPDATE projects SET share_token=$1,shared=true,updated_at=now() WHERE id=$2 AND owner_id=$3 RETURNING *",[token(),p.id,req.portalUser.id]);res.json({project:r.rows[0],share_url:(req.protocol+"://"+req.get("host"))+"/share/"+r.rows[0].share_token});}
 catch(e){console.error(e);res.status(500).json({error:"Could not create client share link."})}
});
app.get("/api/portal/projects/:id/collaborators",portalUser,async(req,res)=>{
 try{
  const p=await portalProjectOwned(req.portalUser.id,req.params.id);if(!p)return res.status(404).json({error:"Project not found."});
  const r=await pool.query("SELECT pc.id,pc.user_id,u.full_name,u.email,pc.created_at FROM project_collaborators pc JOIN users u ON u.id=pc.user_id WHERE pc.project_id=$1 ORDER BY pc.created_at ASC",[p.id]);
  res.json({collaborators:r.rows});
 }catch(e){console.error(e);res.status(500).json({error:"Could not load project collaborators."})}
});
app.post("/api/portal/projects/:id/collaborators",portalUser,async(req,res)=>{
 try{
  const p=await portalProjectOwned(req.portalUser.id,req.params.id);if(!p)return res.status(404).json({error:"Project not found."});
  const email=String(req.body.email||"").trim().toLowerCase();if(!email)return res.status(400).json({error:"Enter the collaborator's account email."});
  if(email===String(req.portalUser.email||"").trim().toLowerCase())return res.status(400).json({error:"You already own this project."});
  const u=await pool.query("SELECT id,full_name,email FROM users WHERE lower(email)=lower($1) LIMIT 1",[email]);
  if(!u.rowCount)return res.status(404).json({error:"That email does not have an FBI Client File Studio account yet. Ask them to create an account first."});
  const id=uid();
  await pool.query("INSERT INTO project_collaborators(id,project_id,user_id,invited_by) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,user_id) DO NOTHING",[id,p.id,u.rows[0].id,req.portalUser.id]);
  res.json({ok:true,collaborator:u.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not share the project with that user."})}
});
app.delete("/api/portal/projects/:id/collaborators/:userId",portalUser,async(req,res)=>{
 try{
  const p=await portalProjectOwned(req.portalUser.id,req.params.id);if(!p)return res.status(404).json({error:"Project not found."});
  await pool.query("DELETE FROM project_collaborators WHERE project_id=$1 AND user_id=$2",[p.id,req.params.userId]);
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Could not remove collaborator."})}
});
app.get("/api/portal/files",portalUser,async(req,res)=>{
 try{
  const view=String(req.query.view||"all").toLowerCase();
  const q=String(req.query.q||"").trim();
  const conditions=["p.owner_id=$1","f.trashed_at IS NULL"],vals=[req.portalUser.id];
  if(view==="favorites")conditions.push("f.favorite=true");
  if(view==="recent"){}
  if(q){vals.push("%"+q+"%");conditions.push("(f.original_name ILIKE $"+vals.length+" OR p.name ILIKE $"+vals.length+")");}
  const order=view==="recent"?"f.created_at DESC":"f.created_at DESC";
  const r=await pool.query("SELECT f.*,p.name project_name,p.client_name FROM files f JOIN projects p ON p.id=f.project_id WHERE "+conditions.join(" AND ")+" ORDER BY "+order+" LIMIT 500",vals);
  res.json({files:r.rows,view});
 }catch(e){console.error(e);res.status(500).json({error:"Could not load files."})}
});
app.get("/api/portal/shared",portalUser,async(req,res)=>{
 try{
  const r=await pool.query("SELECT p.*,u.full_name owner_name,u.email owner_email,pc.created_at shared_at,COALESCE((SELECT count(*) FROM files f WHERE f.project_id=p.id AND f.trashed_at IS NULL),0)::int file_count,COALESCE((SELECT sum(size_bytes) FROM files f WHERE f.project_id=p.id AND f.trashed_at IS NULL),0) total_bytes FROM project_collaborators pc JOIN projects p ON p.id=pc.project_id JOIN users u ON u.id=p.owner_id WHERE pc.user_id=$1 ORDER BY pc.created_at DESC",[req.portalUser.id]);
  res.json({projects:r.rows});
 }catch(e){console.error(e);res.status(500).json({error:"Could not load shared projects."})}
});
app.get("/api/portal/trash",portalUser,async(req,res)=>{
 try{
  const r=await pool.query("SELECT f.*,p.name project_name,p.client_name FROM files f JOIN projects p ON p.id=f.project_id WHERE p.owner_id=$1 AND f.trashed_at IS NOT NULL ORDER BY f.trashed_at DESC LIMIT 500",[req.portalUser.id]);
  res.json({files:r.rows});
 }catch(e){console.error(e);res.status(500).json({error:"Could not load trash."})}
});
app.patch("/api/portal/files/:id/favorite",portalUser,async(req,res)=>{
 try{
  const f=await portalFileAccessible(req.portalUser.id,req.params.id);if(!f)return res.status(404).json({error:"File not found."});
  const favorite=Boolean(req.body&&req.body.favorite);
  const r=await pool.query("UPDATE files SET favorite=$1 WHERE id=$2 RETURNING *",[favorite,f.id]);
  res.json({file:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not update favorite."})}
});
app.delete("/api/portal/files/:id",portalUser,async(req,res)=>{
 try{
  const f=await portalFileAccessible(req.portalUser.id,req.params.id);if(!f||f.owner_id!==req.portalUser.id)return res.status(404).json({error:"File not found."});
  await pool.query("UPDATE files SET trashed_at=now(),updated_at=now() WHERE id=$1",[f.id]).catch(async()=>{
    await pool.query("UPDATE files SET trashed_at=now() WHERE id=$1",[f.id]);
  });
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Could not move file to trash."})}
});
app.post("/api/portal/files/:id/restore",portalUser,async(req,res)=>{
 try{
  const f=await portalFileAccessible(req.portalUser.id,req.params.id);if(!f||f.owner_id!==req.portalUser.id)return res.status(404).json({error:"File not found."});
  await pool.query("UPDATE files SET trashed_at=NULL WHERE id=$1",[f.id]);res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Could not restore file."})}
});
app.delete("/api/portal/files/:id/permanent",portalUser,async(req,res)=>{
 try{
  const f=await portalFileAccessible(req.portalUser.id,req.params.id);if(!f||f.owner_id!==req.portalUser.id)return res.status(404).json({error:"File not found."});
  if(!f.trashed_at)return res.status(400).json({error:"Move the file to Trash before permanent deletion."});
  if(s3Ready()&&f.storage_path)await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:f.storage_path})).catch(()=>{});
  await pool.query("DELETE FROM files WHERE id=$1",[f.id]);res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Could not permanently delete the file."})}
});
// ---- What's New: product-update announcements + web push ----
function stripMd(s){return String(s||"").replace(/[#>*_`~\-]+/g," ").replace(/\[([^\]]*)\]\([^)]*\)/g,"$1").replace(/\s+/g," ").trim();}
app.get("/api/portal/announcements",portalUser,async(req,res)=>{
 try{
  const rows=(await pool.query(
    "SELECT a.id,a.title,a.body_md,a.category,a.created_at,(r.user_id IS NOT NULL) AS read "+
    "FROM announcements a LEFT JOIN announcement_reads r ON r.announcement_id=a.id AND r.user_id=$1 "+
    "WHERE a.published=true ORDER BY a.created_at DESC LIMIT 25",[req.portalUser.id])).rows;
  res.json({
    announcements:rows,
    unread:rows.filter(x=>!x.read).length,
    isAdmin:isAnnouncementAdmin(req.portalUser.email),
    pushEnabled:pushReady,
    vapidPublicKey:pushReady?VAPID_PUBLIC_KEY:""
  });
 }catch(e){console.error(e);res.status(500).json({error:"Could not load updates."})}
});
app.post("/api/portal/announcements/read",portalUser,async(req,res)=>{
 try{
  const id=String(req.body?.id||"").trim();
  if(id)await pool.query("INSERT INTO announcement_reads(user_id,announcement_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[req.portalUser.id,id]);
  else await pool.query("INSERT INTO announcement_reads(user_id,announcement_id) SELECT $1,id FROM announcements WHERE published=true ON CONFLICT DO NOTHING",[req.portalUser.id]);
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Could not update."})}
});
app.post("/api/portal/announcements",portalUser,async(req,res)=>{
 try{
  if(!isAnnouncementAdmin(req.portalUser.email))return res.status(403).json({error:"Only the studio owner can post updates."});
  const title=String(req.body?.title||"").trim().slice(0,160);
  const body=String(req.body?.body_md??req.body?.body??"").trim().slice(0,5000);
  const category=(String(req.body?.category||"update").trim().toLowerCase().slice(0,40))||"update";
  if(!title)return res.status(400).json({error:"A title is required."});
  const id=crypto.randomUUID();
  await pool.query("INSERT INTO announcements(id,title,body_md,category,created_by,published) VALUES($1,$2,$3,$4,$5,true)",[id,title,body,category,String(req.portalUser.email||"").toLowerCase()]);
  let push={sent:0};
  try{push=await sendPushToAll({title:"FBI Creative Portal",body:(title+(body?" — "+stripMd(body):"")).slice(0,140),url:"/portal?whatsnew="+id,tag:"fbi-update"});}catch(e){console.warn("Push send failed:",e?.message||e)}
  res.json({ok:true,id,push});
 }catch(e){console.error(e);res.status(500).json({error:"Could not post the update."})}
});
app.delete("/api/portal/announcements/:id",portalUser,async(req,res)=>{
 try{
  if(!isAnnouncementAdmin(req.portalUser.email))return res.status(403).json({error:"Only the studio owner can remove updates."});
  await pool.query("DELETE FROM announcements WHERE id=$1",[req.params.id]);
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Could not remove the update."})}
});
app.post("/api/portal/push/subscribe",portalUser,async(req,res)=>{
 try{
  const sub=req.body?.subscription||req.body||{};
  const ep=String(sub?.endpoint||""),p256dh=String(sub?.keys?.p256dh||""),auth=String(sub?.keys?.auth||"");
  if(!ep||!p256dh||!auth)return res.status(400).json({error:"Invalid subscription."});
  await pool.query(
    "INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth) VALUES($1,$2,$3,$4,$5) "+
    "ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth",
    [crypto.randomUUID(),req.portalUser.id,ep,p256dh,auth]);
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Could not enable notifications."})}
});
app.post("/api/portal/push/unsubscribe",portalUser,async(req,res)=>{
 try{
  const ep=String(req.body?.endpoint||"");
  if(ep)await pool.query("DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2",[ep,req.portalUser.id]);
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Could not turn off notifications."})}
});
app.post("/api/portal/push/test",portalUser,async(req,res)=>{
 try{
  if(!pushReady)return res.status(503).json({error:"Push is not configured."});
  const subs=(await pool.query("SELECT id,endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=$1",[req.portalUser.id])).rows;
  if(!subs.length)return res.json({ok:true,sent:0,note:"No device is subscribed on your account yet."});
  const data=JSON.stringify({title:"FBI Creative Portal",body:"Notifications are working — this is how you'll hear about new updates.",url:"/portal",tag:"fbi-test"});
  let sent=0;
  await Promise.all(subs.map(async s=>{
    try{await webpush.sendNotification({endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth}},data);sent++;}
    catch(err){const c=err&&err.statusCode;if(c===404||c===410)await pool.query("DELETE FROM push_subscriptions WHERE id=$1",[s.id]).catch(()=>{});}
  }));
  res.json({ok:true,sent,devices:subs.length});
 }catch(e){console.error(e);res.status(500).json({error:"Could not send the test notification."})}
});
app.get("/api/portal/thumb/:id",portalUser,async(req,res)=>{
 try{
  const q=await pool.query("SELECT f.*,p.owner_id FROM files f JOIN projects p ON p.id=f.project_id LEFT JOIN project_collaborators pc ON pc.project_id=p.id AND pc.user_id=$2 WHERE f.id=$1 AND f.trashed_at IS NULL AND (p.owner_id=$2 OR pc.user_id=$2)",[req.params.id,req.portalUser.id]);
  if(!q.rowCount)return res.status(404).send("File not found.");
  const f=q.rows[0];
  const width=Math.max(160,Math.min(640,Number(req.query.w||360))),height=Math.max(160,Math.min(720,Number(req.query.h||540)));
  const kind=thumbKind(f),cacheKind=kind==="video"?"video-v3":kind;
  const cacheKey="portal:"+f.id+":"+cacheKind+":"+width+"x"+height;
  const key="__portal-thumbnails/"+crypto.createHash("sha1").update(String(f.id)+"|"+cacheKind+"|"+width+"|"+height).digest("hex")+".webp";
  // Keep ownership checks here, then serve the image from the private bucket to
  // avoid routing repeat thumbnail bytes through the paid app-egress path.
  if(s3Ready()&&await storedObjectExists(key))return redirectToBucket(res,key,"private, no-store");
  const cached=getThumbCache(cacheKey);
  if(cached)return res.status(200).type("image/webp").set("Cache-Control","private, no-store").set("X-Content-Type-Options","nosniff").send(cached.buffer);
  const webp=await generateThumbnail(f,width,height);
  setThumbCache(cacheKey,webp);
  try{
    await s3.send(new PutObjectCommand({Bucket:bucket(),Key:key,Body:webp,ContentType:"image/webp",CacheControl:"private, max-age=31536000, immutable",Metadata:{source_file_id:String(f.id),generated_by:"fbi-client-file-studio-portal-media-aware"}}));
    return redirectToBucket(res,key,"private, no-store");
  }catch(storageError){
    console.warn("Portal thumbnail bucket write failed; serving the generated preview once:",storageError?.message||storageError);
    return res.status(200).type("image/webp").set("Cache-Control","private, no-store").set("X-Content-Type-Options","nosniff").send(webp);
  }
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
app.get("/api/portal/media/:id",portalUser,async(req,res)=>{
  try{
    const r=await pool.query("SELECT f.*,p.owner_id FROM files f JOIN projects p ON p.id=f.project_id LEFT JOIN project_collaborators pc ON pc.project_id=p.id AND pc.user_id=$2 WHERE f.id=$1 AND f.trashed_at IS NULL AND (p.owner_id=$2 OR pc.user_id=$2)",[req.params.id,req.portalUser.id]);
    if(!r.rowCount)return res.status(404).send("File not found.");
    if(!isTransportStreamVideo(r.rows[0])&&s3Ready())return redirectToBucket(res,r.rows[0].storage_path,"private, no-store");
    await streamStoredObject(req,res,r.rows[0]);
  }catch(e){console.error("Portal media stream failed:",e?.stack||e);res.status(500).send("Unable to stream file.")}
});
app.head("/api/portal/media/:id",portalUser,async(req,res)=>{
  try{
    const r=await pool.query("SELECT f.*,p.owner_id FROM files f JOIN projects p ON p.id=f.project_id LEFT JOIN project_collaborators pc ON pc.project_id=p.id AND pc.user_id=$2 WHERE f.id=$1 AND f.trashed_at IS NULL AND (p.owner_id=$2 OR pc.user_id=$2)",[req.params.id,req.portalUser.id]);
    if(!r.rowCount)return res.status(404).end();
    await streamStoredObject(req,res,r.rows[0]);
  }catch(e){console.error("Portal media HEAD failed:",e?.stack||e);res.status(500).end()}
});
app.get("/api/portal/file/:id",portalUser,async(req,res)=>{
 try{const r=await pool.query("SELECT f.*,p.owner_id FROM files f JOIN projects p ON p.id=f.project_id LEFT JOIN project_collaborators pc ON pc.project_id=p.id AND pc.user_id=$2 WHERE f.id=$1 AND f.trashed_at IS NULL AND (p.owner_id=$2 OR pc.user_id=$2)",[req.params.id,req.portalUser.id]);if(!r.rowCount)return res.status(404).send("File not found.");const f=r.rows[0];const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:f.storage_path}),{expiresIn:900});res.redirect(url);}
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

const activeEditorRenders=new Map();

function editorAtempo(speed){
  var s=Math.max(0.25,Math.min(4,Number(speed)||1));
  var out=[];
  while(s<0.5){out.push("atempo=0.5");s/=0.5}
  while(s>2){out.push("atempo=2.0");s/=2}
  out.push("atempo="+s.toFixed(5));
  return out.join(",");
}
// Build an ffmpeg video-filter tail from a combined effect/grade object.
// Neutral values (brightness/contrast/saturate = 100, everything else 0) add nothing.
// Supports classic look keys plus DaVinci-style grade keys so grading bakes into exports.
function editorEffectFilters(eff){
  eff=eff||{};
  var num=function(v,d){var n=Number(v);return isFinite(n)?n:d;};
  var f=[];
  var brightness=num(eff.brightness,100),contrast=num(eff.contrast,100),saturate=num(eff.saturate,100);
  var exposure=num(eff.exposure,0); // -100..100 (stops-ish)
  var eqB=(brightness-100)/100 + (exposure/100)*0.5;
  if(Math.abs(eqB)>0.001)f.push("eq=brightness="+Math.max(-1,Math.min(1,eqB)).toFixed(3));
  if(contrast!==100)f.push("eq=contrast="+Math.max(0,Math.min(3,contrast/100)).toFixed(3));
  if(saturate!==100)f.push("eq=saturation="+Math.max(0,Math.min(3,saturate/100)).toFixed(3));
  var temp=num(eff.temperature,0),tint=num(eff.tint,0),sh=num(eff.shadows,0),hi=num(eff.highlights,0);
  if(temp||tint||sh||hi){
    var cl=function(v){return Math.max(-1,Math.min(1,v)).toFixed(3);};
    var rm=temp/100*0.3,bm=-temp/100*0.3,gm=tint/100*0.3;
    var rs=sh/100*0.3,gs=sh/100*0.3,bs=sh/100*0.3;
    var rh=hi/100*0.3,gh=hi/100*0.3,bh=hi/100*0.3;
    f.push("colorbalance=rs="+cl(rs)+":gs="+cl(gs)+":bs="+cl(bs)+":rm="+cl(rm)+":gm="+cl(gm)+":bm="+cl(bm)+":rh="+cl(rh)+":gh="+cl(gh)+":bh="+cl(bh));
  }
  var gray=num(eff.grayscale,0),sepia=num(eff.sepia,0),blur=num(eff.blur,0);
  if(gray>0)f.push("hue=s="+Math.max(0,1-gray/100).toFixed(3));
  if(sepia>0)f.push("colorchannelmixer=rr=.393:rg=.769:rb=.189:gr=.349:gg=.686:gb=.168:br=.272:bg=.534:bb=.131");
  if(blur>0)f.push("gblur=sigma="+Math.min(30,blur).toFixed(2));
  if(num(eff.vignette,0)>0)f.push("vignette=PI/4");
  if(num(eff.grain,0)>0)f.push("noise=alls=8:allf=t+u");
  return f.length?(","+f.join(",")):"";
}

// Procedural particle / light overlays — generated from ffmpeg sources, composited with screen/add.
function overlayGenerator(preset,W,H,dur){
  var s=W+"x"+H,d=Math.max(0.2,dur).toFixed(3);
  switch(String(preset||"")){
    case"lightleak":return "gradients=s="+s+":c0=0xff6a00:c1=0x000000:c2=0xffcc33:c3=0x101010:nb_colors=4:speed=0.018:d="+d+":r=30,gblur=sigma=42";
    case"filmburn":return "gradients=s="+s+":c0=0xff3300:c1=0x000000:c2=0xffaa00:c3=0x000000:nb_colors=4:speed=0.05:d="+d+":r=30,gblur=sigma=30";
    case"rays":return "gradients=s="+s+":c0=0xfff2cc:c1=0x000000:x0=0:y0=0:x1="+W+":y1="+H+":nb_colors=2:speed=0.01:d="+d+":r=30,gblur=sigma=60";
    case"dust":return "color=c=black:s="+s+":r=30:d="+d+",noise=alls=90:allf=t,format=gray,lutyuv=y='if(gt(val,232),255,0)'";
    case"bokeh":return "color=c=black:s="+s+":r=30:d="+d+",noise=alls=96:allf=t,format=gray,lutyuv=y='if(gt(val,243),255,0)',gblur=sigma=7";
    case"snow":return "color=c=black:s="+s+":r=30:d="+d+",noise=alls=75:allf=t,format=gray,lutyuv=y='if(gt(val,236),255,0)',gblur=sigma=1.3";
    case"embers":return "color=c=black:s="+s+":r=30:d="+d+",noise=alls=92:allf=t,format=gray,lutyuv=y='if(gt(val,236),255,0)',gblur=sigma=2,format=yuv420p,colorbalance=rh=0.4:gh=0.15:bh=-0.3";
    case"grain":return "color=c=gray:s="+s+":r=30:d="+d+",noise=alls=24:allf=t+u";
    default:return "color=c=black@0.0:s="+s+":r=30:d="+d;
  }
}

// Motion tracker — a follower's position as a piecewise-linear expression over the tracked path.
function piecewiseExpr(kf,axis,dim){
  var k=kf.slice().filter(function(p){return p&&isFinite(p.t)&&isFinite(p[axis])}).sort(function(a,b){return a.t-b.t});
  if(k.length<2)return null;
  var e=(k[k.length-1][axis]*dim).toFixed(1);
  for(var i=k.length-2;i>=0;i--){var a=k[i],b=k[i+1];var av=a[axis]*dim,bv=b[axis]*dim;var dt=(b.t-a.t)||0.001;
    var seg="("+av.toFixed(1)+"+("+(bv-av).toFixed(1)+")*(t-"+a.t.toFixed(3)+")/"+dt.toFixed(3)+")";
    e="if(lt(t,"+b.t.toFixed(3)+"),"+seg+","+e+")";}
  return "if(lt(t,"+k[0].t.toFixed(3)+"),"+(k[0][axis]*dim).toFixed(1)+","+e+")";
}

// 3D perspective tilt — projects the layer in 3D space; pads transparent so it floats over lower tracks.
function perspective3dFilter(rx,ry,W,H){
  rx=Math.max(-60,Math.min(60,Number(rx)||0))*Math.PI/180;
  ry=Math.max(-60,Math.min(60,Number(ry)||0))*Math.PI/180;
  if(Math.abs(rx)<0.0017&&Math.abs(ry)<0.0017)return "";
  var cx=W/2,cy=H/2,sx=Math.sin(ry),sy=Math.sin(rx);
  var proj=function(u,v){var d=1+(u*sx+v*sy)*0.5;if(d<0.25)d=0.25;return [Math.round(cx+(u*W*0.5)/d),Math.round(cy+(v*H*0.5)/d)];};
  var TL=proj(-1,-1),TR=proj(1,-1),BL=proj(-1,1),BR=proj(1,1);
  return ",scale=iw*0.78:ih*0.78,pad="+W+":"+H+":(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba,perspective=x0="+TL[0]+":y0="+TL[1]+":x1="+TR[0]+":y1="+TR[1]+":x2="+BL[0]+":y2="+BL[1]+":x3="+BR[0]+":y3="+BR[1]+":sense=destination:eval=init,format=yuva420p";
}

// Shape mask — cuts the clip's alpha to a rectangle or feathered ellipse (Fusion mask).
function maskFilter(mask,W,H){
  if(!mask||!mask.type||mask.type==="none")return "";
  var E="\\,"; // escaped comma inside geq expressions
  if(mask.type==="ellipse"){
    var cx=((mask.cx==null?0.5:Number(mask.cx)))*W,cy=((mask.cy==null?0.5:Number(mask.cy)))*H;
    var rx=Math.max(6,((mask.rx==null?0.4:Number(mask.rx)))*W),ry=Math.max(6,((mask.ry==null?0.4:Number(mask.ry)))*H);
    var fe=Math.max(0.01,Math.min(1,Number(mask.feather)||0.02));
    var fac="clip((1+"+fe.toFixed(3)+"-hypot((X-"+cx.toFixed(1)+")/"+rx.toFixed(1)+E+"(Y-"+cy.toFixed(1)+")/"+ry.toFixed(1)+"))/"+fe.toFixed(3)+E+"0"+E+"1)";
    if(mask.invert)fac="(1-"+fac+")";
    return ",format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*"+fac+"',format=yuva420p";
  }
  // rectangle
  var x1=((mask.l==null?0.15:Number(mask.l)))*W,x2=(1-((mask.r==null?0.15:Number(mask.r))))*W,y1=((mask.t==null?0.15:Number(mask.t)))*H,y2=(1-((mask.b==null?0.15:Number(mask.b))))*H;
  var box="between(X"+E+x1.toFixed(1)+E+x2.toFixed(1)+")*between(Y"+E+y1.toFixed(1)+E+y2.toFixed(1)+")";
  if(mask.invert)box="(1-"+box+")";
  return ",format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*"+box+"',format=yuva420p";
}

// Fusion effect nodes — a linear filter chain (MediaIn -> nodes -> MediaOut), with a
// proper split/blend glow. Returns {entries:[graph strings], out:"[label]"}.
function fxLinearFilter(t,p){
  p=p||{};var amt=Number(p.amount);
  switch(t){
    case"blur":return "gblur=sigma="+Math.max(0.5,Math.min(40,isFinite(amt)?amt:6)).toFixed(2);
    case"sharpen":return "unsharp=5:5:"+Math.max(0,Math.min(4,(isFinite(amt)?amt:50)/50)).toFixed(3);
    case"edge":return "edgedetect=mode=colormix:high=0.3";
    case"invert":return "negate";
    case"bw":return "hue=s=0";
    case"mirror":return "hflip";
    case"vignette":return "vignette=PI/4";
    case"grain":return "noise=alls="+Math.round(Math.max(2,Math.min(60,isFinite(amt)?amt:12)))+":allf=t+u";
    default:return "";
  }
}
function applyFxNodes(inLabel,nodes,prefix){
  var entries=[],cur=inLabel,i=0;
  if(!Array.isArray(nodes)||!nodes.length)return {entries:entries,out:cur};
  nodes.forEach(function(n){
    if(!n||n.enabled===false)return;
    if(n.type==="glow"){
      var sig=Math.max(1,Math.min(40,Number(n.amount)||12));
      var op=Math.max(0,Math.min(1,(n.mix==null?60:Number(n.mix))/100));
      var a=prefix+"a"+i,b=prefix+"b"+i,bb=prefix+"c"+i,o=prefix+"o"+i;i++;
      entries.push(cur+"split["+a+"]["+b+"]");
      entries.push("["+b+"]gblur=sigma="+sig.toFixed(2)+",eq=brightness=0.06["+bb+"]");
      entries.push("["+a+"]["+bb+"]blend=all_mode=screen:all_opacity="+op.toFixed(3)+"["+o+"]");
      cur="["+o+"]";
    }else{
      var f=fxLinearFilter(n.type,n);if(!f)return;
      var o=prefix+"n"+i;i++;entries.push(cur+f+"["+o+"]");cur="["+o+"]";
    }
  });
  return {entries:entries,out:cur};
}

// Node-based primary/secondary color grading (Color page). Applied after the quick grade.
function colorNodeFilters(nodes){
  if(!Array.isArray(nodes)||!nodes.length)return "";
  var clampc=function(v){v=Number(v)||0;return Math.max(-1,Math.min(1,v)).toFixed(3);};
  var out="";
  nodes.forEach(function(n){
    if(!n||n.enabled===false)return;
    if(n.type==="secondary"){
      var valid={reds:1,yellows:1,greens:1,cyans:1,blues:1,magentas:1,whites:1,neutrals:1,blacks:1};
      var fam=String(n.qualifier||"reds");if(!valid[fam])fam="reds";
      var sat=(Number(n.satAdj)||0)/100,lum=(Number(n.lumAdj)||0)/100,hue=(Number(n.hueShift)||0)/100;
      var c=clampc(-sat*0.4+hue*0.2),m=clampc(hue*0.3),y=clampc(sat*0.4-hue*0.2),k=clampc(-lum*0.5);
      if(c!=="0.000"||m!=="0.000"||y!=="0.000"||k!=="0.000")out+=",selectivecolor="+fam+"="+c+" "+m+" "+y+" "+k;
    }else{
      var lift=n.lift||{},gamma=n.gamma||{},gain=n.gain||{};
      var any=["r","g","b"].some(function(k){return (lift[k]||gamma[k]||gain[k])});
      if(any)out+=",colorbalance=rs="+clampc(lift.r||0)+":gs="+clampc(lift.g||0)+":bs="+clampc(lift.b||0)+":rm="+clampc(gamma.r||0)+":gm="+clampc(gamma.g||0)+":bm="+clampc(gamma.b||0)+":rh="+clampc(gain.r||0)+":gh="+clampc(gain.g||0)+":bh="+clampc(gain.b||0);
      var con=Number(n.contrast),sat2=Number(n.saturation),exp=Number(n.exposure),temp=Number(n.temperature),tint=Number(n.tint);
      var eq=[];
      if(isFinite(exp)&&exp)eq.push("brightness="+clampc(exp/100*0.5));
      if(isFinite(con)&&con&&con!==100)eq.push("contrast="+Math.max(0,Math.min(3,con/100)).toFixed(3));
      if(isFinite(sat2)&&sat2&&sat2!==100)eq.push("saturation="+Math.max(0,Math.min(3,sat2/100)).toFixed(3));
      if(eq.length)out+=",eq="+eq.join(":");
      if((isFinite(temp)&&temp)||(isFinite(tint)&&tint))out+=",colorbalance=rm="+clampc((temp||0)/100*0.3)+":bm="+clampc(-(temp||0)/100*0.3)+":gm="+clampc((tint||0)/100*0.3);
    }
  });
  return out;
}

async function setRenderJob(id,patch){
  var fields=["status","progress","output_file_id","output_name","error"],sets=[],vals=[],n=1;
  fields.forEach(function(k){
    if(Object.prototype.hasOwnProperty.call(patch,k)){
      sets.push(k+"=$"+n++);
      vals.push(k==="progress"?Math.max(0,Math.min(100,Math.round(Number(patch[k])||0))):patch[k]);
    }
  });
  if(!sets.length)return;
  vals.push(id);
  try{await pool.query("UPDATE editor_render_jobs SET "+sets.join(",")+",updated_at=now() WHERE id=$"+n,vals)}
  catch(e){console.warn("Editor render job update failed:",e.message||e)}
}

async function runEditorRender(jobId,projectId,state,settings){
  var tmp="";
  try{
    if(!ffmpegPath)throw new Error("FFmpeg is not available on this deployment.");
    if(!s3Ready())throw new Error("Cloud file storage is not ready.");

    var resKey=String(settings&&settings.resolution||"1920x1080");
    var allowed={"1280x720":1,"1920x1080":1,"2560x1440":1,"3840x2160":1};
    if(!allowed[resKey])resKey="1920x1080";
    var dims=resKey.split("x"),W=Number(dims[0]),H=Number(dims[1]);

    var clampf=function(v){v=Number(v)||0;return Math.max(0,Math.min(0.45,v));};
    var FONT=["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf","/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf","/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf","/usr/share/fonts/TTF/DejaVuSans.ttf","/usr/share/fonts/dejavu/DejaVuSans.ttf"].find(function(p){try{return fs.existsSync(p)}catch(e){return false}})||null;

    var clips=Array.isArray(state&&state.clips)?state.clips.map(function(x){return Object.assign({},x)}).filter(function(x){return x&&(x.fileId||x.type==="title")}):[];
    if(!clips.length)throw new Error("There is nothing on the timeline to render.");

    var dbFiles=(await pool.query("SELECT * FROM files WHERE project_id=$1",[projectId])).rows;
    var fileMap=new Map(dbFiles.map(function(f){return [String(f.id),f]}));
    var isAudioClip=function(x){return x.type==="audio"||/^A/i.test(String(x.track||""));};
    var trackOrder=function(t){var m=/^V(\d+)/i.exec(String(t||"V1"));return m?Number(m[1]):1;};

    var videoClips=clips.filter(function(x){return !isAudioClip(x)});
    var audioClips=clips.filter(isAudioClip);
    if(!videoClips.length)throw new Error("A render needs at least one video, image or title clip on a video track.");
    videoClips.concat(audioClips).forEach(function(x){if(x.type!=="title"&&x.type!=="overlay"&&!fileMap.has(String(x.fileId)))throw new Error("A timeline clip refers to a missing project file.")});
    videoClips.sort(function(a,b){var d=trackOrder(a.track)-trackOrder(b.track);return d||(Number(a.start||0)-Number(b.start||0));});

    var totalDuration=0.5;
    clips.forEach(function(c){var s=Math.max(0,Number(c.start)||0),dr=Math.max(0.05,Number(c.duration)||0);totalDuration=Math.max(totalDuration,s+dr);});

    var extraFadeOut={};
    videoClips.forEach(function(c){
      if(c.transition&&c.transition.type==="dipblack"&&Number(c.transition.duration)>0){
        var prev=null;
        videoClips.forEach(function(p){if(p!==c&&String(p.track)===String(c.track)&&(Number(p.start)||0)<(Number(c.start)||0)){if(!prev||(Number(p.start)||0)>(Number(prev.start)||0))prev=p;}});
        if(prev)extraFadeOut[prev.id]=Math.max(extraFadeOut[prev.id]||0,Number(c.transition.duration));
      }
    });

    tmp=await fsp.mkdtemp(path.join(os.tmpdir(),"fbi-render-"));
    var args=["-hide_banner","-y","-loglevel","warning","-nostats","-progress","pipe:2"];
    var effect=state.effect||{};
    var trackGain=(state.trackGain&&typeof state.trackGain==="object")?state.trackGain:{};
    var inputIndex=0,vitems=[],aitems=[];

    for(var i=0;i<videoClips.length;i++){
      var c=videoClips[i];
      if(c.type==="title"){vitems.push({clip:c,index:null,image:false,title:true});continue;}
      if(c.type==="overlay"){vitems.push({clip:c,index:null,image:false,overlay:true});continue;}
      var f=fileMap.get(String(c.fileId));
      var signed=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:f.storage_path}),{expiresIn:21600});
      var image=thumbKind(f)==="image";
      var speed=Math.max(0.25,Math.min(4,Number(c.speed)||1));
      var trimIn=Math.max(0,Number(c.trimIn)||0);
      var trimOut=Math.max(trimIn+0.01,Number(c.trimOut)||trimIn+Math.max(0.05,Number(c.duration)||1)*speed);
      var dur=Math.max(0.05,(trimOut-trimIn)/speed);
      if(image)args.push("-loop","1","-framerate","30","-t",String(dur+0.3),"-i",signed);
      else args.push("-i",signed);
      vitems.push({clip:c,index:inputIndex++,image:image,title:false,dur:dur,speed:speed,trimIn:trimIn,trimOut:trimOut,file:f});
    }
    for(var j=0;j<audioClips.length;j++){
      var ac=audioClips[j];
      if(ac.type==="title")continue;
      var af=fileMap.get(String(ac.fileId));
      if(thumbKind(af)==="image")continue;
      var asigned=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:af.storage_path}),{expiresIn:21600});
      args.push("-i",asigned);
      aitems.push({clip:ac,index:inputIndex++,file:af});
    }

    var filter=[];
    filter.push("color=c=black:s="+W+"x"+H+":r=30:d="+totalDuration.toFixed(3)+",format=yuv420p[bg0]");
    var acc="[bg0]",bi=0;
    for(var k=0;k<vitems.length;k++){
      var it=vitems[k],cc=it.clip;
      var realStart=Math.max(0,Number(cc.start)||0);
      var dur2=(it.title||it.overlay)?Math.max(0.2,Number(cc.duration)||3):it.dur;
      var tr=(cc.transition&&cc.transition.type&&Number(cc.transition.duration)>0)?{type:String(cc.transition.type),dur:Math.min(Number(cc.transition.duration),dur2-0.05)}:null;
      var effStart=realStart;
      if(tr&&tr.type==="dissolve")effStart=Math.max(0,realStart-tr.dur);
      var endT=effStart+dur2;
      var lab="cv"+k,chain;
      if(it.title){
        chain="color=c=black@0.0:s="+W+"x"+H+":r=30:d="+dur2.toFixed(3)+",format=yuva420p";
        if(FONT){var txt=String(cc.text||"Title").replace(/[\\':%]/g," ").slice(0,120);var fsz=Math.round(Math.max(2,Math.min(30,Number(cc.fontSize)||7))/100*H);chain+=",drawtext=fontfile='"+FONT+"':text='"+txt+"':fontcolor="+(/^#?[0-9a-zA-Z]+$/.test(String(cc.fontColor||""))?cc.fontColor:"white")+":fontsize="+fsz+":x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=black@0.6:shadowx=2:shadowy=2";}
      }else if(it.overlay){
        chain=overlayGenerator(cc.preset,W,H,dur2);
      }else if(it.image){
        chain="["+it.index+":v]setpts=PTS-STARTPTS,scale="+W+":"+H+":force_original_aspect_ratio=decrease";
      }else{
        chain="["+it.index+":v]trim=start="+it.trimIn+":end="+it.trimOut+",setpts=(PTS-STARTPTS)/"+it.speed+",scale="+W+":"+H+":force_original_aspect_ratio=decrease";
      }
      var cr=cc.crop||{},cl=clampf(cr.l),crr=clampf(cr.r),ct=clampf(cr.t),cb=clampf(cr.b);
      if(cl||crr||ct||cb)chain+=",crop=iw*"+(1-cl-crr).toFixed(3)+":ih*"+(1-ct-cb).toFixed(3)+":iw*"+cl.toFixed(3)+":ih*"+ct.toFixed(3);
      var zoom=Math.max(10,Math.min(500,Number(cc.scale)||100))/100;
      if(Math.abs(zoom-1)>0.001)chain+=",scale=iw*"+zoom.toFixed(3)+":ih*"+zoom.toFixed(3);
      if(!it.title&&!it.overlay){chain+=editorEffectFilters(Object.assign({},effect,cc.grade||{}));chain+=colorNodeFilters(cc.colorNodes);}
      // Fusion effect nodes (may introduce split/blend sub-graphs)
      filter.push(chain+"[fxin"+k+"]");
      var fxr=applyFxNodes("[fxin"+k+"]",cc.fxNodes,"fx"+k+"_");
      fxr.entries.forEach(function(e){filter.push(e)});
      var chain2=fxr.out+"format=yuva420p";
      var rot=Number(cc.rotate)||0;
      if(Math.abs(rot)>0.01){var ra=(rot*Math.PI/180).toFixed(5);chain2+=",rotate="+ra+":c=none:ow=rotw("+ra+"):oh=roth("+ra+")";}
      var op=Math.max(0,Math.min(1,(Number(cc.opacity==null?100:cc.opacity))/100));
      if(op<0.999)chain2+=",colorchannelmixer=aa="+op.toFixed(3);
      chain2+=maskFilter(cc.mask,W,H);
      chain2+=perspective3dFilter(cc.rotX,cc.rotY,W,H);
      var fi=Math.max(0,Math.min(dur2/2,Number(cc.fadeIn)||0));if(tr)fi=Math.max(fi,tr.dur);
      var fo=Math.max(0,Math.min(dur2/2,Math.max(Number(cc.fadeOut)||0,extraFadeOut[cc.id]||0)));
      if(fi>0)chain2+=",fade=t=in:st=0:d="+fi.toFixed(3)+":alpha=1";
      if(fo>0)chain2+=",fade=t=out:st="+(dur2-fo).toFixed(3)+":d="+fo.toFixed(3)+":alpha=1";
      chain2+=",setpts=PTS+"+effStart.toFixed(3)+"/TB["+lab+"]";
      filter.push(chain2);
      var txp=(Number(cc.tx)||0)/100,typ=(Number(cc.ty)||0)/100;
      var ox,oy,evf="";
      var fpX=Array.isArray(cc.followPath)&&cc.followPath.length>=2?piecewiseExpr(cc.followPath,"x",W):null;
      var fpY=fpX?piecewiseExpr(cc.followPath,"y",H):null;
      if(fpX&&fpY){ox="("+fpX+")-overlay_w/2+("+txp.toFixed(4)+")*main_w";oy="("+fpY+")-overlay_h/2+("+typ.toFixed(4)+")*main_h";evf=":eval=frame";}
      else{ox="(main_w-overlay_w)/2+("+txp.toFixed(4)+")*main_w";oy="(main_h-overlay_h)/2+("+typ.toFixed(4)+")*main_h";}
      var en="enable='between(t,"+effStart.toFixed(3)+","+endT.toFixed(3)+")'";
      var out="bgv"+(++bi);
      var mode=String(cc.blend||"normal");
      if(it.overlay&&mode==="normal")mode="screen";
      if(mode!=="normal"&&/^(screen|addition|lighten|multiply|darken|overlay|softlight)$/.test(mode)){
        var idc=(mode==="multiply"||mode==="darken")?"white":"black";
        var cvl="bld"+bi;
        filter.push("color=c="+idc+":s="+W+"x"+H+":r=30:d="+totalDuration.toFixed(3)+",format=yuv420p[bgc"+bi+"]");
        filter.push("[bgc"+bi+"]["+lab+"]overlay=x='"+ox+"':y='"+oy+"':"+en+evf+":eof_action=pass:repeatlast=0:format=auto["+cvl+"]");
        filter.push(acc+"["+cvl+"]blend=all_mode="+mode+"["+out+"]");
      }else{
        filter.push(acc+"["+lab+"]overlay=x='"+ox+"':y='"+oy+"':"+en+evf+":eof_action=pass:repeatlast=0:format=auto["+out+"]");
      }
      acc="["+out+"]";
    }
    filter.push(acc+"format=yuv420p[vout]");
    var vcat="vout";

    var mixLabels=[];
    var addAudio=function(clip,index){
      var speed=Math.max(0.25,Math.min(4,Number(clip.speed)||1));
      var trimIn=Math.max(0,Number(clip.trimIn)||0);
      var trimOut=Math.max(trimIn+0.01,Number(clip.trimOut)||trimIn+Math.max(0.05,Number(clip.duration)||1)*speed);
      var start=Math.max(0,Number(clip.start)||0);
      var dur=Math.max(0.05,(trimOut-trimIn)/speed);
      var gain=Math.max(0,Math.min(2,Number(trackGain[clip.track]==null?100:trackGain[clip.track])/100));
      var vol=Math.max(0,Math.min(2,Number(clip.volume==null?100:clip.volume)/100))*gain;if(clip.mute)vol=0;
      var lab="aud"+index;
      var ch="["+index+":a]atrim=start="+trimIn+":end="+trimOut+",asetpts=PTS-STARTPTS,"+editorAtempo(speed)+",aresample=48000,volume="+vol.toFixed(4);
      var fi=Math.max(0,Math.min(dur/2,Number(clip.fadeIn)||0));
      var trd=(clip.transition&&Number(clip.transition.duration)>0)?Math.min(Number(clip.transition.duration),dur/2):0;if(trd)fi=Math.max(fi,trd);
      var fo=Math.max(0,Math.min(dur/2,Math.max(Number(clip.fadeOut)||0,extraFadeOut[clip.id]||0)));
      if(fi>0)ch+=",afade=t=in:st=0:d="+fi.toFixed(3);
      if(fo>0)ch+=",afade=t=out:st="+(dur-fo).toFixed(3)+":d="+fo.toFixed(3);
      ch+=",adelay="+Math.round(start*1000)+"|"+Math.round(start*1000)+"["+lab+"]";
      filter.push(ch);mixLabels.push("["+lab+"]");
    };
    for(var vi=0;vi<vitems.length;vi++){var vt=vitems[vi];if(vt.title||vt.image||vt.index==null)continue;addAudio(vt.clip,vt.index);}
    for(var ai=0;ai<aitems.length;ai++)addAudio(aitems[ai].clip,aitems[ai].index);

    var finalAudio="aout";
    if(mixLabels.length===1)filter.push(mixLabels[0]+"aresample=48000[aout]");
    else if(mixLabels.length>1)filter.push(mixLabels.join("")+"amix=inputs="+mixLabels.length+":duration=longest:normalize=0,aresample=48000[aout]");
    else filter.push("anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration="+totalDuration.toFixed(3)+",asetpts=PTS-STARTPTS[aout]");

    var outPath=path.join(tmp,safeName((state.sequence||"edited-master")+"-"+Date.now()+".mp4"));
    args.push("-filter_complex",filter.join(";"),"-map","["+vcat+"]","-map","["+finalAudio+"]","-c:v","libx264","-preset","medium","-crf","18","-pix_fmt","yuv420p","-c:a","aac","-b:a","192k","-ar","48000","-ac","2","-movflags","+faststart","-metadata","title="+String(state.sequence||"FBI Edited Master").slice(0,180),outPath);

    await setRenderJob(jobId,{status:"rendering",progress:1});
    var proc=spawn(ffmpegPath,args,{stdio:["ignore","pipe","pipe"]});
    activeEditorRenders.set(jobId,proc);
    var stderr="",last=1;
    proc.stderr.on("data",function(chunk){
      var s=chunk.toString();stderr=(stderr+s).slice(-12000);
      var matches=[...s.matchAll(/out_time_ms=(\d+)/g)];
      if(matches.length){
        var ms=Number(matches[matches.length-1][1]),sec=ms/1000000;
        var pct=Math.max(last,Math.min(99,Math.round(sec/Math.max(0.1,totalDuration)*100)));
        if(pct>last){last=pct;setRenderJob(jobId,{progress:pct})}
      }
    });
    var code=await new Promise(function(resolve,reject){proc.on("error",reject);proc.on("close",function(code,signal){resolve({code:code,signal:signal})})});
    activeEditorRenders.delete(jobId);
    if(code.code!==0)throw new Error(stderr.trim()||("FFmpeg exited with code "+String(code.code)));
    var stat=await fsp.stat(outPath);if(stat.size<1024)throw new Error("FFmpeg produced an empty render.");
    var filename=path.basename(outPath),storageKey="renders/"+projectId+"/"+jobId+"/"+filename;
    await new Upload({client:s3,params:{Bucket:bucket(),Key:storageKey,Body:fs.createReadStream(outPath),ContentType:"video/mp4",CacheControl:"private, max-age=31536000"},queueSize:2,partSize:64*1024*1024,leavePartsOnError:false}).done();
    var fileRow=(await pool.query("INSERT INTO files(id,project_id,original_name,storage_name,storage_path,mime_type,size_bytes,relative_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[uid(),projectId,filename,filename,storageKey,"video/mp4",stat.size,"Renders"])).rows[0];
    await setRenderJob(jobId,{status:"completed",progress:100,output_file_id:fileRow.id,output_name:filename});
  }catch(e){
    console.error("Editor render failed:",e&&e.stack||e);
    await setRenderJob(jobId,{status:"failed",progress:0,error:String(e&&e.message||e)});
  }finally{
    if(tmp){try{await fsp.rm(tmp,{recursive:true,force:true})}catch{}}
    activeEditorRenders.delete(jobId);
  }
}

function runFfmpegCapture(args,timeoutMs){
  return new Promise(function(resolve,reject){
    if(!ffmpegPath)return reject(new Error("FFmpeg is not available."));
    var p=spawn(ffmpegPath,args,{stdio:["ignore","ignore","pipe"]}),err="",done=false;
    var t=setTimeout(function(){if(!done){done=true;try{p.kill("SIGKILL")}catch(e){}resolve(err)}},timeoutMs||150000);
    p.stderr.on("data",function(c){err+=c.toString();if(err.length>2000000)err=err.slice(-1000000);});
    p.on("error",function(e){if(!done){done=true;clearTimeout(t);reject(e)}});
    p.on("close",function(){if(!done){done=true;clearTimeout(t);resolve(err)}});
  });
}
function parseDurationSec(s){var m=/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(s||"");return m?((+m[1])*3600+(+m[2])*60+parseFloat(m[3])):0;}
// AI Auto-Cut / Scene-split analysis — runs on our own server (ffmpeg), no external AI cost.
app.post("/api/editor/analyze/:projectId",admin,async(req,res)=>{
  try{
    if(!ffmpegPath)return res.status(503).json({error:"FFmpeg is not available on this deployment."});
    if(!s3Ready())return res.status(503).json({error:"Cloud storage is not ready."});
    var fileId=String(req.body&&req.body.fileId||""),kind=String(req.body&&req.body.kind||"silence");
    var f=(await pool.query("SELECT * FROM files WHERE id=$1 AND project_id=$2",[fileId,req.params.projectId])).rows[0];
    if(!f)return res.status(404).json({error:"That file is not in this project."});
    var url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:f.storage_path}),{expiresIn:3600});
    if(kind==="scenes"){
      var thr=Math.max(0.1,Math.min(0.9,Number(req.body.threshold)||0.35));
      var out=await runFfmpegCapture(["-hide_banner","-nostats","-i",url,"-filter:v","select='gt(scene,"+thr+")',showinfo","-an","-f","null","-"],150000);
      var cuts=[...out.matchAll(/pts_time:([0-9.]+)/g)].map(function(m){return parseFloat(m[1])}).filter(function(x){return x>0.25});
      return res.json({kind:"scenes",duration:parseDurationSec(out),cuts:cuts});
    }
    var noise=Math.max(-60,Math.min(-10,Number(req.body.noise)||-30));
    var minSil=Math.max(0.2,Math.min(5,Number(req.body.minSilence)||0.5));
    var out2=await runFfmpegCapture(["-hide_banner","-nostats","-i",url,"-af","silencedetect=noise="+noise+"dB:d="+minSil,"-f","null","-"],150000);
    var dur=parseDurationSec(out2);
    var starts=[...out2.matchAll(/silence_start:\s*(-?[0-9.]+)/g)].map(function(m){return Math.max(0,parseFloat(m[1]))});
    var ends=[...out2.matchAll(/silence_end:\s*([0-9.]+)/g)].map(function(m){return parseFloat(m[1])});
    var sil=[];for(var i=0;i<starts.length;i++){sil.push([starts[i],ends[i]!=null?ends[i]:(dur||starts[i]+minSil)]);}
    var seg=[],cur=0;sil.forEach(function(iv){if(iv[0]-cur>0.2)seg.push([Math.max(0,cur),iv[0]]);cur=Math.max(cur,iv[1]);});
    if((dur||0)-cur>0.2)seg.push([cur,dur]);
    if(!seg.length&&dur>0)seg.push([0,dur]);
    return res.json({kind:"silence",duration:dur,segments:seg});
  }catch(e){console.error("Editor analyze failed:",e);res.status(500).json({error:"Analysis failed: "+(e&&e.message||e)})}
});
app.post("/api/editor/render/:projectId",admin,async(req,res)=>{
  try{
    var p=await pool.query("SELECT id FROM projects WHERE id=$1",[req.params.projectId]);
    if(!p.rowCount)return res.status(404).json({error:"Project not found"});
    if(activeEditorRenders.size>=2)return res.status(429).json({error:"Two editor renders are already running. Please finish one before starting another."});
    var sequence=req.body&&req.body.sequence;
    if(!sequence||typeof sequence!=="object")return res.status(400).json({error:"A valid editor sequence is required"});
    var id=uid(),settings={resolution:String(req.body&&req.body.resolution||"1920x1080")};
    await pool.query("INSERT INTO editor_render_jobs(id,project_id,status,progress,settings) VALUES($1,$2,'queued',0,$3::jsonb)",[id,req.params.projectId,JSON.stringify(settings)]);
    runEditorRender(id,req.params.projectId,sequence,settings);
    res.status(202).json({job:{id:id,status:"queued",progress:0}});
  }catch(e){console.error("Editor render request failed:",e);res.status(500).json({error:"Could not start editor render"})}
});

app.get("/api/editor/renders/:id",admin,async(req,res)=>{
  try{
    var r=await pool.query("SELECT j.*,f.original_name,f.mime_type,f.size_bytes FROM editor_render_jobs j LEFT JOIN files f ON f.id=j.output_file_id WHERE j.id=$1",[req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:"Render job not found"});
    res.json({job:r.rows[0]});
  }catch(e){console.error("Editor render status failed:",e);res.status(500).json({error:"Could not read render status"})}
});

app.get("/api/editor/renders/:id/download",admin,async(req,res)=>{
  try{
    var r=await pool.query("SELECT f.* FROM editor_render_jobs j JOIN files f ON f.id=j.output_file_id WHERE j.id=$1",[req.params.id]);
    if(!r.rowCount)return res.status(404).send("Rendered file not found.");
    var url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:r.rows[0].storage_path}),{expiresIn:3600,responseContentDisposition:"attachment; filename*=UTF-8''"+encodeURIComponent(r.rows[0].original_name)});
    res.redirect(url);
  }catch(e){console.error("Editor render download failed:",e);res.status(500).send("Unable to download render.")}
});
app.get("/api/editor/sequences/:projectId",admin,async(req,res)=>{
  try{
    const p=await pool.query("SELECT id FROM projects WHERE id=$1",[req.params.projectId]);
    if(!p.rowCount)return res.status(404).json({error:"Project not found"});
    const q=await pool.query("SELECT project_id,sequence_name,sequence,updated_at FROM editor_sequences WHERE project_id=$1",[req.params.projectId]);
    if(!q.rowCount)return res.json({sequence:null});
    res.json({sequence:q.rows[0]});
  }catch(e){console.error("Editor sequence load failed:",e);res.status(500).json({error:"Could not load editor sequence"})}
});
app.put("/api/editor/sequences/:projectId",admin,async(req,res)=>{
  try{
    const p=await pool.query("SELECT id FROM projects WHERE id=$1",[req.params.projectId]);
    if(!p.rowCount)return res.status(404).json({error:"Project not found"});
    const sequence=req.body?.sequence;
    if(!sequence || typeof sequence!=="object")return res.status(400).json({error:"A valid editor sequence is required"});
    const sequenceName=String(req.body?.sequence_name||sequence.sequence||"Untitled Sequence").trim().slice(0,180)||"Untitled Sequence";
    const q=await pool.query(
      "INSERT INTO editor_sequences(project_id,sequence_name,sequence,updated_at) VALUES($1,$2,$3::jsonb,now()) ON CONFLICT(project_id) DO UPDATE SET sequence_name=EXCLUDED.sequence_name,sequence=EXCLUDED.sequence,updated_at=now() RETURNING project_id,sequence_name,sequence,updated_at",
      [req.params.projectId,sequenceName,JSON.stringify(sequence)]
    );
    await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[req.params.projectId]);
    res.json({sequence:q.rows[0]});
  }catch(e){console.error("Editor sequence save failed:",e);res.status(500).json({error:"Could not save editor sequence"})}
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

    const r=await pool.query(
      "SELECT * FROM streams WHERE stream_path=$1 OR $1 LIKE stream_path || '/%' ORDER BY length(stream_path) DESC LIMIT 1",
      [pathValue]
    );
    if(!r.rowCount){
      const m=/^(?:program|encoded)\/([^/]+)/.exec(pathValue);
      if(m){
        const rr=await pool.query("SELECT * FROM streams WHERE stream_key=$1 LIMIT 1",[m[1]]);
        if(rr.rowCount)r.rows=rr.rows.length?rr.rows:[]; 
      }
    }
    if(!r.rowCount)return res.status(403).end();

    const stream=r.rows[0];
    const isProgram=pathValue===("program/"+String(stream.stream_key||""));
    const programActive=programRouteActive(stream.id);

    if(action==="publish"){
      const directLive=pathValue===stream.stream_path;
      const programPublish=isProgram&&(
        presentedPassword===stream.stream_key ||
        presentedToken===stream.stream_key ||
        presentedPassword==="" && presentedToken===""
      );
      if(!stream.enabled)return res.status(403).end();
      if(!directLive&&!programPublish)return res.status(403).end();
      if(isProgram&&!programActive&&!programRoutePending(stream.id))return res.status(403).end();
      await pool.query("UPDATE streams SET updated_at=now() WHERE id=$1",[stream.id]);
      return res.status(200).end();
    }

    if(action==="read"||action==="playback"){
      if(!stream.enabled||!stream.shared)return res.status(403).end();
      if(isProgram&&!programActive)return res.status(403).end();
      return res.status(200).end();
    }

    if(action==="api"||action==="metrics"||action==="pprof")return res.status(200).end();
    return res.status(403).end();
  }catch(e){
    console.error(e);
    res.status(500).end();
  }
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

/*
 * Temporary development-only Live Control API.
 * These endpoints intentionally expose the standalone control-room channel
 * list and channel creation without admin authentication. The main File Studio
 * /api/streams endpoints remain protected by the normal admin session.
 */
app.get("/api/live/streams",async(req,res)=>{
  try{
    const rows=await streamRows();
    const rtmpHost=String(process.env.STREAM_RTMP_HOST||"");
    const rtmpPort=String(process.env.STREAM_RTMP_PORT||"");
    res.json({streams:rows.map(s=>({
      ...s,
      stream_key:s.stream_key,
      stream_path:s.stream_path,
      rtmp_server:rtmpHost&&rtmpPort?"rtmp://"+rtmpHost+":"+rtmpPort+"/live":"",
      hls_url:streamHlsUrl(s),
      live_url:(PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/live/"+s.id,
      viewer_url:(PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/"+s.viewer_token
    }))});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load live streams"});}
});

app.post("/api/live/streams",async(req,res)=>{
  try{
    const name=String(req.body.name||"").trim();
    if(!name)return res.status(400).json({error:"Stream name is required."});
    const key=randomStreamKey(),viewer=randomViewerToken();
    const r=await pool.query(
      "INSERT INTO streams(id,name,title,description,stream_key,stream_path,viewer_token,shared,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,true,true) RETURNING *",
      [uid(),name,String(req.body.title||name).trim(),String(req.body.description||"").trim(),key,streamPathForKey(key),viewer]
    );
    const stream=r.rows[0];
    res.json({stream:{
      ...stream,
      rtmp_server:(process.env.STREAM_RTMP_HOST&&process.env.STREAM_RTMP_PORT)?"rtmp://"+process.env.STREAM_RTMP_HOST+":"+process.env.STREAM_RTMP_PORT+"/live":"",
      hls_url:streamHlsUrl(stream),
      live_url:(PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/live/"+stream.id,
      viewer_url:(PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/"+stream.viewer_token
    }});
  }catch(e){console.error(e);res.status(500).json({error:"Could not create stream"});}
});
app.get("/api/live/streams/:id",async(req,res)=>{
  try{
    const q=await pool.query("SELECT * FROM streams WHERE id=$1",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Stream not found."});
    const s=await refreshStreamStatus(q.rows[0]);
    const rtmpHost=String(process.env.STREAM_RTMP_HOST||"");
    const rtmpPort=String(process.env.STREAM_RTMP_PORT||"");
    res.json({stream:{
      ...s,
      rtmp_server:rtmpHost&&rtmpPort?"rtmp://"+rtmpHost+":"+rtmpPort+"/live":"",
      hls_url:streamHlsUrl(s),
      live_url:(PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/live/"+s.id,
      viewer_url:(PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/"+s.viewer_token
    }});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load live stream"});}
})
app.post("/api/live/streams/:id/program/start",async(req,res)=>{
  try{
    const q=await pool.query("SELECT * FROM streams WHERE id=$1 AND enabled=true",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Stream not found."});
    const stream=await refreshStreamStatus(q.rows[0]);
    if(stream.status!=="live")return res.status(409).json({error:"The channel must already be live from OBS/vMix before Local Studio can take Program."});
    prepareProgramRoute(stream.id);
    const url=streamProgramRtmpUrl(stream);
    if(!url)return res.status(503).json({error:"Program RTMP output is not configured."});
    res.set("Cache-Control","no-store").json({ok:true,stream_id:stream.id,program_rtmp_url:url,viewer_url:(PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/"+stream.viewer_token});
  }catch(e){
    console.error("Program start failed:",e);
    res.status(500).json({error:"Could not prepare Program output."});
  }
});

app.post("/api/live/streams/:id/program/activate",async(req,res)=>{
  try{
    const q=await pool.query("SELECT id FROM streams WHERE id=$1 AND enabled=true",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Stream not found."});
    activateProgramRoute(q.rows[0].id);
    res.set("Cache-Control","no-store").json({ok:true,active:true});
  }catch(e){
    console.error("Program activate failed:",e);
    res.status(500).json({error:"Could not activate Program output."});
  }
});

app.post("/api/live/streams/:id/program/stop",async(req,res)=>{
  try{
    deactivateProgramRoute(req.params.id);
    res.set("Cache-Control","no-store").json({ok:true,active:false});
  }catch(e){
    console.error("Program stop failed:",e);
    res.status(500).json({error:"Could not stop Program output."});
  }
});

app.get("/api/live/streams/:id/audio-level",async(req,res)=>{
  try{
    const q=await pool.query("SELECT * FROM streams WHERE id=$1 AND enabled=true",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Stream not found."});
    const stream=await refreshStreamStatus(q.rows[0]);
    if(stream.status!=="live"){
      stopStreamAudioMeter(stream.id);
      return res.json({live:false,left:-60,right:-60,overall:-60});
    }
    const meter=ensureStreamAudioMeter(stream);
    if(!meter)return res.json({live:true,left:-60,right:-60,overall:-60});
    const stale=Date.now()-meter.lastAt>2500;
    const level=stale?-60:Math.max(-60,Math.min(0,Number(meter.level)||-60));
    res.set("Cache-Control","no-store");
    res.json({live:true,left:level,right:level,overall:level,source:"server-audio-meter",timestamp:Date.now()});
  }catch(e){
    console.error("Live audio level failed:",e);
    res.status(500).json({error:"Could not read live audio level"});
  }
});
;

app.post("/api/live/streams/:id/regenerate-key",async(req,res)=>{
  try{
    const key=randomStreamKey();
    const r=await pool.query("UPDATE streams SET stream_key=$1,stream_path=$2,updated_at=now(),status='offline',started_at=NULL,ended_at=now() WHERE id=$3 RETURNING *",[key,streamPathForKey(key),req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:"Stream not found"});
    const s=r.rows[0];
    const rtmpHost=String(process.env.STREAM_RTMP_HOST||"");
    const rtmpPort=String(process.env.STREAM_RTMP_PORT||"");
    res.json({stream:{
      ...s,
      rtmp_server:rtmpHost&&rtmpPort?"rtmp://"+rtmpHost+":"+rtmpPort+"/live":"",
      hls_url:streamHlsUrl(s),
      live_url:(PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/live/"+s.id,
      viewer_url:(PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/"+s.viewer_token
    }});
  }catch(e){console.error(e);res.status(500).json({error:"Could not regenerate stream key"});}
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

    const upstreamPath=programRouteActive(row.id)?"program/"+String(row.stream_key||""):"encoded/"+String(row.stream_key||"");
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
function publicHlsCacheKey(token,upstreamPath,pathname,query){
  const q=new URLSearchParams(query||""); q.delete("session"); q.delete("cookieCheck");
  return String(token)+"|"+String(upstreamPath||"")+"|"+String(pathname||"")+"|"+q.toString();
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
function publicHlsSessionGet(token,upstreamPath){
  const v=publicHlsSessionByToken.get(String(token||""));
  if(!v)return "";
  if(v.expiresAt<Date.now()){publicHlsSessionByToken.delete(String(token||""));return "";}
  if(String(v.upstreamPath||"")!==String(upstreamPath||""))return "";
  return v.session;
}
function publicHlsSessionSet(token,session,upstreamPath){
  if(!token||!session||!upstreamPath)return;
  publicHlsSessionByToken.set(String(token),{session:String(session),upstreamPath:String(upstreamPath),expiresAt:Date.now()+25*60*1000});
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
    const forceOriginalInput=String(req.query?.source||"").toLowerCase()==="input";
    const upstreamPath=forceOriginalInput
      ?"live/"+String(row.stream_key||"")
      :(programRouteActive(row.id)?"program/"+String(row.stream_key||""):"encoded/"+String(row.stream_key||""));
    const upstream=new URL(internalBase+"/"+upstreamPath+(sub?"/"+sub:""));
    for(const [k,v] of Object.entries(req.query||{}))upstream.searchParams.append(k,String(v));
    if(forceOriginalInput)upstream.searchParams.delete("source");
    const incomingCookies=String(req.headers.cookie||"");
    const proxySession=(incomingCookies.match(/(?:^|;\s*)fbi_public_hls_session=([^;]+)/)||[])[1]||"";
    const sharedSession=publicHlsSessionGet(token,upstreamPath);
    // A TAKE changes the upstream MediaMTX path while keeping the same public
    // viewer URL. Never carry an old encoded/program HLS session into a new
    // upstream path or MediaMTX will keep serving the previous path.
    if(sharedSession){
      upstream.searchParams.set("session",sharedSession);
    }else{
      upstream.searchParams.delete("session");
    }
    const upstreamHeaders={};
    if(sub==="index.m3u8"&&!sharedSession){
      upstreamHeaders.cookie="cookieCheck=1";
    }

    const isPlaylist=/\.m3u8$/i.test(sub);
    if(!isPlaylist){
      const cacheKey=publicHlsCacheKey(token,upstreamPath,sub,upstream.search);
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
      if(session)publicHlsSessionSet(token,session,upstreamPath);
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
    const q=await pool.query("SELECT id,filename,status,size_bytes,started_at,ended_at,created_at,storage_key,error FROM stream_recordings WHERE stream_id=$1 ORDER BY created_at DESC LIMIT 1",[stream.id]);
    const recording=q.rows[0];

    if(!s3Ready())return res.json({available:false,status:"storage_unavailable"});
    if(!recording)return res.json({available:false,status:"none"});
    if(recording.status==="recording"){
      return res.json({available:false,status:"recording",recording:{id:recording.id,filename:recording.filename,started_at:recording.started_at}});
    }
    if(recording.status==="failed"){
      return res.json({available:false,status:"failed",message:"Replay could not be saved for this broadcast."});
    }
    if(recording.status!=="completed"||Number(recording.size_bytes)<=0){
      return res.json({available:false,status:"empty"});
    }
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

LV.registerViewerSave(app,{pool,publicStreamByToken,cookies});

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
}${LV.WATCH_CSS}</style></head><body>${LV.WATCH_TOPBAR}<div class="wrap"><div class="head"><div class="brand">FILM BEYOND IMAGINATION • FBI Live</div><div style="margin-top:8px"><span class="badge" id="status">Checking live status…</span></div><h1>${title}</h1><p id="viewers">FBI Live Stream</p>${LV.WATCH_ACTIONS}</div><div class="layout"><section><div class="card player"><video id="video" controls playsinline autoplay muted></video><div id="offline" class="offline" style="display:none"></div><div class="mobile-live-ui"><span class="mobile-live-status" id="mobileLiveStatus">CONNECTING…</span><span class="mobile-viewer-badge"><b id="mobileViewerCount">0</b> watching</span><div id="mobileFloatingComments" class="mobile-floating-comments"></div><div id="mobileReactionFloaters" class="mobile-reaction-floaters"></div><div class="mobile-reaction-rail"><button type="button" class="mobile-reaction-btn" data-mobile-reaction="👏" aria-label="Clap">👏</button><button type="button" class="mobile-reaction-btn" data-mobile-reaction="❤️" aria-label="Love">❤️</button><button type="button" class="mobile-reaction-btn heart" data-mobile-reaction="❤️" aria-label="Send heart">♥</button></div></div><div class="playerbar"><span class="nowq" id="streamState">Connecting…</span></div></div></section><aside class="card comments"><div class="comments-head"><h2>Live Comments</h2><span class="badge" id="commentCount">0</span></div><div id="commentList" class="comment-list"><div style="color:#777;font-size:9px;padding:10px 0">No comments yet.</div></div><form id="commentForm" class="comment-form"><input id="commentName" maxlength="60" placeholder="Your name"><textarea id="commentText" maxlength="500" placeholder="Write a comment…"></textarea><div class="comment-tools"><div class="emoji-popover" id="emojiPopover"><button type="button" class="emoji-open" id="emojiOpen" title="Add emoji">😊</button><emoji-picker id="emojiPicker" locale="en"></emoji-picker></div><button type="submit">Post Comment</button></div><div class="statusline" id="commentStatus"></div></form></aside></div><div class="foot">FBI Live • Live broadcast and viewer comments • viewer-badge-sync-1</div></div><script>
const token=${tokenJs},hlsUrl=${JSON.stringify(hls)};const video=document.getElementById("video"),emojiOpen=document.getElementById("emojiOpen"),emojiPopover=document.getElementById("emojiPopover"),emojiPicker=document.getElementById("emojiPicker"),offline=document.getElementById("offline"),statusEl=document.getElementById("status"),viewers=document.getElementById("viewers"),streamState=document.getElementById("streamState"),commentList=document.getElementById("commentList"),commentCount=document.getElementById("commentCount"),commentForm=document.getElementById("commentForm"),commentName=document.getElementById("commentName"),commentText=document.getElementById("commentText"),commentStatus=document.getElementById("commentStatus");const sessionKey=crypto.randomUUID();let player=null,live=false,replayMode=false,replayPending=false,replayTimer=0;const mobileFloatingComments=document.getElementById("mobileFloatingComments"),mobileReactionFloaters=document.getElementById("mobileReactionFloaters"),mobileViewerCount=document.getElementById("mobileViewerCount"),mobileLiveStatus=document.getElementById("mobileLiveStatus");let mobileReactionIndex=0;const mobileLiveUi=document.querySelector(".mobile-live-ui");let mobileReactionHideTimer=0;function revealMobileReactions(){if(!mobileLiveUi)return;mobileLiveUi.classList.add("show-reactions");clearTimeout(mobileReactionHideTimer);mobileReactionHideTimer=setTimeout(function(){mobileLiveUi.classList.remove("show-reactions")},3200)}video.addEventListener("pointerup",revealMobileReactions);
video.addEventListener("loadedmetadata",function(){if(replayMode)streamState.textContent="Replay ready"});
video.addEventListener("error",function(){if(!replayMode)return;const err=video.error;streamState.textContent=err?"Replay playback error ("+String(err.code)+")":"Replay playback error"});
${LV.PINNED_JS}
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
    if(!d.available){
      replayPending=d.status==="recording";
      if(d.status==="recording"){
        offline.textContent="The live stream has ended. Preparing the replay…";
        streamState.textContent="Replay is being saved…";
      }else if(d.status==="storage_unavailable"){
        offline.textContent="Replay storage is temporarily unavailable.";
        streamState.textContent="Replay storage unavailable";
      }else if(d.status==="failed"){
        offline.textContent="This broadcast's replay could not be saved.";
        streamState.textContent="Replay saving failed";
      }else if(d.status==="empty"){
        offline.textContent="The replay file is empty and cannot be played.";
        streamState.textContent="Replay file is empty";
      }else{
        offline.textContent="The live stream has ended. No replay was saved for this broadcast.";
        streamState.textContent="No replay available";
      }
      return false;
    }
    replayPending=false;
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
    replayPending=false;
    offline.textContent="Replay could not be loaded. Please try again shortly.";
    streamState.textContent=e.message||"Replay unavailable";
    return false;
  }
}
async function showOfflineOrReplay(){
  if(await loadReplay())return;
  offline.style.display="grid";
  video.style.display="none";
  clearTimeout(replayTimer);
  if(replayPending)replayTimer=setTimeout(()=>{if(!live)refresh()},5000);
}
async function refresh(){if(pinnedPlay())return;try{const r=await fetch("/api/public/stream/"+encodeURIComponent(token)+"/status",{cache:"no-store"}),d=await r.json();if(!r.ok)throw new Error(d.error);if(d.live){clearTimeout(replayTimer);statusEl.textContent="● LIVE";statusEl.className="badge live";const viewerCount=Number(d.current_viewers||0);viewers.textContent=viewerCount+" watching now";updateMobileViewerUi(viewerCount);if(!live||replayMode){live=true;startPlayer()}await fetch("/api/public/stream/"+encodeURIComponent(token)+"/heartbeat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionKey})});}else{if(live){live=false;clearPlayer()}statusEl.textContent="OFFLINE";statusEl.className="badge";await showOfflineOrReplay()}}catch(e){statusEl.textContent="STREAM UNAVAILABLE";statusEl.className="badge error";streamState.textContent=e.message||"Unavailable"}}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function fmtTime(v){try{return new Date(v).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}catch{return ""}}
async function loadComments(){try{const r=await fetch("/api/public/stream/"+encodeURIComponent(token)+"/comments?limit=80",{cache:"no-store"}),d=await r.json();if(!r.ok)throw new Error(d.error);const rows=d.comments||[];commentCount.textContent=rows.length;commentList.innerHTML=rows.length?rows.map(x=>'<div class="comment"><b>'+esc(x.display_name)+'</b><span>'+esc(x.comment)+'</span><time>'+esc(fmtTime(x.created_at))+'</time></div>').join(""):'<div style="color:#777;font-size:9px;padding:10px 0">No comments yet. Start the conversation.</div>';commentList.scrollTop=commentList.scrollHeight;renderMobileOverlay(rows);updateMobileViewerUi()}catch(e){commentStatus.textContent=e.message||"Comments unavailable"}}
commentForm.onsubmit=async e=>{e.preventDefault();const name=commentName.value.trim()||"Anonymous",comment=commentText.value.trim();if(!comment)return;commentStatus.textContent="Posting…";try{const r=await fetch("/api/public/stream/"+encodeURIComponent(token)+"/comments",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({display_name:name,comment})}),d=await r.json();if(!r.ok)throw new Error(d.error);try{localStorage.setItem("fbiLiveCommentName",name)}catch{}commentText.value="";commentStatus.textContent="";await loadComments()}catch(e){commentStatus.textContent=e.message||"Could not post comment"}};
updateMobileViewerUi();refresh();loadComments();setInterval(loadComments,5000);setInterval(refresh,15000);
</script><script>${LV.SAVE_JS}</script></body></html>`);
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
    // Insights for the storage page: what is using space and how data flows
    // in (uploads) and out (client deliveries). Each query fails soft.
    const soft=q=>q.catch(err=>{console.warn("Storage insight query failed",err?.message||err);return {rows:[]}});
    const [typeQ,topQ,inQ,outQ,dailyQ]=await Promise.all([
      soft(pool.query(`SELECT CASE WHEN mime_type LIKE 'video/%' THEN 'Video' WHEN mime_type LIKE 'image/%' THEN 'Photo' WHEN mime_type LIKE 'audio/%' THEN 'Audio' WHEN mime_type='application/pdf' THEN 'PDF' WHEN mime_type LIKE 'application/zip%' OR mime_type LIKE '%compressed%' THEN 'Archive' ELSE 'Other' END AS type,count(*)::int files,COALESCE(sum(size_bytes),0)::numeric bytes FROM files GROUP BY 1 ORDER BY bytes DESC`)),
      soft(pool.query(`SELECT p.id,p.name,p.client_name,p.archived,p.shared,count(f.id)::int files,COALESCE(sum(f.size_bytes),0)::numeric bytes,
        (SELECT f2.id::text FROM files f2 WHERE f2.project_id=p.id AND f2.mime_type LIKE 'image/%' ORDER BY f2.size_bytes DESC LIMIT 1) cover_id
        FROM projects p LEFT JOIN files f ON f.project_id=p.id GROUP BY p.id ORDER BY bytes DESC LIMIT 6`)),
      soft(pool.query(`SELECT count(*)::int n,COALESCE(sum(size_bytes),0)::numeric bytes FROM files WHERE created_at>=now()-interval '30 days'`)),
      soft(pool.query(`SELECT count(*)::int n,COALESCE(sum(f.size_bytes),0)::numeric bytes FROM downloads d LEFT JOIN files f ON f.id=d.file_id WHERE d.downloaded_at>=now()-interval '30 days'`)),
      soft(pool.query(`SELECT to_char(g::date,'YYYY-MM-DD') day,
        COALESCE((SELECT sum(size_bytes) FROM files WHERE created_at>=g AND created_at<g+interval '1 day'),0)::numeric up,
        COALESCE((SELECT sum(f.size_bytes) FROM downloads x JOIN files f ON f.id=x.file_id WHERE x.downloaded_at>=g AND x.downloaded_at<g+interval '1 day'),0)::numeric down
        FROM generate_series(date_trunc('day',now())-interval '29 days',date_trunc('day',now()),interval '1 day') g ORDER BY 1`))
    ]);
    const insights={
      types:typeQ.rows.map(x=>({type:x.type,files:Number(x.files||0),bytes:Number(x.bytes||0)})),
      top_projects:topQ.rows.map(x=>({id:x.id,name:x.name,client_name:x.client_name,archived:x.archived,shared:x.shared,files:Number(x.files||0),bytes:Number(x.bytes||0),cover_id:x.cover_id||null})),
      in_30d:{files:Number(inQ.rows[0]?.n||0),bytes:Number(inQ.rows[0]?.bytes||0)},
      out_30d:{downloads:Number(outQ.rows[0]?.n||0),bytes:Number(outQ.rows[0]?.bytes||0)},
      daily:dailyQ.rows.map(x=>({day:x.day,up:Number(x.up||0),down:Number(x.down||0)}))
    };
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
      },
      insights
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
    const fileRow=ins.rows[0]||(await pool.query("SELECT * FROM files WHERE storage_path=$1 LIMIT 1",[u.storage_key])).rows[0];warmMediaCache(fileRow);
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
    const [counts,recentProjects,recentDownloads,typeRows,picksRows,dailyRows]=await Promise.all([
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
        ARRAY(SELECT f.id::text FROM files f WHERE f.project_id=p.id AND f.mime_type LIKE 'image/%' ORDER BY f.size_bytes DESC LIMIT 3) cover_ids,
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
        FROM files GROUP BY 1 ORDER BY bytes DESC`),
      pool.query(`SELECT s.id,s.project_id,p.name project_name,s.client_name,s.client_email,jsonb_array_length(s.file_ids) AS count,s.created_at
        FROM client_selections s LEFT JOIN projects p ON p.id=s.project_id
        ORDER BY s.created_at DESC LIMIT 6`).catch(()=>({rows:[]})),
      pool.query(`SELECT to_char(date_trunc('day',downloaded_at),'YYYY-MM-DD') day,count(*)::int n
        FROM downloads WHERE downloaded_at>=date_trunc('day',now())-interval '13 days' GROUP BY 1 ORDER BY 1`).catch(()=>({rows:[]}))
    ]);
    res.json({summary:counts.rows[0],recentProjects:recentProjects.rows,recentDownloads:recentDownloads.rows,types:typeRows.rows,recentPicks:picksRows.rows,downloadsDaily:dailyRows.rows});
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
  const projectId=String(req.body.projectId||""),originalName=String(req.body.name||"").trim(),relativePath=safeRelativePath(req.body.relativePath,originalName),size=Number(req.body.size||0),mimeType=String(req.body.mimeType||"application/octet-stream"),fingerprint=String(req.body.fingerprint||"").trim().slice(0,128),fingerprintType=String(req.body.fingerprintType||"full").trim().toLowerCase();
  const project=await portalProjectOwned(req.portalUser.id,projectId);
  if(!project)return res.status(404).json({error:"Project not found."});
  if(!originalName||!Number.isFinite(size)||size<0||size>MAX_FILE_SIZE)return res.status(400).json({error:"Invalid file."});
  const entitlement=await creatorQuota(req.portalUser.id);
  if(!entitlement.active)return res.status(402).json({error:"Your storage trial or subscription is not active. Open Billing to choose a plan.",code:"SUBSCRIPTION_REQUIRED",storage:{quota_bytes:entitlement.quotaBytes,used_bytes:entitlement.usedBytes,reserved_bytes:entitlement.reservedBytes,available_bytes:entitlement.availableBytes}});
  // Sample-based large-file identity is only for resumable session binding,
  // not strong enough for duplicate detection.
  if(fingerprint && fingerprintType==="full"){
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
  let quotaForNewUpload;
  try{quotaForNewUpload=await assertCreatorQuotaForUpload(req.portalUser.id,null,size)}
  catch(e){
    const status=e.code==="STORAGE_QUOTA_EXCEEDED"?413:e.code==="SUBSCRIPTION_REQUIRED"?402:500;
    return res.status(status).json({error:e.message,code:e.code||"UPLOAD_QUOTA_ERROR",storage:e.quota?{quota_bytes:e.quota.quotaBytes,used_bytes:e.quota.usedBytes,reserved_bytes:e.quota.reservedBytes,available_bytes:e.quota.availableBytes,projected_bytes:e.quota.projectedBytes}:undefined});
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
app.post("/api/portal/uploads/:id/part-fallback",portalUser,express.raw({type:"application/octet-stream",limit:"80mb"}),async(req,res)=>{
  try{
    if(!s3Ready())return res.status(503).json({error:"Cloud storage is not ready."});
    const q=await pool.query("SELECT u.* FROM upload_sessions u JOIN projects p ON p.id=u.project_id WHERE u.id=$1 AND p.owner_id=$2",[req.params.id,req.portalUser.id]);
    if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
    const u=q.rows[0];
    if(u.mode!=="multipart"||!u.multipart_upload_id)return res.status(400).json({error:"This upload does not use multipart storage."});
    const partNumber=Number(req.query.partNumber||req.headers["x-fbi-part-number"]||0);
    const totalParts=Math.max(1,Math.ceil(Number(u.size_bytes||0)/Math.max(1,Number(u.part_size||MIN_PART_SIZE))));
    if(!Number.isInteger(partNumber)||partNumber<1||partNumber>totalParts)return res.status(400).json({error:"Invalid multipart section."});
    const body=Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0);
    const start=(partNumber-1)*Number(u.part_size||MIN_PART_SIZE);
    const expected=Math.min(Number(u.size_bytes||0)-start,Number(u.part_size||MIN_PART_SIZE));
    if(expected<0||body.length!==expected)return res.status(400).json({error:"Multipart section size does not match the upload session.",expectedBytes:expected,receivedBytes:body.length});
    const alive=await multipartUploadAlive(u);
    if(!alive)return res.status(409).json({error:"The cloud multipart session is no longer available.",code:"UPLOAD_SESSION_GONE"});
    const existing=(await listMultipartPartsDetailed(u)).find(p=>p.partNumber===partNumber);
    if(existing&&existing.size===body.length&&existing.etag)return res.json({ok:true,partNumber,etag:existing.etag,reused:true});
    const out=await s3.send(new UploadPartCommand({
      Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,PartNumber:partNumber,
      Body:body,ContentLength:body.length
    }));
    await pool.query("UPDATE upload_sessions SET updated_at=now() WHERE id=$1 AND status='active'",[u.id]);
    res.json({ok:true,partNumber,etag:String(out.ETag||"")});
  }catch(e){
    const code=String(e?.Code||e?.name||"");
    const status=Number(e?.$metadata?.httpStatusCode||0);
    if(code==="NoSuchUpload"||code==="InvalidUploadId"||status===404)return res.status(409).json({error:"The cloud multipart session is no longer available.",code:"UPLOAD_SESSION_GONE"});
    console.error("Portal failed-part fallback failed:",e?.stack||e);
    res.status(502).json({error:"Cloud storage rejected the fallback section. Please retry this section."});
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

  try{
    try{await assertCreatorQuotaForUpload(req.portalUser.id,u.id,Number(u.size_bytes||0));}
    catch(e){
      const status=e.code==="STORAGE_QUOTA_EXCEEDED"?413:e.code==="SUBSCRIPTION_REQUIRED"?402:500;
      return res.status(status).json({error:e.message,code:e.code||"UPLOAD_QUOTA_ERROR"});
    }
    const fileRow=await finalizeStoredUpload(u);
    return res.json({ok:true,file:fileRow,alreadyCompleted:u.status==="completed"});
  }catch(e){
    if(e&&e.code==="UPLOAD_INCOMPLETE"){
      const state=e.state||{};
      return res.status(409).json({
        error:"Multipart upload is not complete yet.",
        ready:false,
        uploadedBytes:Number(state.uploadedBytes||0),
        totalSize:Number(u.size_bytes||0),
        completedParts:Number(state.completedParts||0),
        totalParts:Number(state.totalParts||0),
        missingParts:Array.isArray(state.missingParts)?state.missingParts:[]
      });
    }
    throw e;
  }
 }catch(e){
  const code=String(e?.code||e?.Code||e?.name||"");
  const status=Number(e?.$metadata?.httpStatusCode||0);
  if(code==="UPLOAD_SESSION_GONE"||code==="NoSuchUpload"||code==="InvalidUploadId"||status===404){
    await pool.query("UPDATE upload_sessions SET status='aborted',updated_at=now() WHERE id=$1",[req.params.id]).catch(function(){});
    return res.status(409).json({error:"The cloud multipart session is no longer available. Reconnecting safely…",code:"UPLOAD_SESSION_GONE"});
  }
  console.error("Portal upload finalization failed:",e);
  res.status(500).json({error:"Upload reached storage but could not be registered in the project. Please resume the upload; it will safely continue from the stored data."});
 }
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
    var fingerprintType=String(req.body.fingerprintType||"full").trim().toLowerCase();
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
            fileRow=ins.rows[0]||(await pool.query("SELECT * FROM files WHERE storage_path=$1 LIMIT 1",[u.storage_key])).rows[0];warmMediaCache(fileRow);
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

    // The large-file identity is sample-based, so it is safe for resumable
    // session binding but not strong enough to claim a file is a duplicate.
    if(fingerprint && fingerprintType==="full"){
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

app.post("/api/uploads/:id/part-fallback",admin,express.raw({type:"application/octet-stream",limit:"80mb"}),async(req,res)=>{
  try{
    if(!s3Ready())return res.status(503).json({error:"Cloud storage is not ready."});
    const q=await pool.query("SELECT * FROM upload_sessions WHERE id=$1",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
    const u=q.rows[0];
    if(u.mode!=="multipart"||!u.multipart_upload_id)return res.status(400).json({error:"This upload does not use multipart storage."});
    const partNumber=Number(req.query.partNumber||req.headers["x-fbi-part-number"]||0);
    const totalParts=Math.max(1,Math.ceil(Number(u.size_bytes||0)/Math.max(1,Number(u.part_size||MIN_PART_SIZE))));
    if(!Number.isInteger(partNumber)||partNumber<1||partNumber>totalParts)return res.status(400).json({error:"Invalid multipart section."});
    const body=Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0);
    const start=(partNumber-1)*Number(u.part_size||MIN_PART_SIZE);
    const expected=Math.min(Number(u.size_bytes||0)-start,Number(u.part_size||MIN_PART_SIZE));
    if(expected<0||body.length!==expected)return res.status(400).json({error:"Multipart section size does not match the upload session.",expectedBytes:expected,receivedBytes:body.length});
    const alive=await multipartUploadAlive(u);
    if(!alive)return res.status(409).json({error:"The cloud multipart session is no longer available.",code:"UPLOAD_SESSION_GONE"});
    const existing=(await listMultipartPartsDetailed(u)).find(p=>p.partNumber===partNumber);
    if(existing&&existing.size===body.length&&existing.etag)return res.json({ok:true,partNumber,etag:existing.etag,reused:true});
    const out=await s3.send(new UploadPartCommand({
      Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,PartNumber:partNumber,
      Body:body,ContentLength:body.length
    }));
    await pool.query("UPDATE upload_sessions SET updated_at=now() WHERE id=$1 AND status='active'",[u.id]);
    res.json({ok:true,partNumber,etag:String(out.ETag||"")});
  }catch(e){
    const code=String(e?.Code||e?.name||"");
    const status=Number(e?.$metadata?.httpStatusCode||0);
    if(code==="NoSuchUpload"||code==="InvalidUploadId"||status===404)return res.status(409).json({error:"The cloud multipart session is no longer available.",code:"UPLOAD_SESSION_GONE"});
    console.error("Admin failed-part fallback failed:",e?.stack||e);
    res.status(502).json({error:"Cloud storage rejected the fallback section. Please retry this section."});
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
  const q=await pool.query("SELECT * FROM upload_sessions WHERE id=$1",[req.params.id]);
  if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
  const u=q.rows[0];

  try{
    const fileRow=await finalizeStoredUpload(u);
    return res.json({ok:true,file:fileRow,alreadyCompleted:u.status==="completed"});
  }catch(e){
    if(e&&e.code==="UPLOAD_INCOMPLETE"){
      const state=e.state||{};
      return res.status(409).json({
        error:"Multipart upload is not complete yet.",
        ready:false,
        uploadedBytes:Number(state.uploadedBytes||0),
        totalSize:Number(u.size_bytes||0),
        completedParts:Number(state.completedParts||0),
        totalParts:Number(state.totalParts||0),
        missingParts:Array.isArray(state.missingParts)?state.missingParts:[]
      });
    }
    throw e;
  }
 }catch(e){
  const code=String(e?.code||e?.Code||e?.name||"");
  const status=Number(e?.$metadata?.httpStatusCode||0);
  if(code==="UPLOAD_SESSION_GONE"||code==="NoSuchUpload"||code==="InvalidUploadId"||status===404){
    await pool.query("UPDATE upload_sessions SET status='aborted',updated_at=now() WHERE id=$1",[req.params.id]).catch(function(){});
    return res.status(409).json({error:"The cloud multipart session is no longer available. Reconnecting safely…",code:"UPLOAD_SESSION_GONE"});
  }
  console.error("Admin upload finalization failed:",e);
  res.status(500).json({error:"Upload reached storage but could not be registered in the project. Please resume the upload; it will safely continue from the stored data."});
 }
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

app.post("/api/projects/:id/files",admin,async(req,res)=>{
 try{
  if(!s3Ready())return res.status(503).json({error:"Cloud file storage is not ready yet. Try again in a moment."});
  const projectId=req.params.id;
  const project=await pool.query("SELECT id FROM projects WHERE id=$1 AND archived=false",[projectId]);
  if(!project.rowCount)return res.status(404).json({error:"Project not found"});

  const bb=Busboy({headers:req.headers,limits:{files:100,fileSize:MAX_FILE_SIZE}});
  const jobs=[];
  const cloudKeys=new Set();
  const staged=[];
  let uploadError=null;

  bb.on("field",()=>{});
  bb.on("file",(field,file,info)=>{
    if(field!=="files"){file.resume();return}
    const id=uid();
    const originalName=String(info.filename||"file");
    const storagePath=`projects/${projectId}/${id}/${safeName(originalName)}`;
    cloudKeys.add(storagePath);
    let tooLarge=false;
    file.on("limit",()=>{
      tooLarge=true;
      uploadError=new Error("A file exceeded the supported 5 TB limit.");
    });

    const uploader=new Upload({
      client:s3,
      params:{
        Bucket:bucket(),
        Key:storagePath,
        Body:file,
        ContentType:info.mimeType||"application/octet-stream"
      }
    });

    const job=uploader.done().then(async()=>{
      if(tooLarge)throw new Error("A file exceeded the supported 5 TB limit.");
      const head=await s3.send(new HeadObjectCommand({Bucket:bucket(),Key:storagePath}));
      const size=Number(head.ContentLength||0);
      if(!Number.isFinite(size)||size<0||size>MAX_FILE_SIZE){
        throw new Error("Uploaded file size is outside the supported range.");
      }
      const r=await pool.query(
        "INSERT INTO files(id,project_id,original_name,storage_name,storage_path,mime_type,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [id,projectId,originalName,path.basename(storagePath),storagePath,info.mimeType||"application/octet-stream",size]
      );
      staged.push({id,storagePath});
      return r.rows[0];
    }).catch(e=>{
      uploadError=e;
      throw e;
    });
    jobs.push(job);
  });

  bb.on("finish",async()=>{
    try{
      const results=await Promise.all(jobs);
      await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[projectId]);
      res.json({files:results});
    }catch(e){
      console.error("Legacy project upload failed:",e);
      for(const key of cloudKeys)await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:key})).catch(()=>{});
      const stagedIds=staged.map(x=>x.id).filter(Boolean);
      if(stagedIds.length){
        await pool.query("DELETE FROM files WHERE project_id=$1 AND id=ANY($2::uuid[])",[projectId,stagedIds]).catch(function(dbErr){
          console.error("Could not roll back failed legacy upload records:",dbErr);
        });
      }
      res.status(400).json({error:uploadError?.message||e.message||"Upload failed"});
    }
  });

  bb.on("error",async e=>{
    console.error("Legacy project upload parser failed:",e);
    for(const key of cloudKeys)await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:key})).catch(()=>{});
    if(!res.headersSent)res.status(400).json({error:e.message||"Upload failed"});
  });

  req.pipe(bb);
 }catch(e){
  console.error("Legacy project upload setup failed:",e);
  if(!res.headersSent)res.status(500).json({error:"Could not start upload"});
 }
});
app.delete("/api/files/:id",admin,async(req,res)=>{
 try{
  const r=await pool.query("SELECT * FROM files WHERE id=$1",[req.params.id]);if(!r.rowCount)return res.status(404).json({error:"File not found"});
  const f=r.rows[0];if(s3Ready())await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:f.storage_path}));
  await pool.query("DELETE FROM files WHERE id=$1",[f.id]);await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[f.project_id]);
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Could not delete file"})}
});

async function creativeOwnerForProject(projectId){const r=await pool.query("SELECT owner_id FROM projects WHERE id=$1",[projectId]);return r.rowCount?r.rows[0].owner_id:null;}
async function creativeBrandingForProject(projectId){const ownerId=await creativeOwnerForProject(projectId);return ownerId?loadCreativeSettings(ownerId):{...DEFAULT_CREATIVE_SETTINGS};}
async function bodyToBuffer(body){if(!body)return Buffer.alloc(0);if(typeof body.transformToByteArray==="function")return Buffer.from(await body.transformToByteArray());return Buffer.from(await new Promise((resolve,reject)=>{const chunks=[];body.on("data",c=>chunks.push(c));body.on("end",()=>resolve(Buffer.concat(chunks)));body.on("error",reject)}));}
function escapeSvgText(v){return String(v||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");}
async function applyCreativeWatermark(input,settings){
  if(!settings||!settings.watermark_enabled)return {buffer:input,applied:false};
  const base=await sharp(input).rotate().png().toBuffer();const meta=await sharp(base).metadata(),W=Number(meta.width||1600),H=Number(meta.height||1000);
  const type=String(settings.watermark_type||"logo"),opacity=Math.max(.05,Math.min(1,Number(settings.watermark_opacity)||.32)),scale=Math.max(8,Math.min(45,Number(settings.watermark_size)||22)),pos=String(settings.watermark_position||"bottom-right");
  const layers=[];const text=String(settings.watermark_text||settings.business_name||"").trim().slice(0,100);
  if(text&&(type==="text"||type==="both")){const fs=Math.max(24,Math.round(W*(scale/100)*.18));layers.push(Buffer.from('<svg width="'+W+'" height="'+H+'" xmlns="http://www.w3.org/2000/svg"><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="Arial,Helvetica,sans-serif" font-size="'+fs+'" font-weight="700" fill="#fff" fill-opacity="'+opacity+'">'+escapeSvgText(text)+'</text></svg>'));}
  if(settings.logo_key&&(type==="logo"||type==="both")&&s3Ready()){try{const obj=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:settings.logo_key}));const bytes=await bodyToBuffer(obj.Body);layers.push(await sharp(bytes).resize({width:Math.max(120,Math.round(W*(scale/100))),height:Math.round(H*.65),fit:"inside",withoutEnlargement:true}).png().toBuffer())}catch(e){console.warn("Creative watermark logo unavailable:",e?.message||e)}}
  if(!layers.length)return {buffer:input,applied:false};
  const lastMeta=await sharp(layers[layers.length-1]).metadata(),lw=Number(lastMeta.width||0),lh=Number(lastMeta.height||0);let left=Math.round(W*.06),top=Math.round(H*.06);
  if(pos==="top-right"||pos==="bottom-right")left=Math.max(0,W-lw-Math.round(W*.06));
  if(pos==="bottom-left"||pos==="bottom-right")top=Math.max(0,H-lh-Math.round(H*.06));
  if(pos==="center"){left=Math.max(0,Math.round((W-lw)/2));top=Math.max(0,Math.round((H-lh)/2))}
  return {buffer:await sharp(base).composite(layers.map(x=>({input:x,left,top}))).toBuffer(),applied:true};
}

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


function isTransportStreamVideo(file){
  const name=String(file?.original_name||"").toLowerCase();
  const mime=String(file?.mime_type||"").toLowerCase();
  return /\.ts$/.test(name)||mime==="video/mp2t"||mime==="video/mpeg"||mime==="video/mpegts";
}

async function streamTsVideo(req,res,f){
  if(!ffmpegPath)throw new Error("FFmpeg is not available for MPEG-TS playback.");
  const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:f.storage_path}),{expiresIn:3600});
  res.set("X-Content-Type-Options","nosniff");
  res.set("Content-Type","video/mp4");
  res.set("Cache-Control","private, no-store");
  res.set("Content-Disposition","inline; filename*=UTF-8''"+encodeURIComponent(String(f.original_name||"video").replace(/\.ts$/i,".mp4")));
  // The MP4 is generated as a fragmented stream, so its final length is not
  // known up front. Browsers can start playback while FFmpeg is still reading
  // the source object. Seeking is handled by restarting from the source until
  // we have a persistent converted derivative.
  const args=[
    "-hide_banner","-loglevel","error",
    "-i",url,
    "-map","0:v:0?","-map","0:a:0?",
    "-c","copy",
    "-movflags","+frag_keyframe+empty_moov+default_base_moof",
    "-f","mp4","pipe:1"
  ];
  const child=spawn(ffmpegPath,args,{stdio:["ignore","pipe","pipe"]});
  let stderr="",finished=false;
  const stop=()=>{
    if(finished)return;
    try{child.kill("SIGKILL")}catch{}
  };
  req.on("aborted",stop);
  res.on("close",stop);
  child.stderr.on("data",c=>{stderr=(stderr+String(c||"")).slice(-12000)});
  child.on("error",e=>{
    finished=true;
    console.error("MPEG-TS playback process failed:",e?.stack||e);
    if(!res.headersSent)res.status(502).send("Unable to prepare this MPEG-TS video for browser playback.");
    else res.end();
  });
  child.stdout.pipe(res);
  child.on("close",(code,signal)=>{
    finished=true;
    if(code!==0 && !res.writableEnded){
      console.error("MPEG-TS playback FFmpeg exited:",code,signal,stderr);
      try{res.end()}catch{}
    }
  });
}

async function streamStoredObject(req,res,f){
  if(isTransportStreamVideo(f) && String(req.query.download||"")!=="1"){
    return streamTsVideo(req,res,f);
  }
  const head=await headObjectWithRetry({Bucket:bucket(),Key:f.storage_path},4,300);
  const size=Number(head.ContentLength||f.size_bytes||0);
  if(!Number.isFinite(size)||size<0)throw new Error("Stored object size is unavailable.");
  const contentType=String(head.ContentType||f.mime_type||"application/octet-stream");
  res.set("Accept-Ranges","bytes");
  res.set("X-Content-Type-Options","nosniff");
  res.set("Content-Type",contentType);
  res.set("Cache-Control","private, max-age=0, must-revalidate");
  res.set("Content-Disposition",(String(req.query.download||"") === "1" ? "attachment" : "inline")+"; filename*=UTF-8''"+encodeURIComponent(f.original_name||"file"));
  if(req.method==="HEAD"){
    res.set("Content-Length",String(size));
    return res.status(200).end();
  }
  const range=String(req.headers.range||"").trim();
  if(!range){
    res.set("Content-Length",String(size));
    const obj=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:f.storage_path}));
    if(obj.Body?.pipe)obj.Body.pipe(res);
    else for await(const chunk of obj.Body){if(!res.write(chunk))await new Promise(r=>res.once("drain",r))}
    return;
  }
  const m=/^bytes=(\d*)-(\d*)$/i.exec(range);
  if(!m)return res.status(416).set("Content-Range","bytes */"+size).end();
  let start=m[1]===""?Math.max(0,size-Number(m[2]||"0")):Number(m[1]);
  let end=m[2]===""?size-1:Number(m[2]);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||start>=size)return res.status(416).set("Content-Range","bytes */"+size).end();
  end=Math.min(end,size-1);
  const length=end-start+1;
  const obj=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:f.storage_path,Range:"bytes="+start+"-"+end}));
  res.status(206);
  res.set("Content-Range","bytes "+start+"-"+end+"/"+size);
  res.set("Content-Length",String(length));
  if(obj.Body?.pipe)obj.Body.pipe(res);
  else for await(const chunk of obj.Body){if(!res.write(chunk))await new Promise(r=>res.once("drain",r))}
}
async function publicFileRecord(fileId,tokenValue,req){
  const q=await pool.query("SELECT f.*,p.shared,p.share_token,p.expires_at FROM files f JOIN projects p ON p.id=f.project_id WHERE f.id=$1",[fileId]);
  if(!q.rowCount)return null;
  const f=q.rows[0];
  if(f.share_token!==tokenValue||!f.shared||(f.expires_at&&new Date(f.expires_at).getTime()<Date.now()))return null;
  if(!validShareSession(req,tokenValue))return null;
  return f;
}

app.get("/api/admin/preview/:id",admin,async(req,res)=>{
 try{
  const q=await pool.query("SELECT * FROM files WHERE id=$1",[req.params.id]);
  if(!q.rowCount)return res.status(404).send("File not found");
  const f=q.rows[0];
  if(!/^image\//i.test(f.mime_type||"")&&!isRawPhoto(f))return res.status(415).send("Image preview only.");
  const key=previewObjectKey(f,2000,2000);
  if(await storedObjectExists(key))return redirectToBucket(res,key,"private, no-store");
  const creative=await creativeBrandingForProject(f.project_id);
  const webp=await buildPreviewImage(f,2000,2000,creative);
  await persistDerivedImage(key,webp,f.id);
  res.status(200).type("image/webp").set("Cache-Control","private, no-store").send(webp);
 }catch(e){console.error("Admin preview failed",e?.stack||e);res.status(500).send("Unable to generate preview")}
});
app.get("/api/admin/media/:id",admin,async(req,res)=>{
  try{
    const q=await pool.query("SELECT * FROM files WHERE id=$1",[req.params.id]);
    if(!q.rowCount)return res.status(404).send("File not found");
    if(!isTransportStreamVideo(q.rows[0])&&s3Ready())return redirectToBucket(res,q.rows[0].storage_path,"private, no-store");
    await streamStoredObject(req,res,q.rows[0]);
  }catch(e){console.error("Admin media stream failed:",e?.stack||e);res.status(500).send("Unable to stream file")}
});
app.head("/api/admin/media/:id",admin,async(req,res)=>{
  try{
    const q=await pool.query("SELECT * FROM files WHERE id=$1",[req.params.id]);
    if(!q.rowCount)return res.status(404).end();
    await streamStoredObject(req,res,q.rows[0]);
  }catch(e){console.error("Admin media HEAD failed:",e?.stack||e);res.status(500).end()}
});
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
  const kind=thumbKind(f),cacheKind=kind==="video"?"video-v3":kind;
  const cacheKey="admin:"+f.id+":"+cacheKind+":"+width+"x"+height;
  const thumbKey="__admin-thumbnails/"+crypto.createHash("sha1").update(String(f.id)+"|"+cacheKind+"|"+width+"|"+height).digest("hex")+".webp";
  if(s3Ready()&&await storedObjectExists(thumbKey))return redirectToBucket(res,thumbKey,"private, no-store");
  const cached=getThumbCache(cacheKey);
  if(cached)return res.status(200).type("image/webp").set("Cache-Control","private, no-store").set("X-Content-Type-Options","nosniff").send(cached.buffer);
  const webp=await generateThumbnail(f,width,height);
  setThumbCache(cacheKey,webp);
  try{
    await s3.send(new PutObjectCommand({Bucket:bucket(),Key:thumbKey,Body:webp,ContentType:"image/webp",CacheControl:"private, max-age=31536000, immutable",Metadata:{source_file_id:String(f.id),generated_by:"fbi-client-file-studio-admin-media-aware"}}));
    return redirectToBucket(res,thumbKey,"private, no-store");
  }catch(err){
    console.warn("Admin thumbnail bucket write failed; serving the generated preview once:",err?.message||err);
    return res.status(200).type("image/webp").set("Cache-Control","private, no-store").set("X-Content-Type-Options","nosniff").send(webp);
  }
 }catch(e){console.error("Admin thumbnail generation failed",e?.stack||e);res.status(500).send("Unable to generate thumbnail");}
});
app.post("/api/public/share/:token/access",galleryAccessRateLimit,async(req,res)=>{
 try{
  const email=String(req.body?.email||"").trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:"Enter a valid email address."});
  const q=await pool.query("SELECT id,client_email,expires_at,shared FROM projects WHERE share_token=$1",[req.params.token]);
  if(!q.rowCount||!q.rows[0].shared)return res.status(404).json({error:"This delivery link is invalid or disabled."});
  const p=q.rows[0];
  if(p.expires_at&&new Date(p.expires_at).getTime()<Date.now())return res.status(404).json({error:"This delivery link has expired."});
  // The bearer share link grants access. The email entered here is attached to
  // this visitor's signed session and later selections only; it is unverified and
  // must not overwrite the owner's saved client contact email.
  res.setHeader("Set-Cookie","fbi_share_session="+encodeURIComponent(shareSession(req.params.token,email))+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000");
  res.json({ok:true,email});
 }catch(e){console.error("Client email access failed:",e);res.status(500).json({error:"Could not authorize gallery access."})}
});

app.post("/api/public/share/:token/selections",async(req,res)=>{
 try{
  const q=await pool.query("SELECT id,expires_at FROM projects WHERE share_token=$1 AND shared=true",[req.params.token]);
  if(!q.rowCount)return res.status(404).json({error:"This delivery link is invalid or disabled."});
  const p=q.rows[0];if(p.expires_at&&new Date(p.expires_at).getTime()<Date.now())return res.status(404).json({error:"This delivery link has expired."});
  const session=validShareSession(req,req.params.token);
  if(!session)return res.status(401).json({error:"Client email required.",code:"CLIENT_EMAIL_REQUIRED"});
  const wanted=Array.isArray(req.body?.file_ids)?[...new Set(req.body.file_ids.map(String))].slice(0,5000):[];
  if(!wanted.length)return res.status(400).json({error:"Choose at least one favorite first."});
  const valid=await pool.query("SELECT id FROM files WHERE project_id=$1 AND id::text = ANY($2::text[])",[p.id,wanted]);
  const ids=valid.rows.map(r=>String(r.id));
  if(!ids.length)return res.status(400).json({error:"Those files are not part of this gallery."});
  const name=String(req.body?.name||"").trim().slice(0,160),note=String(req.body?.note||"").trim().slice(0,2000);
  const email=String(session.email||req.body?.email||"").trim().slice(0,200);
  await pool.query("INSERT INTO client_selections(id,project_id,client_name,client_email,note,file_ids) VALUES($1,$2,$3,$4,$5,$6::jsonb)",[uid(),p.id,name,email,note,JSON.stringify(ids)]);
  res.json({ok:true,count:ids.length});
 }catch(e){console.error("Client selection failed",e);res.status(500).json({error:"Could not send your picks. Please try again."})}
});
app.get("/api/public/share/:token",async(req,res)=>{
 try{
  const q=await pool.query("SELECT id,name,client_name,client_email,note,expires_at FROM projects WHERE share_token=$1 AND shared=true",[req.params.token]);
  if(!q.rowCount)return res.status(404).json({error:"This delivery link is invalid, disabled, or expired."});
  const p=q.rows[0];if(p.expires_at&&new Date(p.expires_at).getTime()<Date.now())return res.status(404).json({error:"This delivery link has expired."});
  if(!validShareSession(req,req.params.token))return res.status(401).json({error:"Client email required.",code:"CLIENT_EMAIL_REQUIRED"});
  const f=await pool.query("SELECT id,original_name,relative_path,mime_type,size_bytes,created_at FROM files WHERE project_id=$1 ORDER BY relative_path ASC,created_at DESC",[p.id]);
  const base=`${req.protocol}://${req.get("host")}`;
  const settings=await loadSettings();
  const creative=await creativeBrandingForProject(p.id);
  res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma","no-cache");
  res.set("Expires","0");
  res.json({project:p,settings:{portal_title:creative.portal_title||settings.portal_title,allow_client_preview:creative.preferences?.allow_client_preview!==false,show_file_size:creative.preferences?.show_file_size!==false,business_name:creative.business_name,accent_color:creative.accent_color,branding_logo_url:creative.logo_key?"/api/public/share/"+encodeURIComponent(req.params.token)+"/branding/logo":"",watermark_enabled:creative.watermark_enabled},files:f.rows.map(x=>({...x,download_url:`${base}/api/public/file/${x.id}?token=${encodeURIComponent(req.params.token)}`}))});
 }catch(e){console.error(e);res.status(500).json({error:"Could not load delivery"})}
});


async function renderVideoPreviewClip(file,startSeconds=4,durationSeconds=8){
  if(!ffmpegPath)throw new Error("FFmpeg is not available for video gallery previews.");
  const safeStart=Math.max(0,Number(startSeconds)||0);
  const safeDuration=Math.max(3,Math.min(12,Number(durationSeconds)||8));
  const cacheKey="__video-previews/"+crypto.createHash("sha1").update(String(file.id)+"|"+safeStart+"|"+safeDuration+"|v1").digest("hex")+".mp4";
  try{
    const head=await s3.send(new HeadObjectCommand({Bucket:bucket(),Key:cacheKey}));
    if(Number(head.ContentLength||0)>0){
      const got=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:cacheKey}));
      const bytes=got.Body?.transformToByteArray
        ?Buffer.from(await got.Body.transformToByteArray())
        :Buffer.from(await new Promise((resolve,reject)=>{const chunks=[];got.Body.on("data",c=>chunks.push(c));got.Body.on("end",()=>resolve(Buffer.concat(chunks)));got.Body.on("error",reject)}));
      return {bytes,cacheKey};
    }
  }catch(_e){}

  const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:file.storage_path}),{expiresIn:600});
  const dir=await fsp.mkdtemp(path.join("/tmp","fbi-video-preview-"));
  const outFile=path.join(dir,"preview.mp4");

  async function runPreview(startAt){
    const args=[
      "-hide_banner","-loglevel","error",
      "-ss",String(startAt),"-i",url,
      "-t",String(safeDuration),
      "-map","0:v:0?",
      "-c:v","libx264","-preset","veryfast","-crf","29","-pix_fmt","yuv420p",
      "-vf","scale=w=720:h=-2:force_original_aspect_ratio=decrease",
      "-an",
      "-movflags","+faststart",
      "-f","mp4",outFile
    ];
    return new Promise((resolve,reject)=>{
      const child=spawn(ffmpegPath,args,{stdio:["ignore","ignore","pipe"]});
      let stderr="";
      const timer=setTimeout(()=>{try{child.kill("SIGKILL")}catch{};reject(new Error("Video preview generation timed out."))},35000);
      child.stderr.on("data",c=>{stderr=(stderr+String(c||"")).slice(-12000)});
      child.on("error",e=>{clearTimeout(timer);reject(e)});
      child.on("close",code=>{
        clearTimeout(timer);
        if(code===0)return resolve();
        reject(new Error(stderr.trim()||("FFmpeg exited with code "+String(code))));
      });
    });
  }

  try{
    try{await runPreview(safeStart)}catch(_firstErr){
      await fsp.rm(outFile,{force:true}).catch(()=>{});
      await runPreview(0);
    }
    const stat=await fsp.stat(outFile);
    if(!stat.size)throw new Error("FFmpeg produced an empty video preview.");
    const bytes=await fsp.readFile(outFile);
    await s3.send(new PutObjectCommand({
      Bucket:bucket(),Key:cacheKey,Body:bytes,ContentType:"video/mp4",
      CacheControl:"private, max-age=604800",
      Metadata:{source_file_id:String(file.id),generated_by:"fbi-client-file-studio-video-highlight-v1"}
    })).catch(e=>console.warn("Could not persist video highlight preview:",e?.message||e));
    return {bytes,cacheKey};
  }finally{
    await fsp.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}

app.get("/api/public/share/:token/branding/logo",async(req,res)=>{
  try{
    const q=await pool.query("SELECT owner_id,shared,expires_at FROM projects WHERE share_token=$1 LIMIT 1",[req.params.token]);
    if(!q.rowCount||!q.rows[0].shared||(q.rows[0].expires_at&&new Date(q.rows[0].expires_at).getTime()<Date.now())||!validShareSession(req,req.params.token))return res.status(404).end();
    const settings=await loadCreativeSettings(q.rows[0].owner_id);if(!settings.logo_key||!s3Ready())return res.status(404).end();
    const got=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:settings.logo_key}));res.type("png").set("Cache-Control","private, max-age=3600");if(got.Body?.pipe)return got.Body.pipe(res);res.end(Buffer.from(await got.Body.transformToByteArray()));
  }catch(e){console.error("Public branding logo failed:",e);res.status(404).end()}
});

app.get("/api/public/video-preview/:id",async(req,res)=>{
  try{
    const out=await signedFileUrl(req.params.id,String(req.query.token||""));
    if(!out)return res.status(404).send("Invalid or expired delivery link.");
    if(!/^video\//i.test(out.f.mime_type||"") && !isTransportStreamVideo(out.f)){
      return res.status(415).send("Video preview only.");
    }
    const start=Math.max(0,Number(req.query.start||4));
    const duration=Math.max(3,Math.min(12,Number(req.query.duration||8)));
    const preview=await renderVideoPreviewClip(out.f,start,duration);
    res.status(200)
      .type("video/mp4")
      .set("Accept-Ranges","bytes")
      .set("Content-Length",String(preview.bytes.length))
      .set("Cache-Control","private, max-age=604800")
      .set("X-Content-Type-Options","nosniff")
      .set("X-FBI-Video-Preview","highlight-loop")
      .send(preview.bytes);
  }catch(e){
    console.error("Public video highlight preview failed:",e?.stack||e);
    res.status(500).send("Unable to generate video highlight preview.");
  }
});
// ---- Serving media from the bucket instead of through this server ----
// On Railway, bucket egress (including presigned URLs) is free while service
// egress is billed. Wherever a stored object can be handed to the browser
// as-is, redirect to a presigned bucket URL instead of piping the bytes.
const PRESIGN_WINDOW_MS=6*3600*1000;
async function presignedGet(key){
  // Signing inside fixed 6-hour windows keeps the URL identical for a while,
  // so browsers can cache the bucket response between page views.
  const signingDate=new Date(Math.floor(Date.now()/PRESIGN_WINDOW_MS)*PRESIGN_WINDOW_MS);
  return getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:key}),{expiresIn:12*3600,signingDate});
}
async function storedObjectExists(key){
  try{const h=await s3.send(new HeadObjectCommand({Bucket:bucket(),Key:key}));return Number(h.ContentLength||0)>0}catch(_e){return false}
}
async function redirectToBucket(res,key,cacheControl="private, max-age=3600"){
  const url=await presignedGet(key);
  // Public media redirects may be cached briefly. Authenticated media passes
  // "private, no-store" so a different signed-in user cannot reuse a cached redirect.
  res.set("Cache-Control",cacheControl);
  return res.redirect(302,url);
}
function thumbObjectKey(f,width,height){
  const kind=thumbKind(f),cacheKind=kind==="video"?"video-v3":kind==="raw"?"raw-v1":kind;
  return "__thumbnails/"+crypto.createHash("sha1").update(String(f.id)+"|"+cacheKind+"|"+width+"|"+height+"|natural").digest("hex")+".webp";
}
function previewObjectKey(f,width,height){
  return "__previews/"+crypto.createHash("sha1").update(String(f.id)+"|"+width+"|"+height).digest("hex")+".webp";
}
async function persistDerivedImage(key,buf,fileId){
  try{
    await s3.send(new PutObjectCommand({Bucket:bucket(),Key:key,Body:buf,ContentType:"image/webp",CacheControl:"private, max-age=31536000, immutable",Metadata:{source_file_id:String(fileId),generated_by:"fbi-client-file-studio"}}));
    return true;
  }catch(err){console.warn("Could not persist derived image",err?.message||err);return false}
}
async function buildThumbImage(f,width,height,creative){
  let webp=await generateThumbnail(f,width,height);
  if(/^image\/(jpeg|png|webp)$/i.test(f.mime_type||"")&&creative.watermark_enabled){const wm=await applyCreativeWatermark(webp,creative);webp=wm.buffer;}
  return webp;
}
async function buildPreviewImage(f,width,height,creative){
  let webp;
  if(isRawPhoto(f)){
    webp=await generateRawPreview(f,width,height);
  }else if(thumbKind(f)==="image"){
    try{
      const obj=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:f.storage_path}));
      const input=await bodyToBuffer(obj.Body);
      webp=await sharp(input).rotate().resize({width,height,fit:"inside",withoutEnlargement:true}).webp({quality:84,method:4}).toBuffer();
    }catch(e){
      console.warn("Preview could not be decoded; using file card:",f?.original_name,e?.message||e);
      webp=await generateThumbnail(f,width,height);
    }
  }else{
    // design / document / audio / video → branded card or media sheet (never a 500)
    webp=await generateThumbnail(f,width,height);
  }
  if(!isRawPhoto(f)&&/^image\/(jpeg|png|webp)$/i.test(f.mime_type||"")&&creative.watermark_enabled){const wm=await applyCreativeWatermark(webp,creative);webp=wm.buffer;}
  return webp;
}
function clampThumbSize(q){
  return {width:Math.max(240,Math.min(720,Number(q.w||420))),height:Math.max(160,Math.min(720,Number(q.h||540)))};
}
function clampPreviewSize(q){
  const wv=Number(Array.isArray(q.w)?q.w[0]:(q.w||1400)),hv=Number(Array.isArray(q.h)?q.h[0]:(q.h||1000));
  return {width:Number.isFinite(wv)?Math.max(600,Math.min(2400,wv)):1400,height:Number.isFinite(hv)?Math.max(400,Math.min(2400,hv)):1000};
}
// The sizes the client gallery asks for most; pre-built right after upload.
const WARM_THUMB={width:720,height:720},WARM_PREVIEW={width:2000,height:2000};
const warmQueue=[];let warmRunning=false;
function warmMediaCache(f){
  try{
    if(!f||!s3Ready())return;
    if(!/^image\//i.test(f.mime_type||"")&&!isRawPhoto(f))return;
    warmQueue.push(f);
    if(!warmRunning)runWarmQueue();
  }catch(_e){}
}
async function runWarmQueue(){
  warmRunning=true;
  while(warmQueue.length){
    const f=warmQueue.shift();
    try{
      const creative=await creativeBrandingForProject(f.project_id);
      const tk=thumbObjectKey(f,WARM_THUMB.width,WARM_THUMB.height);
      if(!(await storedObjectExists(tk)))await persistDerivedImage(tk,await buildThumbImage(f,WARM_THUMB.width,WARM_THUMB.height,creative),f.id);
      const pk=previewObjectKey(f,WARM_PREVIEW.width,WARM_PREVIEW.height);
      if(!(await storedObjectExists(pk)))await persistDerivedImage(pk,await buildPreviewImage(f,WARM_PREVIEW.width,WARM_PREVIEW.height,creative),f.id);
    }catch(err){console.warn("Preview warm-up skipped for",f&&f.id,err?.message||err)}
    // Keep the server responsive for uploads and visitors.
    await new Promise(r=>setTimeout(r,150));
  }
  warmRunning=false;
}
app.get("/api/public/thumb/:id",async(req,res)=>{
 try{
  const out=await signedFileUrl(req.params.id,String(req.query.token||""));
  if(!out)return res.status(404).send("Invalid or expired delivery link.");
  const {width,height}=clampThumbSize(req.query);
  const key=thumbObjectKey(out.f,width,height);
  if(await storedObjectExists(key))return redirectToBucket(res,key);
  const creative=await creativeBrandingForProject(out.f.project_id);
  const webp=await buildThumbImage(out.f,width,height,creative);
  await persistDerivedImage(key,webp,out.f.id);
  res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").set("X-Content-Type-Options","nosniff").send(webp);
 }catch(e){console.error("Thumbnail generation failed",e?.stack||e);res.status(500).send("Unable to generate thumbnail");}
});
app.get("/api/public/preview/:id",async(req,res)=>{
 try{
  const out=await signedFileUrl(req.params.id,String(req.query.token||""));
  if(!out)return res.status(404).send("Invalid or expired delivery link.");
  if(!/^image\//i.test(out.f.mime_type||"")&&!isRawPhoto(out.f))return res.status(415).send("Image preview only.");
  const {width,height}=clampPreviewSize(req.query);
  const key=previewObjectKey(out.f,width,height);
  if(await storedObjectExists(key))return redirectToBucket(res,key);
  const creative=await creativeBrandingForProject(out.f.project_id);
  const webp=await buildPreviewImage(out.f,width,height,creative);
  await persistDerivedImage(key,webp,out.f.id);
  res.status(200).type("image/webp").set("Cache-Control","private, max-age=3600, stale-while-revalidate=86400").send(webp);
 }catch(e){
  console.error("Image preview generation failed",e?.stack||e);
  res.status(500).send("Unable to generate preview");
 }
});

app.get("/api/public/media/:id",async(req,res)=>{
  try{
    const f=await publicFileRecord(req.params.id,String(req.query.token||""),req);
    if(!f)return res.status(404).send("Invalid or expired delivery link.");
    // Videos/audio play straight from the bucket (free egress); the player
    // sends its range requests there too. .ts files still need remuxing here.
    if(!isTransportStreamVideo(f)&&s3Ready())return redirectToBucket(res,f.storage_path);
    await streamStoredObject(req,res,f);
  }catch(e){console.error("Public media stream failed:",e?.stack||e);res.status(500).send("Unable to stream file")}
});
app.head("/api/public/media/:id",async(req,res)=>{
  try{
    const f=await publicFileRecord(req.params.id,String(req.query.token||""));
    if(!f)return res.status(404).end();
    await streamStoredObject(req,res,f);
  }catch(e){console.error("Public media HEAD failed:",e?.stack||e);res.status(500).end()}
});
async function logPublicDownload(req,f,tokenValue,settings){
  try{
    settings=settings||await loadSettings();
    if(!settingBool(settings.log_downloads))return;
    const share=validShareSession(req,tokenValue);
    await pool.query("INSERT INTO downloads(project_id,file_id,user_agent,ip_address,client_email) VALUES($1,$2,$3,$4,$5)",[f.project_id,f.id,String(req.headers["user-agent"]||"").slice(0,1000),clientIp(req),String(share?.email||"")]);
  }catch(e){console.warn("Download log failed",e?.message||e)}
}
// Describe how the browser should fetch a file for download. Normally a
// presigned bucket URL (free egress); the server route is only used when the
// file must be changed on the way out (watermark on download).
async function publicDownloadInfo(req,f,tokenValue,settings){
  const creative=await creativeBrandingForProject(f.project_id);
  const mustProxy=/^image\/(jpeg|png|webp)$/i.test(f.mime_type||"")&&creative.watermark_enabled&&creative.watermark_on_download;
  await logPublicDownload(req,f,tokenValue,settings);
  const server="/api/public/file/"+encodeURIComponent(f.id)+"?token="+encodeURIComponent(tokenValue)+"&download=1&logged=1";
  const url=mustProxy?null:await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:f.storage_path}),{expiresIn:3*3600});
  return {id:f.id,name:f.original_name||"file",size:Number(f.size_bytes||0),type:f.mime_type||"application/octet-stream",url,server};
}
app.get("/api/public/file/:id/link",async(req,res)=>{
 try{
  const tokenValue=String(req.query.token||"");
  const out=await signedFileUrl(req.params.id,tokenValue);if(!out)return res.status(404).json({error:"Invalid or expired delivery link."});
  res.set("Cache-Control","no-store").json(await publicDownloadInfo(req,out.f,tokenValue));
 }catch(e){console.error(e);res.status(500).json({error:"Unable to prepare download"})}
});
app.post("/api/public/share/:token/links",async(req,res)=>{
 try{
  const tokenValue=String(req.params.token||"");
  const ids=Array.isArray(req.body?.ids)?req.body.ids.map(String).slice(0,5000):[];
  const settings=await loadSettings();
  const items=[];
  for(const id of ids){const out=await signedFileUrl(id,tokenValue);if(out)items.push(await publicDownloadInfo(req,out.f,tokenValue,settings))}
  res.set("Cache-Control","no-store").json({items});
 }catch(e){console.error(e);res.status(500).json({error:"Unable to prepare downloads"})}
});
app.get("/api/public/file/:id",async(req,res)=>{
 try{
  const out=await signedFileUrl(req.params.id,String(req.query.token||""));if(!out)return res.status(404).send("Invalid or expired delivery link.");
  const settings=await loadSettings();
  const creative=await creativeBrandingForProject(out.f.project_id);
  if(req.query.logged!=="1")await logPublicDownload(req,out.f,String(req.query.token||""),settings);
  if(/^image\/(jpeg|png|webp)$/i.test(out.f.mime_type||"")&&creative.watermark_enabled&&creative.watermark_on_download){
    const obj=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:out.f.storage_path}));const input=await bodyToBuffer(obj.Body);const wm=await applyCreativeWatermark(input,creative);
    if(wm.applied){let bytes=wm.buffer;const ct=/png/i.test(out.f.mime_type)?"image/png":/webp/i.test(out.f.mime_type)?"image/webp":"image/jpeg";if(ct==="image/jpeg")bytes=await sharp(bytes).jpeg({quality:92}).toBuffer();else if(ct==="image/png")bytes=await sharp(bytes).png().toBuffer();else bytes=await sharp(bytes).webp({quality:92}).toBuffer();return res.status(200).set("Content-Type",ct).set("Content-Disposition",(req.query.download==="1"?"attachment":"inline")+"; filename*=UTF-8''"+encodeURIComponent(out.f.original_name)).set("Cache-Control","private, no-store").send(bytes);}
  }
  if(req.query.download==="1"){
    // Stream the file through this server with "attachment" so the browser
    // always saves it. Redirecting to the storage provider relied on it
    // honouring response-content-disposition, which it does not, so the
    // photo just opened full size instead of downloading.
    return streamStoredObject(req,res,out.f);
  }
  const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:out.f.storage_path}),{expiresIn:900,responseContentDisposition:req.query.download==="1"?`attachment; filename*=UTF-8''${encodeURIComponent(out.f.original_name)}`:`inline; filename*=UTF-8''${encodeURIComponent(out.f.original_name)}`});
  res.redirect(url);
 }catch(e){console.error(e);res.status(500).send("Unable to serve file")}
});

app.get("/share/:token",(req,res)=>{
  res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma","no-cache");
  res.set("Expires","0");
  res.type("html").sendFile(path.join(ROOT,"index.html"));
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

app.get("/live-studio-addon.js",(req,res)=>{res.type("application/javascript").set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");res.set("Pragma","no-cache");res.set("Expires","0");res.sendFile(path.join(ROOT,"live-studio-addon.js"));});
app.get("/portal-manifest.webmanifest",(req,res)=>{
  res.type("application/manifest+json").set("Cache-Control","no-cache, no-store, must-revalidate").sendFile(path.join(ROOT,"portal-manifest.webmanifest"));
});
app.get("/portal-pwa-icon-maskable-512.png",async(req,res)=>{
  try{
    // Maskable icon: the official logo inside a generous safe zone so Android's
    // adaptive-icon mask never clips the artwork.
    const logo=await sharp(path.join(ROOT,"official-logo.png")).resize({width:300,height:300,fit:"contain",background:{r:17,g:17,b:19,alpha:1}}).png().toBuffer();
    const buffer=await sharp({create:{width:512,height:512,channels:4,background:{r:17,g:17,b:19,alpha:1}}}).composite([{input:logo,gravity:"center"}]).png().toBuffer();
    res.type("image/png").set("Cache-Control","public, max-age=31536000, immutable").send(buffer);
  }catch(err){console.error("Portal maskable icon generation failed:",err);res.sendStatus(500);}
});
app.get("/portal-pwa-icon-:size.png",async(req,res)=>{
  const size=Number(req.params.size);
  if(size!==192&&size!==512)return res.sendStatus(404);
  try{
    // Use the official FBI logo artwork unchanged; only fit it inside the
    // square install-icon canvas required by major PWA platforms.
    const buffer=await sharp(path.join(ROOT,"official-logo.png"))
      .resize({width:size,height:size,fit:"contain",background:{r:9,g:9,b:10,alpha:1}})
      .png()
      .toBuffer();
    res.type("image/png").set("Cache-Control","public, max-age=31536000, immutable").send(buffer);
  }catch(err){
    console.error("Portal PWA icon generation failed:",err);
    res.sendStatus(500);
  }
});
app.get("/portal-sw.js",(req,res)=>{
  res.type("application/javascript").set("Cache-Control","no-cache, no-store, must-revalidate").sendFile(path.join(ROOT,"portal-sw.js"));
});
app.get("/manifest.webmanifest",(req,res)=>{
  const isLiveStandalone=process.env.FBI_LIVE_STANDALONE==="1"||/^live\.fbigh\.com$/i.test(String(req.hostname||""));
  const file=isLiveStandalone?"live-manifest.webmanifest":"manifest.webmanifest";
  res.type("application/manifest+json").set("Cache-Control","no-cache, no-store, must-revalidate").sendFile(path.join(ROOT,file));
});
app.get("/live-pwa-icon-:size.png",async(req,res)=>{
  const size=Number(req.params.size);
  if(size!==192&&size!==512)return res.sendStatus(404);
  try{
    const buffer=await sharp(path.join(ROOT,"official-logo.png"))
      .resize({width:size,height:size,fit:"contain",background:{r:9,g:9,b:10,alpha:1}})
      .png()
      .toBuffer();
    res.type("image/png").set("Cache-Control","public, max-age=31536000, immutable").send(buffer);
  }catch(err){
    console.error("Live PWA icon generation failed:",err);
    res.sendStatus(500);
  }
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
  const isLiveStandalone=process.env.FBI_LIVE_STANDALONE==="1"||/^live\.fbigh\.com$/i.test(String(req.hostname||""));
  const file=isLiveStandalone?"live-sw.js":"sw.js";
  res.type("application/javascript").set("Cache-Control","no-cache, no-store, must-revalidate").sendFile(path.join(ROOT,file));
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
  // /live is the dedicated standalone FBI Live Control Center. It must never
  // fall back to the main File Studio page, regardless of environment flags.
  res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma","no-cache");
  res.set("Expires","0");
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