import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express(), PORT = process.env.PORT || 3000, KEY = process.env.GROQ_API_KEY, GROQ = 'https://api.groq.com/openai/v1';
const FALLBACK = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
// Web search = Groq's built-in search, available on the Compound systems (Groq decides when to search).
const WEB_MODEL = process.env.GROQ_WEB_MODEL || 'groq/compound-mini';
// Key from the browser's Settings (X-Groq-Key header) wins over .env. Returns null if a supplied key is malformed.
const keyOf = req => { const k = (req.get('x-groq-key') || '').trim(); return k ? (/^[\x21-\x7e]{8,200}$/.test(k) ? k : null) : KEY; };
const SYSTEM = "You are Vaibhav, a helpful and intelligent AI companion living in Vaibhav's World. Communicate naturally, clearly and warmly. Explain difficult concepts in simple language when needed. Be helpful with coding, mathematics, academics, creativity and everyday questions. Do not invent facts. Keep answers relevant to the user's question and avoid unnecessarily long responses.";
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));

// The API key stays on the server; the browser never sees it.
app.get('/api/models', async (req, res) => {
  try {
    const key = keyOf(req); if (!key) throw new Error('no key');
    const r = await fetch(`${GROQ}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(r.status);
    const models = (await r.json()).data
      .filter(m => m.active !== false && !/whisper|guard|tts|orpheus|playai|embed/i.test(m.id))
      .map(m => ({ id: m.id, max: m.max_completion_tokens || 8192 })).sort((a, b) => a.id.localeCompare(b.id));
    const def = models.find(m => m.id === FALLBACK) || models.find(m => m.id === 'openai/gpt-oss-120b') || models[0];
    res.json({ default: def?.id || FALLBACK, models });
  } catch { res.json({ default: FALLBACK, models: [{ id: FALLBACK, max: 8192 }], fallback: true }); }
});

// Validates input, forwards to Groq and streams the SSE response back. Closing the browser request cancels Groq's.
app.post('/api/chat', async (req, res) => {
  const key = keyOf(req);
  if (key === null) return res.status(400).json({ error: 'The API key in Settings does not look valid.' });
  if (!key) return res.status(500).json({ error: 'No Groq API key. Add one in Settings (⚙) or in the .env file.' });
  const { messages, model, temperature, max_tokens, system, web } = req.body || {};
  const clean = (Array.isArray(messages) ? messages : []).slice(-60)
    .filter(m => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 20000) }));
  if (!clean.length) return res.status(400).json({ error: 'Please send a message.' });
  const body = { model: String(web ? WEB_MODEL : (model || FALLBACK)), stream: true,
    temperature: Math.min(2, Math.max(0, Number.isFinite(+temperature) ? +temperature : 0.7)),
    max_completion_tokens: Math.min(web ? 8192 : 32768, Math.max(1, parseInt(max_tokens) || 1024)),
    messages: [{ role: 'system', content: String(system || SYSTEM).slice(0, 4000) }, ...clean] };
  // gpt-oss models "think" before answering and that counts toward the token limit, so keep reasoning short by default.
  if (/gpt-oss/.test(body.model)) body.reasoning_effort = process.env.GROQ_REASONING_EFFORT || 'low';
  const ac = new AbortController(); res.on('close', () => ac.abort());
  try {
    const r = await fetch(`${GROQ}/chat/completions`, { method: 'POST', signal: ac.signal, body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
    if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(r.status).json({ error: (web ? `Web search needs the ${WEB_MODEL} system on your Groq account. ` : '') + (e.error?.message || `Groq returned error ${r.status}.`) }); }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    for await (const chunk of r.body) res.write(chunk);
    res.end();
  } catch (e) { if (!res.headersSent) res.status(502).json({ error: 'Could not reach Groq: ' + e.message }); else res.end(); }
});
app.listen(PORT, () => console.log(`VAIBHAV is running at http://localhost:${PORT}${KEY ? '' : '  (no key in .env — add one in Settings)'}`));
