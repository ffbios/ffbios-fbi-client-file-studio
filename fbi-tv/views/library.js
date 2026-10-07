const { page, topbar } = require("./shared");

const CSS = `
h1{font-size:clamp(26px,4vw,40px);margin:6px 0 4px;font-weight:850;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:14px;margin-bottom:22px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.card{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;transition:.15s}
.card:hover{border-color:#3a4150;transform:translateY(-2px)}
.thumb{position:relative;aspect-ratio:16/9;display:grid;place-items:center;background:radial-gradient(circle at 50% 30%,#1d212a,#07080a);color:#475060;font-size:34px}
.thumb .badge{position:absolute;left:12px;top:12px}
.info{padding:14px 16px 16px;display:grid;gap:6px}
.info b{font-size:16px;line-height:1.25}
.info span{color:var(--muted);font-size:12px}
.row{display:flex;gap:8px;margin-top:8px}
.row .chip{flex:1;justify-content:center}
.empty{text-align:center;padding:70px 20px;border:1px dashed var(--line);border-radius:var(--radius);color:var(--muted)}
.empty b{display:block;color:var(--text);font-size:18px;margin-bottom:6px}
`;

function libraryPage() {
  const body = `${topbar("library")}
<main class="wrap">
  <div class="eyebrow" style="color:var(--gold);font-size:11px;font-weight:900;letter-spacing:.18em">FBI TV</div>
  <h1>My Saved</h1>
  <div class="sub">Broadcasts you saved to watch later. Saved on this device and browser.</div>
  <div class="grid" id="grid"></div>
  <div class="foot">FBI TV</div>
</main>`;
  const script = `
var grid=document.getElementById("grid");
function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]})}
function ago(iso){var s=Math.max(0,(Date.now()-new Date(iso).getTime())/1000);if(s<3600)return Math.max(1,Math.round(s/60))+" min ago";if(s<86400)return Math.round(s/3600)+" h ago";return Math.round(s/86400)+" d ago"}
async function load(){
 try{
  var r=await fetch("/api/public/saved",{credentials:"same-origin",cache:"no-store"}),d=await r.json();
  if(!r.ok)throw new Error();
  render(d.items||[])
 }catch(e){grid.innerHTML='<div class="empty" style="grid-column:1/-1"><b>Could not load your saved list</b>Please refresh the page.</div>'}
}
function render(items){
 if(!items.length){grid.innerHTML='<div class="empty" style="grid-column:1/-1"><b>Nothing saved yet</b>Open a broadcast and tap \\u201cSave for later\\u201d to keep it here.</div>';return}
 grid.innerHTML=items.map(function(i){
  return '<article class="card"><a class="thumb" href="/watch/'+encodeURIComponent(i.token)+'">'+(i.live?'<span class="badge live">LIVE</span>':'<span class="badge">OFFLINE</span>')+'\\u25B6</a>'+
  '<div class="info"><b>'+esc(i.title||i.name)+'</b><span>Saved '+ago(i.saved_at)+'</span>'+
  '<div class="row"><a class="chip gold" href="/watch/'+encodeURIComponent(i.token)+'">Watch</a><button class="chip" data-rm="'+esc(i.token)+'" type="button">Remove</button></div></div></article>'
 }).join("");
 grid.querySelectorAll("[data-rm]").forEach(function(b){b.onclick=async function(){
  b.disabled=true;
  try{var r=await fetch("/api/public/watch/"+encodeURIComponent(b.dataset.rm)+"/save",{method:"DELETE",credentials:"same-origin"});if(!r.ok)throw new Error();toast("Removed");load()}
  catch(e){b.disabled=false;toast("Could not remove. Try again.")}}})
}
load();setInterval(load,30000);
`;
  return page({ title: "My Saved • FBI TV", body, css: CSS, script });
}

module.exports = { libraryPage };
