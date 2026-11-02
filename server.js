// server.js: serves the Qrox site, runs chats through Groq, and keeps accounts and credits in Firebase.
const path = require('path');
const express = require('express');
const pdfParse = require('pdf-parse');
const admin = require('firebase-admin');

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Visitors never pick a model. The server chooses one for each role. Change them in Render's environment settings.
const MODELS = {
  thinker: process.env.TEXT_MODEL || 'openai/gpt-oss-120b',
  researcher: process.env.SEARCH_MODEL || 'groq/compound',
  coder: process.env.CODE_MODEL || process.env.TEXT_MODEL || 'openai/gpt-oss-120b',
  creative: process.env.TEXT_MODEL || 'openai/gpt-oss-120b',
  verifier: process.env.TEXT_MODEL || 'openai/gpt-oss-120b',
  vision: process.env.VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
};

// Firebase Admin. The service account JSON lives in Render's environment settings, never in the code.
let db = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    db = admin.firestore();
  } catch (err) {
    console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON:', err.message);
  }
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Credit rules. The server is the only place that charges, so these numbers can't be changed from the browser.
const CREDITS = {
  start: 1000000,
  reply: 34,
  coding: 500,
  bigReply: 1000,        // added to a reply of BIG_REPLY_CHARS characters or more
  image: 90,             // reserved for image creation (not built yet)
  smallFile: 80,         // reserved for file creation (not built yet)
  bigFile: 2000,         // reserved for file creation (not built yet)
  idleDrip: 200,         // added every hour an account goes unused
  idleCeiling: 1000000,  // idle credits stop at this balance (change it if you want a different limit)
  emptyWait: 3 * HOUR,
  emptyRefill: 9000,
};
const BIG_REPLY_CHARS = 3000;
const STRIKES_TO_END = 3;  // abusive messages before a conversation ends
const BLOCK_MS = HOUR;     // chats are paused this long after a conversation ends for abuse

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

const SAFETY_RULES = 'Refuse requests that could seriously hurt people: weapons or explosives, making drugs, malware or hacking other people, sexual content involving minors, and harassment. Keep refusals short and offer a safer alternative when there is one.';

const AGE_RULES = {
  under13: 'The user is under 13. Use simple, kind, child-friendly language. Do not discuss violence, drugs, dating or other adult topics. Never ask for personal details such as a full name, address, school or phone number. If they seem upset or unsafe, encourage them to talk to a trusted adult.',
  teen: 'The user is a teenager (13 to 17). Keep answers age-appropriate. Avoid sexual content, graphic violence and instructions for drugs or weapons. If they mention being in danger, encourage them to talk to a trusted adult or call emergency services.',
  adult: 'Be frank and helpful on adult topics, but always follow the safety rules.',
};

// What each age tier may use. "unknown" (age not set yet) gets the teen settings as the safe default.
const POLICY = {
  under13: { rules: AGE_RULES.under13, webSearch: false, memory: false },
  teen: { rules: AGE_RULES.teen, webSearch: true, memory: true },
  adult: { rules: AGE_RULES.adult, webSearch: true, memory: true },
  unknown: { rules: AGE_RULES.teen, webSearch: true, memory: true },
};

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

const REFUSAL = "I can't help with that. It could seriously hurt people, so I won't provide it. If you're working on something safe and legal, tell me more and I'll help where I can.";
const SUPPORT = "I'm sorry you're feeling this way. You don't have to handle it alone. If you might act on these thoughts, or you are in danger, call your local emergency number now (112 in Europe). You can find free support lines in your country at findahelpline.com. Would you like to tell me what's going on?";
const ENDED_TEXT = 'This conversation has ended because of repeated abusive messages. Chats are paused for one hour, after which you can start a new one. Please keep things respectful.';
const warningText = (n) => `Please keep things respectful. I'm happy to keep helping. (Warning ${n} of ${STRIKES_TO_END - 1}.)`;

// Simple rules that run before any model call.
const CODE_HINT = /\b(code|function|script|bug|error|python|javascript|typescript|java|html|css|sql|api|website|webpage|regex|compile|debug|program|algorithm)\b|```/i;
const CREATIVE_HINT = /\b(poem|story|song|lyrics|slogan|brainstorm|ideas?|creative|imagine that)\b/i;
const RESEARCH_HINT = /\b(latest|today|news|current|price|weather|this (week|year)|recent|who won|search)\b/i;
const DEEP_HINT = /\b(why|prove|compare|analy[sz]e|step|plan|derive|calculate|tradeoffs?|design)\b/i;

// Requests that are refused outright, before the model sees them.
const DANGEROUS_PATTERNS = [
  /\b(make|build|assemble|construct|synthesi[sz]e|manufacture|3d[- ]?print)\b[^.?!]{0,40}\b(bomb|explosive|detonator|nerve agent|sarin|ricin|chemical weapon|biological weapon|nuclear weapon|ghost gun|untraceable gun)\b/i,
  /\b(synthesi[sz]e|cook|produce|make)\b[^.?!]{0,30}\b(meth|methamphetamine|fentanyl|heroin|cocaine|mdma)\b/i,
  /\b(write|build|create|code|make)\b[^.?!]{0,30}\b(ransomware|keylogger|malware|botnet|credential[- ]stealer)\b/i,
  /\b(sexual|nude|naked|porn\w*|explicit)\b[^.?!]{0,40}\b(child|children|minor|underage|kid|kids|teen)\b/i,
  /\b(child|children|minor|underage|kid|kids|teen)\b[^.?!]{0,40}\b(sexual|nude|naked|porn\w*|explicit)\b/i,
  /\b(how (do|can|to)|best way to)\b[^.?!]{0,30}\b(kill|murder|poison|stab)\b[^.?!]{0,30}\b(someone|people|a person|my|him|her|them)\b/i,
];
const SELF_HARM = /\b(kill myself|end my life|want to die|suicide|hurt myself|self[- ]harm)\b/i;

// Abuse: threats, or swearing and insults aimed at Qrox.
const THREAT = /\b(i('| a)?ll|i will|i'm going to|gonna)\s+(kill|hurt|beat|stab|shoot|find)\s+(you|u)\b|\bkys\b/i;
const PROFANITY = /\b(f+u+c+k+\w*|s+h+i+t+\w*|b+i+t+c+h+\w*|a+s+s+h+o+l+e+s?|bastard|cunt|dickhead|dumbass)\b/i;
const INSULT = /\b(idiot|stupid|moron|dumb|trash|worthless|pathetic|loser|useless|shut up|nobody likes you|go away)\b/i;
const DIRECTED = /\b(you|you're|youre|u|ur|your|you are)\b/i;

function screenText(text) {
  if (DANGEROUS_PATTERNS.some((p) => p.test(text))) return 'dangerous';
  if (SELF_HARM.test(text)) return 'selfharm';
  if (THREAT.test(text)) return 'abuse';
  if ((PROFANITY.test(text) || INSULT.test(text)) && DIRECTED.test(text)) return 'abuse';
  return null;
}

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

function buildSystemPrompt(role, settings, tier, memories) {
  const parts = [HONESTY, SAFETY_RULES, POLICY[tier].rules, ROLE_RULES[role], PERSONALITIES[settings.personality], LEVELS[settings.level]];
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

  if (imageParts.length === 0) return { role: 'user', content: text || 'Please look at the attached file(s).' };
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

// ---------- Accounts and credits ----------
function newProfile(now) {
  return {
    credits: CREDITS.start,
    ageTier: 'unknown',
    dob: null,
    createdAt: now,
    dripAt: now + HOUR,      // idle drip starts one hour after the last activity
    refillAt: null,          // set when the balance runs out
    strikes: 0,
    strikeWindowStart: now,
    blockedUntil: 0,
  };
}

// Idle drip: while the account is unused, add credits every hour, up to the ceiling.
function accrue(user, now) {
  let steps = 0;
  while (user.dripAt && user.dripAt <= now && user.credits < CREDITS.idleCeiling && steps < 1000) {
    user.credits = Math.min(CREDITS.idleCeiling, user.credits + CREDITS.idleDrip);
    user.dripAt += HOUR;
    steps += 1;
  }
  if (user.credits >= CREDITS.idleCeiling) user.dripAt = null;
}

function refillIfDue(user, now) {
  if (user.refillAt && now >= user.refillAt) {
    user.credits += CREDITS.emptyRefill;
    user.refillAt = null;
  }
}

// Every change to a profile goes through a Firestore transaction, so two requests can't spend the same credits.
async function updateProfile(uid, change) {
  const ref = db.collection('users').doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const user = snap.exists ? snap.data() : newProfile(now);
    accrue(user, now);
    refillIfDue(user, now);
    const result = change(user, now);
    tx.set(ref, user);
    return result;
  });
}

// Checks a chat message before the model is called, and charges credits when it can run.
function reserve(user, now, { abusive, cost }) {
  if (user.blockedUntil > now) {
    return { kind: 'blocked', status: 423, error: 'Chats are paused for a while after repeated abuse.', retryMs: user.blockedUntil - now };
  }
  if (abusive) {
    if (now - user.strikeWindowStart > DAY) {
      user.strikeWindowStart = now;
      user.strikes = 0;
    }
    user.strikes += 1;
    if (user.strikes >= STRIKES_TO_END) {
      user.strikes = 0;
      user.blockedUntil = now + BLOCK_MS;
      return { kind: 'ended', text: ENDED_TEXT };
    }
    return { kind: 'warning', text: warningText(user.strikes) };
  }
  if (user.credits < cost) {
    if (!user.refillAt) user.refillAt = now + CREDITS.emptyWait;
    return {
      kind: 'empty',
      status: 402,
      error: 'Your balance is empty. Please wait 3 hours to get 9,000 credits.',
      retryMs: user.refillAt - now,
    };
  }
  user.credits -= cost;
  user.dripAt = now + HOUR;
  return { kind: 'ok', tier: user.dob ? user.ageTier : 'unknown' };
}

function summarize(user, now) {
  return {
    credits: user.credits,
    ageTier: user.dob ? user.ageTier : 'unknown',
    needsAge: !user.dob,
    username: user.username || null,
    email: user.email || null,
    refillInMs: user.refillAt ? Math.max(0, user.refillAt - now) : 0,
    blockedInMs: user.blockedUntil > now ? user.blockedUntil - now : 0,
  };
}

// Age groups come from a date of birth. No photos, faces or ID documents are collected.
function tierFor(dob, now) {
  const birth = new Date(`${dob}T00:00:00Z`);
  const today = new Date(now);
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  const birthdayPassed = today.getUTCMonth() > birth.getUTCMonth()
    || (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() >= birth.getUTCDate());
  if (!birthdayPassed) age -= 1;
  if (age < 13) return 'under13';
  if (age < 18) return 'teen';
  return 'adult';
}

function validDob(dob, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return false;
  const d = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dob) return false;
  if (d.getTime() > now) return false;
  return now - d.getTime() < 121 * 365.25 * DAY;
}

// ---------- Security ----------
const CSP = [
  "default-src 'self'",
  // 'unsafe-eval' is needed for the Code Lab's JavaScript runner. 'wasm-unsafe-eval' is needed for Python (Pyodide).
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://www.gstatic.com https://apis.google.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.googleapis.com https://*.firebaseapp.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://apis.google.com https://accounts.google.com https://cdn.jsdelivr.net https://www.gstatic.com",
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "frame-src 'self' blob: https://*.firebaseapp.com https://accounts.google.com",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const limits = { ip: new Map(), user: new Map() };
const WINDOW_MS = 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const map of Object.values(limits)) {
    for (const [key, entry] of map) {
      if (entry.start < cutoff) map.delete(key);
    }
  }
}, WINDOW_MS).unref();

function overLimit(map, key, max) {
  const now = Date.now();
  let entry = map.get(key);
  if (!entry || now - entry.start > WINDOW_MS) {
    entry = { start: now, count: 0 };
    map.set(key, entry);
  }
  entry.count += 1;
  return entry.count > max;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits behind a proxy, so req.ip is the visitor's address
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  next();
});
app.use(express.json({ limit: '30mb' }));

// Only these files are public. server.js, package.json, firestore.rules and node_modules are never served.
const PUBLIC_FILES = new Set(['index.html', 'styles.css', 'app.js', 'logo.svg']);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/:file', (req, res, next) => {
  if (!PUBLIC_FILES.has(req.params.file)) return next();
  res.sendFile(path.join(__dirname, req.params.file));
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

function ipLimit(req, res, next) {
  if (overLimit(limits.ip, req.ip, 60)) return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  next();
}

function userLimit(req, res, next) {
  if (overLimit(limits.user, req.uid, 40)) return res.status(429).json({ error: 'You are sending messages too quickly. Please wait a minute.' });
  next();
}

app.use('/api', ipLimit);

// Checks the Firebase sign-in token on every account request. Visitors can't call the API without signing in.
async function requireUser(req, res, next) {
  if (!db) return res.status(503).json({ error: 'Accounts are not set up on the server yet.' });
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!match) return res.status(401).json({ error: 'Please sign in to use Qrox.' });
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.uid = decoded.uid;
    req.email = decoded.email || '';
  } catch {
    return res.status(401).json({ error: 'Your sign-in has expired. Please sign in again.' });
  }
  next();
}

function sendFixed(res, text, role, flags = {}) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Qrox-Role', role);
  if (flags.ended) res.setHeader('X-Qrox-Ended', '1');
  if (flags.warning) res.setHeader('X-Qrox-Warning', '1');
  res.end(text);
}

// ---------- Routes ----------
app.get('/api/me', requireUser, async (req, res) => {
  try {
    res.json(await updateProfile(req.uid, (user, now) => summarize(user, now)));
  } catch (err) {
    console.error('Could not load profile:', err.message);
    res.status(500).json({ error: 'Account storage is unavailable right now.' });
  }
});

// Usernames sign in through a hidden account email (username@users.qrox.bbroot.com). Nothing is ever sent there.
const ACCOUNT_DOMAIN = 'users.qrox.bbroot.com';
const RESERVED_USERNAMES = new Set(['admin', 'administrator', 'qrox', 'bbroot', 'support', 'moderator', 'mod', 'root', 'system', 'help']);
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Sign-up: saves the username, birthday and optional email from the sign-up form.
// The username must match the account the visitor just created, so nobody can claim someone else's name.
app.post('/api/profile', requireUser, async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const dob = typeof req.body?.dob === 'string' ? req.body.dob.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const now = Date.now();

  if (!USERNAME_RE.test(username) || RESERVED_USERNAMES.has(username)) {
    return res.status(400).json({ error: 'Usernames are 3 to 20 letters, numbers or underscores, and some names are reserved.' });
  }
  const [accountName, accountDomain] = String(req.email || '').split('@');
  if (accountDomain !== ACCOUNT_DOMAIN || accountName !== username) {
    return res.status(400).json({ error: 'That username does not match this account.' });
  }
  if (!validDob(dob, now)) return res.status(400).json({ error: 'Enter a real date of birth.' });
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) {
    return res.status(400).json({ error: 'That email address does not look right.' });
  }

  try {
    const result = await updateProfile(req.uid, (user) => {
      if (user.dob) return { ok: false, status: 409, error: 'This account already has its details set.' };
      user.username = username;
      user.email = email || null;
      user.dob = dob;
      user.ageTier = tierFor(dob, now);
      user.ageSetAt = now;
      return { ok: true, ageTier: user.ageTier };
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ageTier: result.ageTier });
  } catch (err) {
    console.error('Could not save profile:', err.message);
    res.status(500).json({ error: 'Account storage is unavailable right now.' });
  }
});

app.post('/api/age', requireUser, async (req, res) => {
  const dob = typeof req.body?.dob === 'string' ? req.body.dob.trim() : '';
  const now = Date.now();
  if (!validDob(dob, now)) return res.status(400).json({ error: 'Enter a real date of birth.' });

  try {
    const result = await updateProfile(req.uid, (user) => {
      if (user.dob) {
        return { ok: false, status: 409, error: 'Your age is already set. Use "Report a wrong age" to ask for a correction.' };
      }
      user.dob = dob;
      user.ageTier = tierFor(dob, now);
      user.ageSetAt = now;
      return { ok: true, ageTier: user.ageTier };
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ageTier: result.ageTier });
  } catch (err) {
    console.error('Could not save age:', err.message);
    res.status(500).json({ error: 'Account storage is unavailable right now.' });
  }
});

app.post('/api/chat', requireUser, userLimit, async (req, res) => {
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'The server is missing its GROQ_API_KEY setting.' });

  const body = req.body || {};
  const problem = validate(body);
  if (problem) return res.status(400).json({ error: problem });

  const lastText = textOf(body.messages[body.messages.length - 1]);
  const screen = screenText(lastText);
  if (screen === 'dangerous') return sendFixed(res, REFUSAL, 'safety');
  if (screen === 'selfharm') return sendFixed(res, SUPPORT, 'safety');

  const mode = ['auto', 'code', 'verify'].includes(body.mode) ? body.mode : 'auto';
  const cost = mode === 'code' || CODE_HINT.test(lastText) ? CREDITS.coding : CREDITS.reply;

  let result;
  try {
    result = await updateProfile(req.uid, (user, now) => reserve(user, now, { abusive: screen === 'abuse', cost }));
  } catch (err) {
    console.error('Could not reserve credits:', err.message);
    return res.status(500).json({ error: 'Account storage is unavailable right now. Please try again.' });
  }

  if (result.kind === 'blocked' || result.kind === 'empty') {
    return res.status(result.status).json({ error: result.error, retryMs: result.retryMs });
  }
  if (result.kind === 'warning') return sendFixed(res, result.text, 'safety', { warning: true });
  if (result.kind === 'ended') return sendFixed(res, result.text, 'safety', { ended: true });

  const refund = () => updateProfile(req.uid, (user) => { user.credits += cost; return {}; })
    .catch((err) => console.error('Could not refund credits:', err.message));

  const policy = POLICY[result.tier] || POLICY.unknown;
  const webSearch = body.webSearch === true && policy.webSearch;
  const role = pickRole(mode, webSearch, lastText);
  const settings = readSettings(body.settings);
  const memories = policy.memory ? readMemories(body.memories) : [];

  let model;
  let payload;
  let tooLarge = false;
  try {
    const kept = body.messages.filter((m) => m.role === 'user' || String(m.content || '').trim() !== '');
    const converted = await Promise.all(kept.map(toGroqMessage));
    const hasImages = converted.some((m) => Array.isArray(m.content));
    model = hasImages ? MODELS.vision : MODELS[role];
    payload = {
      model,
      messages: [{ role: 'system', content: buildSystemPrompt(role, settings, result.tier, memories) }, ...converted],
      stream: true,
      max_completion_tokens: MAX_TOKENS,
    };
    if (model.startsWith('openai/gpt-oss')) payload.reasoning_effort = reasoningEffort(role, lastText);
    tooLarge = hasImages && Buffer.byteLength(JSON.stringify(payload)) > MAX_VISION_REQUEST_BYTES;
  } catch (err) {
    console.error('Could not read the message:', err.message);
    await refund();
    return res.status(400).json({ error: 'Could not read one of the attachments.' });
  }
  if (tooLarge) {
    await refund();
    return res.status(413).json({ error: 'That request is too large for the image model. Try smaller images or start a new chat.' });
  }

  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  let upstream;
  try {
    upstream = await callGroq(payload, abort.signal);
  } catch (err) {
    await refund();
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

  let outChars = 0;
  try {
    await streamTokens(upstream.body, (piece) => {
      outChars += piece.length;
      res.write(piece);
    });
  } catch (err) {
    console.error('Stream interrupted:', err.message);
    if (!abort.signal.aborted) res.write('\n\n*Sorry, the reply was cut off. Please try again.*');
  } finally {
    res.end();
  }

  // Long replies cost extra. This is charged after the reply, once its length is known.
  if (outChars >= BIG_REPLY_CHARS) {
    updateProfile(req.uid, (user, now) => {
      user.credits = Math.max(0, user.credits - CREDITS.bigReply);
      user.dripAt = now + HOUR;
      return {};
    }).catch((err) => console.error('Could not charge a long reply:', err.message));
  }
});

// Short follow-up suggestions under each answer. They cost no credits, but they still need a sign-in.
app.post('/api/followups', requireUser, async (req, res) => {
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
  if (!db) console.warn('Warning: FIREBASE_SERVICE_ACCOUNT is not set, so sign-in and credits are unavailable.');
});
