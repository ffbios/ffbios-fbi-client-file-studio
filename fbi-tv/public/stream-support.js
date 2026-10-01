let activeStudioView="streams";
let selectedStreamId=null;
let streamPoller=null;
let renderedStreamSignature="";

async function loadStreams(){
  const d=await api('/api/streams');
  window.__streams=d.streams||[];
  renderStreamsList();

  const s=selectedStream();
  const signature=s ? [s.id,s.status,s.viewer_url||""] .join("|") : "";
  // The main-portal poller runs every 5 seconds. Do not rebuild the player
  // while the same live stream is still active, because replacing the iframe
  // interrupts playback. Re-render only when the selected stream changes
  // between offline/live or its playback URL changes.
  if(signature!==renderedStreamSignature){
    renderedStreamSignature=signature;
    renderSelectedStream();
  } else if(s){
    const viewers=document.querySelector('#streamDetailViewers');
    if(viewers)viewers.textContent=Number(s.current_viewers||0)+" watching";
  }
}
function streamStatusBadge(s){
  return '<span class="livebadge '+(s.status==='live'?'live':'')+'">'+(s.status==='live'?'● LIVE':'OFFLINE')+'</span>';
}
function renderStreamsList(){
  const list=document.querySelector('#streamList');if(!list)return;
  const streams=window.__streams||[];
  const live=streams.filter(s=>s.status==='live').length;
  const viewers=streams.reduce((a,s)=>a+Number(s.current_viewers||0),0);
  const total=streams.reduce((a,s)=>a+Number(s.total_viewers||0),0);
  const a=document.querySelector('#streamCount'),b=document.querySelector('#liveCount'),c=document.querySelector('#viewerCount'),d=document.querySelector('#streamHistoryCount');
  if(a)a.textContent=streams.length;b&&(b.textContent=live);c&&(c.textContent=viewers);d&&(d.textContent=total);
  if(!streams.length){list.innerHTML='<div class="empty">No live streams created yet.</div>';return}
  list.innerHTML=streams.map(function(s){
    return '<div class="streamrow '+(selectedStreamId===s.id?'sel':'')+'" data-stream-id="'+s.id+'"><div class="row"><div class="stitle">'+esc(s.name)+'</div><div class="streamrow-actions">'+streamStatusBadge(s)+'<button type="button" class="mini stream-delete-btn" data-delete-stream="'+esc(s.id)+'" title="Delete stream">🗑️</button></div></div><div class="smeta">'+esc(s.title||'')+'<br>'+Number(s.current_viewers||0)+' watching now</div></div>';
  }).join('');
  list.querySelectorAll('[data-stream-id]').forEach(function(el){
    el.onclick=function(e){if(e.target.closest('[data-delete-stream]'))return;selectedStreamId=el.dataset.streamId;renderStreamsList();renderSelectedStream()};
  });
  list.querySelectorAll('[data-delete-stream]').forEach(function(btn){
    btn.onclick=async function(e){
      e.preventDefault();e.stopPropagation();
      const stream=(window.__streams||[]).find(function(x){return x.id===btn.dataset.deleteStream});
      if(!stream)return;
      if(!confirm('Delete "'+stream.name+'"? Existing recorded sessions will remain saved.'))return;
      try{
        await api('/api/streams/'+encodeURIComponent(stream.id),{method:'DELETE'});
        if(selectedStreamId===stream.id)selectedStreamId=null;
        renderedStreamSignature='';
        await loadStreams();
        toast('Stream deleted');
      }catch(err){toast(err.message||'Could not delete stream')}
    };
  });
}
function selectedStream(){return (window.__streams||[]).find(function(s){return s.id===selectedStreamId})||null;}
