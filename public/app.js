'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('vaibhav.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('vaibhav.' + k, JSON.stringify(v)); } catch {} }
};
const DEF = {model: '', temperature: 0.7, max_tokens: 4096, web: false,
  system: "You are Vaibhav, a helpful and intelligent AI companion living in Vaibhav's World. Communicate naturally, clearly and warmly. Explain difficult concepts in simple language when needed. Be helpful with coding, mathematics, academics, creativity and everyday questions. Do not invent facts. Keep answers relevant to the user's question and avoid unnecessarily long responses."};
const WELCOME = "Hey! Welcome to Vaibhav's World. 🌿\n\nI'm Vaibhav, your AI companion. Ask me anything, explore ideas, learn something new or just have a conversation. What's on your mind today?";
const PROMPTS = ['Explain something to me', 'Help me write something', 'Teach me a new concept', 'Help me with coding'];
let cfg = {...DEF, ...store.get('cfg', {})}, snd = {on: true, vol: 0.5, ...store.get('snd', {})};
// one-time move from the old defaults (llama model, 1024 tokens) to gpt-oss-120b
if (cfg.model === 'llama-3.3-70b-versatile') { cfg.model = ''; if (cfg.max_tokens === 1024) cfg.max_tokens = 4096; }
let msgs = (store.get('chat', []) || []).filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string');
let models = [], ctl = null, busy = false, entered = false;
let apiKey = store.get('key', '') || '';   // optional key saved in this browser; the server falls back to .env
const hdr = () => ({'Content-Type': 'application/json', ...(apiKey ? {'X-Groq-Key': apiKey} : {})});
const chat = $('#chat'), inp = $('#inp'), aud = $('#aud');
// Chat and settings need the local Node server; opening index.html straight from a folder (file://) cannot reach it.
const FILE = location.protocol === 'file:';
const FILE_MSG = 'This page was opened as a file, so it cannot reach the server. In the project folder run "npm start", then open http://localhost:3000 in your browser.';

/* ---------- Markdown (sanitized) ---------- */
if (window.DOMPurify) DOMPurify.addHook('afterSanitizeAttributes', n => { if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); } });
/** Markdown -> HTML, always passed through DOMPurify. Falls back to escaped text if the libraries could not load. */
const md = t => (window.marked && window.DOMPurify) ? DOMPurify.sanitize(marked.parse(t, {gfm: true, breaks: true})) : `<p>${esc(t).replace(/\n/g, '<br>')}</p>`;

/* ---------- Rendering ---------- */
const btn = (txt, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = txt; b.onclick = fn; return b; };
function copy(text, el) { navigator.clipboard.writeText(text).then(() => { el.textContent = 'Copied ✓'; setTimeout(() => el.textContent = 'Copy', 1500); }).catch(() => el.textContent = 'Copy failed'); }
function scroll(force) { if (force || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160) chat.scrollTop = chat.scrollHeight; }
/** Append one message bubble. o.typing = animated dots; o.real = saved message (gets copy/regenerate actions). */
function add(role, content, t, o = {}) {
  const el = document.createElement('div'); el.className = 'msg ' + role;
  const b = document.createElement('div'); b.className = 'b'; el.append(b);
  if (role === 'user') b.textContent = content;
  else if (o.typing) b.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>' + (cfg.web ? ' <small class="mt">searching the web…</small>' : '');
  else b.innerHTML = md(content);
  if (!o.typing) {
    const meta = document.createElement('div'); meta.className = 'meta'; el.append(meta);
    if (t) meta.innerHTML = `<time>${new Date(t).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</time>`;
    if (role === 'assistant' && o.real) { meta.append(btn('Copy', e => copy(content, e.target))); if (o.last) meta.append(btn('↻ Regenerate', regen)); }
  }
  chat.append(el);
  if (window.hljs) b.querySelectorAll('pre code').forEach(c => hljs.highlightElement(c));
  return {el, b};
}
function renderAll() {
  chat.innerHTML = ''; add('assistant', WELCOME);
  if (FILE) { const w = add('assistant', '', null); w.el.classList.add('err'); w.b.textContent = '⚠ ' + FILE_MSG; }
  msgs.forEach((m, i) => add(m.role, m.content, m.t, {real: true, last: i === msgs.length - 1 && m.role === 'assistant'}));
  $('#prompts').hidden = msgs.length > 0; scroll(true);
}
const save = () => { msgs = msgs.slice(-100); store.set('chat', msgs); };
const ui = () => { $('#send').hidden = busy; $('#stop').hidden = !busy; };

/* ---------- Chat with Groq via our server (streaming) ---------- */
async function send(text) {
  text = (text || '').trim(); if (!text || busy) return;
  msgs.push({role: 'user', content: text, t: Date.now()}); inp.value = ''; inp.style.height = 'auto'; save(); ask();
}
function regen() { if (busy) return; if (msgs.at(-1)?.role === 'assistant') msgs.pop(); save(); ask(); }
async function ask() {
  busy = true; renderAll(); ui();
  const a = add('assistant', '', null, {typing: true}); scroll(true);
  ctl = new AbortController(); let acc = '', raf = 0, err = null, stopped = false;
  const paint = () => { raf = 0; a.b.innerHTML = md(acc); scroll(); };
  try {
    if (FILE) throw new Error(FILE_MSG);
    cfg.max_tokens = clampTok(cfg.max_tokens);
    const r = await fetch('/api/chat', {method: 'POST', headers: hdr(), signal: ctl.signal,
      body: JSON.stringify({messages: msgs.slice(-40).map(({role, content}) => ({role, content})), model: cfg.model, temperature: cfg.temperature, max_tokens: cfg.max_tokens, system: cfg.system, web: cfg.web})});
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Server error ${r.status}`); }
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const {done, value} = await rd.read(); if (done) break;
      buf += dec.decode(value, {stream: true}); const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.startsWith('data:')) continue; const p = l.slice(5).trim(); if (p === '[DONE]') continue;
        try { const t = JSON.parse(p).choices?.[0]?.delta?.content; if (t) { acc += t; if (!raf) raf = requestAnimationFrame(paint); } } catch {}
      }
    }
    if (!acc) throw new Error('The model returned an empty response. Try again.');
  } catch (e) { if (e.name === 'AbortError') stopped = true; else err = e.message === 'Failed to fetch' ? 'Cannot reach the server. Make sure "npm start" is running in the project folder, then reload http://localhost:3000.' : e.message; }
  cancelAnimationFrame(raf); busy = false; ctl = null;
  if (acc) { msgs.push({role: 'assistant', content: acc + (stopped ? '\n\n*(stopped)*' : ''), t: Date.now()}); save(); renderAll(); }
  else if (err) { a.el.classList.add('err'); a.b.textContent = '⚠ ' + err + ' '; a.b.append(btn('Try again', ask)); }
  else renderAll();
  ui();
}
$('#form').onsubmit = e => { e.preventDefault(); send(inp.value); };
inp.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#form').requestSubmit(); } };
inp.oninput = () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 160) + 'px'; };
$('#stop').onclick = () => ctl && ctl.abort();
$('#newChat').onclick = () => { if (ctl) ctl.abort(); msgs = []; save(); busy = false; renderAll(); ui(); inp.focus(); };
$('#prompts').append(...PROMPTS.map(p => btn(p, () => send(p))));

/* ---------- Settings ---------- */
const T = $('#temp'), K = $('#tok'), SEL = $('#model'), SYS = $('#sys');
const clampTok = v => Math.min(+K.max || 8192, Math.max(1, parseInt(v) || DEF.max_tokens));
function syncSettings() {
  const m = models.find(x => x.id === cfg.model); K.max = Math.min(cfg.web ? 8192 : 32768, m ? m.max : 8192); SEL.disabled = !!cfg.web; $('#web').checked = !!cfg.web; cfg.max_tokens = clampTok(cfg.max_tokens);
  T.value = cfg.temperature; $('#tv').textContent = (+cfg.temperature).toFixed(1); K.value = cfg.max_tokens; SYS.value = cfg.system;
  $('#kmax').textContent = `Maximum for this model: ${K.max}.`; store.set('cfg', cfg);
}
T.oninput = () => { cfg.temperature = +T.value; syncSettings(); };
K.onchange = () => { cfg.max_tokens = clampTok(K.value); syncSettings(); };
SEL.onchange = () => { cfg.model = SEL.value; syncSettings(); };
SYS.onchange = () => { cfg.system = SYS.value.trim() || DEF.system; syncSettings(); };
$('#reset').onclick = () => { cfg = {...DEF, model: SEL.value}; syncSettings(); };
$('#gear').onclick = () => $('#drawer').hidden = !$('#drawer').hidden;
$('#close').onclick = () => $('#drawer').hidden = true;
$('#web').onchange = () => { cfg.web = $('#web').checked; syncSettings(); };
/* API key: saved in this browser only, sent to our own server in a header */
$('#key').value = apiKey;
const keyMsg = t => $('#keyMsg').textContent = t;
$('#keySave').onclick = async () => {
  if (FILE) return keyMsg('⚠ ' + FILE_MSG);
  const k = $('#key').value.trim();
  if (k && !/^[\x21-\x7e]{8,200}$/.test(k)) return keyMsg('⚠ That does not look like a valid API key.');
  apiKey = k; store.set('key', k); keyMsg('Checking…');
  keyMsg(await loadModels() ? '✓ Key works. Models loaded.' : '⚠ Could not load models. Check the key (or the key in .env).');
};
$('#keyClear').onclick = async e => { e.preventDefault(); apiKey = ''; $('#key').value = ''; store.set('key', ''); keyMsg('Saved key removed. Using the key from .env.'); await loadModels(); };
addEventListener('keydown', e => { if (e.key === 'Escape') $('#drawer').hidden = true; });
/** Fill the model selector from Groq's live model list (via the server). */
async function loadModels() {
  let ok = false;
  try { const d = await (await fetch('/api/models', {headers: hdr()})).json(); models = d.models; ok = !d.fallback; if (!models.some(m => m.id === cfg.model)) cfg.model = d.default; }
  catch { models = [{id: cfg.model || 'openai/gpt-oss-120b', max: 8192}]; cfg.model = models[0].id; }
  SEL.innerHTML = models.map(m => `<option>${esc(m.id)}</option>`).join(''); SEL.value = cfg.model; syncSettings(); return ok;
}

/* ---------- Sound: local mp3 if present, otherwise synthesized rain + distant thunder ---------- */
let synth = null, useSynth = false, playing = false;
function makeSynth() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)(), out = ctx.createGain(); out.connect(ctx.destination);
  const noise = sec => { const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return b; };
  const rain = ctx.createBufferSource(), hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter();
  rain.buffer = noise(3); rain.loop = true; hp.type = 'highpass'; hp.frequency.value = 700; lp.type = 'lowpass'; lp.frequency.value = 7000;
  rain.connect(hp).connect(lp).connect(out); rain.start();
  (function thunder() { setTimeout(() => {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(), t = ctx.currentTime;
    s.buffer = noise(4); f.type = 'lowpass'; f.frequency.value = 140; g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(1.6, t + 0.4); g.gain.exponentialRampToValueAtTime(0.001, t + 3.5);
    s.connect(f).connect(g).connect(out); s.start(t); thunder();
  }, 12000 + Math.random() * 25000); })();
  return {set: v => { out.gain.value = v * 0.6; if (ctx.state === 'suspended') ctx.resume(); }};
}
function applySound() {
  const v = snd.on ? snd.vol : 0; if (useSynth) synth && synth.set(v); else aud.volume = v;
  $('#mute').textContent = snd.on ? '🔊' : '🔇'; $('#wSound').textContent = snd.on ? '🔊 Sound on' : '🔇 Sound off'; $('#vol').value = snd.vol; store.set('snd', snd);
}
/** Starts once (never restarts between chats). Must be called from a click. */
async function startSound() {
  if (!snd.on) return;
  if (!playing) { playing = true;
    try { if (useSynth) throw 0; aud.volume = snd.vol; await aud.play(); }
    catch { useSynth = true; try { synth = synth || makeSynth(); $('#sndNote').hidden = false; } catch { /* no audio available */ } } }
  applySound();
}
$('#mute').onclick = $('#wSound').onclick = () => { snd.on = !snd.on; if (entered && snd.on) startSound(); else applySound(); };
$('#vol').oninput = e => { snd.vol = +e.target.value; snd.on = snd.vol > 0; if (entered && snd.on) startSound(); else applySound(); };

/* ---------- Rain animation ---------- */
(function rain() {
  const c = $('#rain'), g = c.getContext('2d'); let W, H, drops = [];
  const size = () => { W = c.width = innerWidth; H = c.height = innerHeight; drops = Array.from({length: Math.min(160, W / 6)}, () => ({x: Math.random() * W, y: Math.random() * H, l: 10 + Math.random() * 18, v: 9 + Math.random() * 9})); };
  size(); addEventListener('resize', size);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  (function frame() {
    g.clearRect(0, 0, W, H); g.strokeStyle = 'rgba(180,230,200,.28)'; g.beginPath();
    drops.forEach(d => { g.moveTo(d.x, d.y); g.lineTo(d.x - d.l * .15, d.y + d.l); d.y += d.v; d.x -= d.v * .12; if (d.y > H || d.x < 0) { d.y = -20; d.x = Math.random() * W * 1.1; } });
    g.stroke(); requestAnimationFrame(frame);
  })();
})();

/* ---------- Enter the world ---------- */
$('#enter').onclick = () => {
  entered = true; document.body.classList.add('entering'); startSound();
  setTimeout(() => { $('#welcome').hidden = true; $('#app').hidden = false; document.body.classList.add('in'); inp.focus(); }, 900);
};
renderAll(); applySound(); syncSettings(); loadModels();
