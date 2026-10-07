// Shared look for every viewer-facing FBI TV page (watch, program, library).
// Presentation only: nothing here touches the streaming engine.

const HLS_SCRIPT = '<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>';

const BASE_CSS = `
:root{--bg:#07080a;--panel:#101217;--panel2:#161920;--line:#262b34;--text:#f4f5f7;--muted:#8d95a1;--gold:#e6c44c;--green:#62e49a;--red:#ff6464;--radius:18px}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:radial-gradient(circle at 50% -10%,rgba(70,82,120,.28),transparent 42%),var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
button{font:inherit;cursor:pointer}
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px max(16px,env(safe-area-inset-right)) 12px max(16px,env(safe-area-inset-left));background:rgba(7,8,10,.86);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;font-weight:900;letter-spacing:.16em;font-size:12px;color:var(--gold)}
.brand i{display:grid;place-items:center;width:34px;height:28px;border:1px solid #5b4d1e;background:#17150b;font-style:normal;font-size:11px}
.nav{display:flex;gap:8px}
.chip{display:inline-flex;align-items:center;gap:7px;padding:8px 13px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--text);font-size:12px;font-weight:700;transition:.15s}
.chip:hover{border-color:#3a4150;background:var(--panel2)}
.chip.gold{background:var(--gold);border-color:var(--gold);color:#111}
.chip.on{border-color:rgba(230,196,76,.6);color:var(--gold);background:#1c180a}
.wrap{max-width:1240px;margin:0 auto;padding:22px max(16px,env(safe-area-inset-right)) 40px max(16px,env(safe-area-inset-left))}
.badge{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.06em;border:1px solid var(--line);color:var(--muted);background:var(--panel)}
.badge.live{color:var(--green);border-color:rgba(98,228,154,.4);background:rgba(98,228,154,.08)}
.badge.live::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 10px var(--green);animation:pulse 1.6s infinite}
@keyframes pulse{50%{opacity:.35}}
.toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,20px);opacity:0;background:#1b1f27;border:1px solid #333a46;padding:11px 16px;border-radius:12px;font-size:13px;z-index:50;transition:.2s;pointer-events:none}
.toast.show{opacity:1;transform:translate(-50%,0)}
.foot{color:#59606b;font-size:11px;text-align:center;padding:26px 0 8px}
`;

function page({ title, body, css = "", script = "", withHls = false }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#07080a">
<title>${title}</title>${withHls ? HLS_SCRIPT : ""}
<style>${BASE_CSS}${css}</style></head><body>${body}
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>function toast(m){var t=document.getElementById("toast");t.textContent=m;t.classList.add("show");clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove("show")},2200)}</script>
<script>${script}</script></body></html>`;
}

function topbar(active) {
  return `<header class="topbar"><a class="brand" href="/library"><i>FBI</i>FBI TV</a>
<nav class="nav"><a class="chip ${active === "library" ? "on" : ""}" href="/library">&#9733; My Saved</a></nav></header>`;
}

module.exports = { page, topbar };
