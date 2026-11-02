// server.js: serves the Qrox site and handles chat requests through Claude.
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;

// Fixed on the server. Visitors can't pick or change the model.
const MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 4096;
const MAX_MESSAGES = 100;

// Anthropic's built-in web search tool, used when a visitor turns on "Web search".
// If Anthropic publishes a newer version of this tool, update the type string here.
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };

const SYSTEM_PROMPT = [
  'You are Qrox, a helpful, accurate and friendly AI assistant.',
  'Use Markdown when it makes an answer easier to read.',
  'Put code in fenced code blocks and name the language.',
  'Say so when you are not sure about something.',
].join(' ');

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// The API key comes from the environment (set it in Render). It is never sent to the browser.
const apiKey = process.env.ANTHROPIC_API_KEY;
const client = apiKey ? new Anthropic({ apiKey }) : null;

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

// Simple per-IP rate limit so one visitor can't run up the API bill.
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
  if (messages[messages.length - 1].role !== 'user') return 'The last message must come from the user.';
  return null;
}

// Converts one chat message from the browser into the shape Anthropic expects.
function toApiMessage(m) {
  if (m.role === 'assistant') return { role: 'assistant', content: String(m.content || '') };

  const blocks = [];
  for (const file of Array.isArray(m.attachments) ? m.attachments : []) {
    if (file.kind === 'image' && IMAGE_TYPES.has(file.mediaType)) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: file.mediaType, data: file.data } });
    } else if (file.kind === 'pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data } });
    }
  }
  blocks.push({ type: 'text', text: String(m.content || '').trim() || 'Please look at the attached file(s).' });
  return { role: 'user', content: blocks };
}

app.post('/api/chat', rateLimit, async (req, res) => {
  if (!client) {
    return res.status(500).json({ error: 'The server is missing its ANTHROPIC_API_KEY setting.' });
  }

  const body = req.body || {};
  const problem = validate(body.messages);
  if (problem) return res.status(400).json({ error: problem });

  // Drop empty assistant replies, for example from a failed earlier turn.
  const messages = body.messages
    .filter((m) => m.role === 'user' || String(m.content || '').trim() !== '')
    .map(toApiMessage);

  const request = { model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages };
  if (body.webSearch === true) request.tools = [WEB_SEARCH_TOOL];

  // Stream the reply back as plain text while Claude writes it.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // If the visitor leaves the page, stop generating to save tokens.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  try {
    const stream = client.messages.stream(request, { signal: abort.signal });
    stream.on('text', (text) => res.write(text));
    await stream.finalMessage();
  } catch (err) {
    console.error('Chat request failed:', err.message);
    if (!abort.signal.aborted) {
      res.write('\n\n*Sorry, something went wrong. Please try again.*');
    }
  } finally {
    res.end();
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Qrox is running on port ${PORT}`);
  if (!client) console.warn('Warning: ANTHROPIC_API_KEY is not set, so chat requests will fail.');
});
