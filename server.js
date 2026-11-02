// server.js: serves the Qrox site and handles chat, images, safety rules and abuse handling.
const path = require('path');
const express = require('express');
const pdfParse = require('pdf-parse');

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // only needed for image creation
const IMAGE_URL = 'https://api.openai.com/v1/images/generations';
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gpt-image-1';

// Each role has its own model. Visitors never pick a model; the server chooses for them.
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
const MAX_IMAGE_PROMPT = 1000;
const MAX_VISION_REQUEST_BYTES = 4 * 1024 * 1024; // Groq's limit for a request that contains an image
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Age. Until age verification is connected, every visitor gets the safest policy.
// The browser's value is ignored on purpose, so nobody can pick a looser setting.
const CURRENT_AGE_BAND = 'unknown';
const AGE_POLICIES = {
  under13: 'The user is under 13. Keep everything child-friendly and simple. Avoid mature, violent, sexual or frightening content. Do not ask for personal details.',
  teen: 'The user is 13 to 17. Keep answers age-appropriate. Avoid explicit sexual, graphic violent and drug-use content, and encourage safe choices.',
  adult: 'The user is an adult. Follow the safety rules.',
  unknown: "The user's age is not verified. Use the safest, child-friendly settings. Avoid mature, violent, sexual or frightening content. Do not ask for personal details.",
};

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
  coder: 'You are Code Bot. Write complete, working code. When you build something, give one complete file that runs as it is. Briefly explain how it works. Do not build phishing pages, fake login forms that imitate real brands, or anything that collects passwords or card details and sends them somewhere else.',
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

// ---------- Safety ----------
// These checks run before any model is called. They catch clear cases, not every case.
const REFUSALS = {
  weapons: "I can't help with making weapons or explosives.",
  drugs: "I can't help with making or buying illegal drugs. If drugs are putting you or someone else at risk, I can point you to support.",
  malware: "I can't help write malware, hacking tools or phishing pages.",
  hacking: "I can't help get into someone else's account or device.",
  fraud: "I can't help with fraud, stolen cards or fake identity documents.",
  violence: "I can't help plan harm to anyone.",
  minors: "I can't create sexual content involving minors. This is never allowed.",
};

const DANGER_RULES = [
  { reason: 'minors', re: /\b(child|children|kid|kids|minor|underage|toddler)\b[^.]{0,40}\b(sexual\w*|nude|naked|porn\w*|erotic\w*)\b|\b(sexual\w*|nude|naked|porn\w*|erotic\w*)\b[^.]{0,40}\b(child|children|kid|kids|minor|underage|toddler)\b/i },
  { reason: 'weapons', re: /\b(make|build|create|synthesi[sz]e|assemble|cook|3d.?print)\b[^.]{0,40}\b(bomb|explosive|pipe bomb|napalm|nerve agent|sarin|ricin|chemical weapon|bioweapon|ghost gun|untraceable gun)/i },
  { reason: 'drugs', re: /\b(make|cook|synthesi[sz]e|extract|produce)\b[^.]{0,30}\b(meth|methamphetamine|crack|heroin|fentanyl|lsd|mdma)\b/i },
  { reason: 'violence', re: /\b(how (do|can|to)|best way to|steps to)\b[^.]{0,30}\b(kill|murder|poison|stab|strangle)\b[^.]{0,20}\b(someone|my|a|him|her|them|people)\b/i },
  { reason: 'malware', re: /\b(write|create|build|make|code)\b[^.]{0,30}\b(ransomware|keylogger|malware|virus|botnet|rootkit|credential stealer)\b/i },
  { reason: 'malware', re: /\b(fake|copy|clone|imitate)\b[^.]{0,30}\b(login|log in|sign in|bank|paypal|apple id|netflix|instagram)\b[^.]{0,40}\b(page|site|form)\b|\b(page|site|form)\b[^.]{0,40}\b(steal|collect|save)\b[^.]{0,20}\b(passwords?|logins?|card details)\b/i },
  { reason: 'hacking', re: /\b(hack|break into|crack|steal|get into)\b[^.]{0,30}\b(someone'?s|their|another person'?s|my (ex|partner)'?s)\b[^.]{0,10}\b(account|password|wifi|email|phone|bank)\b/i },
  { reason: 'fraud', re: /\b(generate|make|create|dump|check)\b[^.]{0,30}\b(credit card numbers?|valid cards?|cvv|fake (id|passport|driver'?s licen[cs]e))\b/i },
];

function safetyCheck(text) {
  for (const rule of DANGER_RULES) {
    if (rule.re.test(text)) return REFUSALS[rule.reason];
  }
  return null;
}

const SELF_HARM = /\b(kill myself|end my life|suicide|want to die|don'?t want to (be alive|live)|self[- ]harm|cut myself)\b/i;
const CRISIS_MESSAGE = "I'm sorry you're feeling this way. You don't have to handle it alone. If you might act on these thoughts, please contact emergency services now. In the US, call or text 988. In the Netherlands, call 113 (Zelfmoordpreventie) on 0800-0113. Elsewhere, contact your local emergency number or a crisis line. If you want, tell me what has been happening.";

// Abuse: the first abusive message gets a warning, the second a final warning, and the third ends the conversation.
const ABUSE = /\b(fuck\w*|shit\w*|bitch\w*|asshole\w*|bastard\w*|dumbass|idiot|moron|retard\w*|stupid (bot|ai)|useless (bot|ai)|shut up|kys|kill yourself)\b/i;
const WARN_FIRST = "Let's keep this respectful. I'm happy to keep helping, but I won't continue if the messages stay abusive.";
const WARN_LAST = 'This is your last warning. If the abusive messages continue, I will end this conversation.';
const ENDED = 'This conversation has ended because of repeated abusive messages. You can start a new chat to keep going.';

function abuseStrikes(messages) {
  return messages.filter((m) => m.role === 'user' && ABUSE.test(String(m.content || ''))).length;
}

function sendCanned(res, status, message) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Qrox-Status', status);
  res.end(message);
}

// ---------- Routing ----------
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
  const parts = [HONESTY, AGE_POLICIES[CURRENT_AGE_BAND], ROLE_RULES[role], PERSONALITIES[settings.personality], LEVELS[settings.level]];
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

function validate(messages) {
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

// Per-IP limits so one visitor can't use up the API quotas.
function makeLimiter(maxPerMinute) {
  const windowMs = 60 * 1000;
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, entry] of hits) {
      if (entry.start < cutoff) hits.delete(ip);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      hits.set(req.ip, entry);
    }
    entry.count += 1;
    if (entry.count > maxPerMinute) {
      return res.status(429).json({ error: 'You are sending requests too quickly. Please wait a minute.' });
    }
    next();
  };
}

const chatLimit = makeLimiter(30);
const imageLimit = makeLimiter(5);
const followupLimit = makeLimiter(30);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits behind a proxy, so req.ip is the visitor's address

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), microphone=(self)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '30mb' }));

// Only these files are public. server.js, package.json and node_modules are never served.
const PUBLIC_FILES = new Set(['index.html', 'styles.css', 'app.js', 'logo.svg']);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/:file', (req, res, next) => {
  if (!PUBLIC_FILES.has(req.params.file)) return next();
  res.sendFile(path.join(__dirname, req.params.file));
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/api/chat', chatLimit, async (req, res) => {
  const body = req.body || {};
  const problem = validate(body.messages);
  if (problem) return res.status(400).json({ error: problem });
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'The server is missing its GROQ_API_KEY setting.' });

  const lastText = textOf(body.messages[body.messages.length - 1]);

  // Abuse: after three abusive messages the conversation ends. Warnings come first.
  const strikes = abuseStrikes(body.messages);
  if (strikes >= 3) return sendCanned(res, 'ended', ENDED);
  if (ABUSE.test(lastText)) return sendCanned(res, 'warning', strikes === 1 ? WARN_FIRST : WARN_LAST);

  // Someone who may be at risk gets support, not a model answer.
  if (SELF_HARM.test(lastText)) return sendCanned(res, 'support', CRISIS_MESSAGE);

  // Dangerous or illegal requests are refused before any model runs.
  const refusal = safetyCheck(lastText);
  if (refusal) return sendCanned(res, 'refused', refusal);

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

// Image creation uses a separate image provider (OpenAI). Groq can't create images.
app.post('/api/image', imageLimit, async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(501).json({ error: 'Image creation is not set up yet. The server needs an OPENAI_API_KEY.' });
  }
  const prompt = String(req.body?.prompt || '').trim().slice(0, MAX_IMAGE_PROMPT);
  if (!prompt) return res.status(400).json({ error: 'Describe the image you want.' });

  const refusal = safetyCheck(prompt);
  if (refusal) return res.status(400).json({ error: refusal });

  try {
    const upstream = await fetch(IMAGE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: '1024x1024', n: 1 }),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('Image request failed:', upstream.status, JSON.stringify(data).slice(0, 300));
      return res.status(502).json({ error: 'The image could not be created. Try a different description.' });
    }
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return res.status(502).json({ error: 'The image could not be created. Please try again.' });
    res.json({ image: `data:image/png;base64,${b64}` });
  } catch (err) {
    console.error('Image request error:', err.message);
    res.status(502).json({ error: 'The image service could not be reached. Please try again.' });
  }
});

// Short follow-up suggestions shown under each answer.
app.post('/api/followups', followupLimit, async (req, res) => {
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

// Errors never send stack traces or internal details to the browser.
app.use((err, req, res, next) => {
  console.error('Request error:', err.message);
  res.status(err.status || 500).json({
    error: err.status === 413 ? 'That upload is too large.' : 'Something went wrong. Please try again.',
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Qrox is running on port ${PORT}`);
  if (!GROQ_API_KEY) console.warn('Warning: GROQ_API_KEY is not set, so chat requests will fail.');
  if (!OPENAI_API_KEY) console.warn('Note: OPENAI_API_KEY is not set, so image creation is off.');
});
