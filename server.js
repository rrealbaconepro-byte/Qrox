// server.js: serves the Qrox site and runs every chat request through Groq.
const path = require('path');
const express = require('express');
const pdfParse = require('pdf-parse');

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Each role has its own model. Visitors never pick a model; the server chooses for them.
// To change one, set the matching variable in Render's environment settings.
const MODELS = {
  thinker: process.env.TEXT_MODEL || 'openai/gpt-oss-120b',
  researcher: process.env.SEARCH_MODEL || 'groq/compound',
  coder: process.env.CODE_MODEL || process.env.TEXT_MODEL || 'openai/gpt-oss-120b',
  creative: process.env.TEXT_MODEL || 'openai/gpt-oss-120b',
  verifier: process.env.TEXT_MODEL || 'openai/gpt-oss-120b',
  vision: process.env.VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
};

const MAX_TOKENS = 8192;
const MAX_MESSAGES = 100;
const MAX_IMAGES = 5;
const MAX_PDF_CHARS = 150000;
const MAX_MEMORIES = 50;
const MAX_VISION_REQUEST_BYTES = 4 * 1024 * 1024; // Groq's limit for a request that contains an image
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const HONESTY = [
  'You are Qrox, a helpful, accurate and friendly AI assistant, created by bbroot.',
  'If someone asks who made you, say you are Qrox, created by bbroot.',
  'Never say you are human. If someone sincerely asks whether they are talking to an AI, say yes.',
  'Do not name or describe the underlying model or company that powers Qrox. If asked, say you cannot share those details.',
  'Be honest. If you do not know something, or cannot verify it, say so plainly.',
  'Never invent facts, quotes, sources, links or numbers, and never claim to have run code you did not run.',
  'Say when information may be out of date.',
  'Use Markdown when it helps, and put code in fenced code blocks with the language name.',
].join(' ');

const ROLE_RULES = {
  thinker: 'Reason through the question carefully before answering. Give a clear, direct final answer.',
  researcher: 'Search the web for current information when it matters. End with a Sources list of the links you used.',
  coder: 'You are Code Bot. Write complete, working code. When you build something, give one complete file that runs as it is. Briefly explain how it works.',
  creative: 'Be imaginative and expressive while staying on topic.',
  verifier: 'You are a careful reviewer. Re-check the previous answer for factual, logical and code mistakes. List every problem you find, give the corrected answer, and say clearly what you are not sure about. If the earlier answer was right, say so and explain why.',
};

const PERSONALITIES = {
  balanced: 'Be balanced, friendly and to the point.',
  concise: 'Be brief. Use as few words as possible while staying accurate.',
  friendly: 'Be warm, encouraging and upbeat.',
  tutor: 'Teach patiently. Explain the reasoning, and end with one short question that checks understanding.',
  formal: 'Use a formal, professional tone.',
};

const LEVELS = {
  auto: 'Match the depth of the answer to the question.',
  beginner: 'Explain for a complete beginner. Avoid jargon, or define it the first time you use it.',
  intermediate: 'Explain for someone with some background knowledge.',
  expert: 'Explain for an expert. Be precise and skip the basics.',
};

// Simple rules that pick the role for each request. They run instantly, so no extra model call is needed.
const CODE_HINT = /\b(code|function|script|bug|error|python|javascript|typescript|java|html|css|sql|api|website|webpage|regex|compile|debug|program|algorithm)\b|```/i;
const CREATIVE_HINT = /\b(poem|story|song|lyrics|slogan|brainstorm|ideas?|creative|imagine that)\b/i;
const RESEARCH_HINT = /\b(latest|today|news|current|price|weather|this (week|year)|recent|who won|search)\b/i;
const DEEP_HINT = /\b(why|prove|compare|analy[sz]e|step|plan|derive|calculate|tradeoffs?|design)\b/i;

function pickRole(mode, webSearch, text) {
  if (mode === 'verify') return 'verifier';
  if (mode === 'code') return 'coder';
  if (webSearch || RESEARCH_HINT.test(text)) return 'researcher';
  if (CODE_HINT.test(text)) return 'coder';
  if (CREATIVE_HINT.test(text)) return 'creative';
  return 'thinker';
}

// Harder questions get more reasoning. Short, simple questions get less, so they answer faster.
function reasoningEffort(role, text) {
  if (role === 'verifier') return 'high';
  if (text.length < 60 && !DEEP_HINT.test(text)) return 'low';
  if (text.length > 400 || DEEP_HINT.test(text)) return 'high';
  return 'medium';
}

function buildSystemPrompt(role, settings, memories) {
  const parts = [HONESTY, ROLE_RULES[role], PERSONALITIES[settings.personality], LEVELS[settings.level]];
  if (memories.length) {
    parts.push(
      'Things the user asked you to remember. Use them when they are relevant, and do not list them back unless it helps:\n' +
      memories.map((m) => `- ${m}`).join('\n')
    );
  }
  return parts.join('\n\n');
}

function readSettings(input) {
  const s = input || {};
  return {
    personality: Object.hasOwn(PERSONALITIES, s.personality) ? s.personality : 'balanced',
    level: Object.hasOwn(LEVELS, s.level) ? s.level : 'auto',
  };
}

function readMemories(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => typeof m === 'string' && m.trim())
    .slice(0, MAX_MEMORIES)
    .map((m) => m.trim().slice(0, 300));
}

function textOf(message) {
  return typeof message.content === 'string' ? message.content : '';
}

function validate(body) {
  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) return 'Send at least one message.';
  if (messages.length > MAX_MESSAGES) return `A chat can have at most ${MAX_MESSAGES} messages. Please start a new chat.`;
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return 'Every message needs a role of "user" or "assistant".';
  }
  const last = messages[messages.length - 1];
  if (last.role !== 'user') return 'The last message must come from the user.';
  const images = (Array.isArray(last.attachments) ? last.attachments : []).filter((f) => f.kind === 'image');
  if (images.length > MAX_IMAGES) return `You can attach up to ${MAX_IMAGES} images to one message.`;
  return null;
}

// Groq doesn't read PDFs directly, so the text is pulled out here.
async function pdfToText(base64) {
  const { text } = await pdfParse(Buffer.from(base64, 'base64'));
  const trimmed = String(text || '').trim().slice(0, MAX_PDF_CHARS);
  return trimmed || '(This PDF has no selectable text. It may be a scanned document.)';
}

// Converts one chat message from the browser into the format Groq expects.
async function toGroqMessage(m) {
  if (m.role === 'assistant') return { role: 'assistant', content: String(m.content || '') };

  let text = String(m.content || '').trim();
  const imageParts = [];

  for (const file of Array.isArray(m.attachments) ? m.attachments : []) {
    if (file.kind === 'image' && IMAGE_TYPES.has(file.mediaType)) {
      imageParts.push({ type: 'image_url', image_url: { url: `data:${file.mediaType};base64,${file.data}` } });
    } else if (file.kind === 'pdf') {
      const pdfText = await pdfToText(file.data);
      text += `\n\n--- ${file.name || 'PDF'} ---\n${pdfText}`;
    }
  }

  if (imageParts.length === 0) {
    return { role: 'user', content: text || 'Please look at the attached file(s).' };
  }
  return {
    role: 'user',
    content: [{ type: 'text', text: text || 'Please look at the attached image(s).' }, ...imageParts],
  };
}

async function callGroq(payload, signal) {
  const upstream = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    const error = new Error(`Groq ${upstream.status}: ${detail.slice(0, 500)}`);
    error.status = upstream.status;
    throw error;
  }
  return upstream;
}

// Reads Groq's server-sent events and passes each piece of text to onText.
async function streamTokens(body, onText) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;

      const data = line.slice(5).trim();
      if (data === '[DONE]') return;

      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      const piece = event?.choices?.[0]?.delta?.content;
      if (piece) onText(piece);
    }
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits behind a proxy, so req.ip is the visitor's address
app.use(express.json({ limit: '30mb' }));

// Only these files are public. server.js, package.json and node_modules are never served.
const PUBLIC_FILES = new Set(['index.html', 'styles.css', 'app.js', 'logo.svg']);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/:file', (req, res, next) => {
  if (!PUBLIC_FILES.has(req.params.file)) return next();
  res.sendFile(path.join(__dirname, req.params.file));
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Per-IP rate limit so one visitor can't use up the Groq quota.
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 30;
const hits = new Map();

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, entry] of hits) {
    if (entry.start < cutoff) hits.delete(ip);
  }
}, WINDOW_MS).unref();

function rateLimit(req, res, next) {
  const now = Date.now();
  let entry = hits.get(req.ip);
  if (!entry || now - entry.start > WINDOW_MS) {
    entry = { start: now, count: 0 };
    hits.set(req.ip, entry);
  }
  entry.count += 1;
  if (entry.count > MAX_PER_WINDOW) {
    return res.status(429).json({ error: 'You are sending messages too quickly. Please wait a minute.' });
  }
  next();
}

app.post('/api/chat', rateLimit, async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'The server is missing its GROQ_API_KEY setting.' });
  }

  const body = req.body || {};
  const problem = validate(body);
  if (problem) return res.status(400).json({ error: problem });

  const settings = readSettings(body.settings);
  const memories = readMemories(body.memories);
  const mode = ['auto', 'code', 'verify'].includes(body.mode) ? body.mode : 'auto';

  let messages;
  try {
    // Drop empty assistant replies, for example from a failed earlier turn.
    const kept = body.messages.filter((m) => m.role === 'user' || String(m.content || '').trim() !== '');
    messages = await Promise.all(kept.map(toGroqMessage));
  } catch (err) {
    console.error('Could not read an attachment:', err.message);
    return res.status(400).json({ error: 'Could not read one of the attached PDFs.' });
  }

  const lastText = textOf(body.messages[body.messages.length - 1]);
  const role = pickRole(mode, body.webSearch === true, lastText);
  const hasImages = messages.some((m) => Array.isArray(m.content));
  const model = hasImages ? MODELS.vision : MODELS[role];

  const payload = {
    model,
    messages: [{ role: 'system', content: buildSystemPrompt(role, settings, memories) }, ...messages],
    stream: true,
    max_completion_tokens: MAX_TOKENS,
  };
  if (model.startsWith('openai/gpt-oss')) payload.reasoning_effort = reasoningEffort(role, lastText);

  if (hasImages && Buffer.byteLength(JSON.stringify(payload)) > MAX_VISION_REQUEST_BYTES) {
    return res.status(413).json({
      error: 'That request is too large for the image model. Try smaller images or start a new chat.',
    });
  }

  // If the visitor leaves the page, cancel the request to Groq.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  let upstream;
  try {
    upstream = await callGroq(payload, abort.signal);
  } catch (err) {
    if (abort.signal.aborted) return;
    console.error(`Chat request failed (${model}):`, err.message);
    const busy = err.status === 429;
    return res.status(busy ? 429 : 502).json({
      error: busy
        ? 'The AI service is busy right now. Please wait a moment and try again.'
        : 'The AI service could not answer that. Please try again.',
    });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Qrox-Role', role);
  res.flushHeaders();

  try {
    await streamTokens(upstream.body, (text) => res.write(text));
  } catch (err) {
    console.error('Stream interrupted:', err.message);
    if (!abort.signal.aborted) res.write('\n\n*Sorry, the reply was cut off. Please try again.*');
  } finally {
    res.end();
  }
});

// Short follow-up suggestions shown under each answer.
app.post('/api/followups', rateLimit, async (req, res) => {
  const { question = '', answer = '' } = req.body || {};
  if (!GROQ_API_KEY || typeof question !== 'string' || typeof answer !== 'string' || !answer.trim()) {
    return res.json({ suggestions: [] });
  }

  try {
    const upstream = await callGroq({
      model: MODELS.thinker,
      messages: [
        { role: 'system', content: 'You suggest useful follow-up questions. Reply with only a JSON array of three short questions.' },
        { role: 'user', content: `Question: ${question.slice(0, 1000)}\n\nAnswer: ${answer.slice(0, 3000)}` },
      ],
      max_completion_tokens: 800,
      reasoning_effort: 'low',
    });
    const data = await upstream.json();
    const text = data?.choices?.[0]?.message?.content || '';
    const match = text.match(/\[[\s\S]*\]/);
    const list = match ? JSON.parse(match[0]) : [];
    const suggestions = list
      .filter((s) => typeof s === 'string' && s.trim())
      .map((s) => s.trim().slice(0, 90))
      .slice(0, 3);
    res.json({ suggestions });
  } catch (err) {
    console.error('Follow-up suggestions failed:', err.message);
    res.json({ suggestions: [] });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Qrox is running on port ${PORT}`);
  if (!GROQ_API_KEY) console.warn('Warning: GROQ_API_KEY is not set, so chat requests will fail.');
});
