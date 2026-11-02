// server.js: serves the Qrox site and handles chat requests through Groq.
const path = require('path');
const express = require('express');
const pdfParse = require('pdf-parse');

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Model IDs. Groq updates its catalog often, so you can change these in Render's
// environment settings without editing code. Current list: https://console.groq.com/docs/models
const TEXT_MODEL = process.env.TEXT_MODEL || 'openai/gpt-oss-120b';
const VISION_MODEL = process.env.VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const SEARCH_MODEL = process.env.SEARCH_MODEL || 'groq/compound';

const MAX_TOKENS = 4096;
const MAX_MESSAGES = 100;
const MAX_IMAGES = 5;
const MAX_PDF_CHARS = 150000;
// Groq allows at most 4 MB in a request that contains a base64 image.
const MAX_VISION_REQUEST_BYTES = 4 * 1024 * 1024;

const SYSTEM_PROMPT = [
  'You are Qrox, a helpful, accurate and friendly AI assistant.',
  'Use Markdown when it makes an answer easier to read.',
  'Put code in fenced code blocks and name the language.',
  'Say so when you are not sure about something.',
].join(' ');

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

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

// Simple per-IP rate limit so one visitor can't use up your Groq quota.
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;
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

function validate(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'Send at least one message.';
  if (messages.length > MAX_MESSAGES) {
    return `A chat can have at most ${MAX_MESSAGES} messages. Please start a new chat.`;
  }
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      return 'Every message needs a role of "user" or "assistant".';
    }
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

app.post('/api/chat', rateLimit, async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'The server is missing its GROQ_API_KEY setting.' });
  }

  const body = req.body || {};
  const problem = validate(body.messages);
  if (problem) return res.status(400).json({ error: problem });

  let messages;
  try {
    // Drop empty assistant replies, for example from a failed earlier turn.
    const kept = body.messages.filter((m) => m.role === 'user' || String(m.content || '').trim() !== '');
    messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...(await Promise.all(kept.map(toGroqMessage)))];
  } catch (err) {
    console.error('Could not read an attachment:', err.message);
    return res.status(400).json({ error: 'Could not read one of the attached PDFs.' });
  }

  // Images use the vision model. Otherwise, web search uses the search model and normal chat uses the text model.
  const hasImages = messages.some((m) => Array.isArray(m.content));
  const model = hasImages ? VISION_MODEL : (body.webSearch === true ? SEARCH_MODEL : TEXT_MODEL);

  const payload = JSON.stringify({ model, messages, stream: true, max_completion_tokens: MAX_TOKENS });
  if (hasImages && Buffer.byteLength(payload) > MAX_VISION_REQUEST_BYTES) {
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
    upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: payload,
      signal: abort.signal,
    });
  } catch (err) {
    console.error('Could not reach Groq:', err.message);
    return res.status(502).json({ error: 'Could not reach the AI service. Please try again.' });
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error(`Groq returned ${upstream.status} for model ${model}: ${detail.slice(0, 500)}`);
    const message = upstream.status === 429
      ? 'The AI service is busy right now. Please wait a moment and try again.'
      : 'The AI service could not answer that. Please try again.';
    return res.status(502).json({ error: message });
  }

  // Stream the reply back as plain text while the model writes it.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    await streamTokens(upstream.body, (text) => res.write(text));
  } catch (err) {
    console.error('Stream interrupted:', err.message);
    if (!abort.signal.aborted) {
      res.write('\n\n*Sorry, the reply was cut off. Please try again.*');
    }
  } finally {
    res.end();
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Qrox is running on port ${PORT}`);
  if (!GROQ_API_KEY) console.warn('Warning: GROQ_API_KEY is not set, so chat requests will fail.');
});
