// app.js: Qrox front end
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

// Firebase web config. These values are public by design. Security comes from the server checks and the
// Firestore rules. Analytics is left out until the site has a cookie consent banner.
const firebaseConfig = {
  apiKey: 'AIzaSyBhIDOVSEv-AON7Pr-37q64KUoq7f5Vrb4',
  authDomain: 'qrox-a82ff.firebaseapp.com',
  projectId: 'qrox-a82ff',
  storageBucket: 'qrox-a82ff.firebasestorage.app',
  messagingSenderId: '128139138869',
  appId: '1:128139138869:web:d0a7216fbd00ffc2e55e7c',
};
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

(() => {
  'use strict';

  // ---------- Settings ----------
  const THINK_MS = 4000; // replies appear after at least this long. Set to 0 to remove the wait.
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024; // Groq allows 4 MB per request, and base64 adds about a third
  const MAX_TEXT_CHARS = 150000;
  const MAX_IMAGES = 5;
  const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const TEXT_EXT = /\.(txt|md|csv|tsv|json|js|jsx|ts|tsx|py|html|css|xml|yml|yaml|sql|java|c|h|cpp|go|rs|rb|php|sh|log)$/i;
  const MEMORY_RE = /^\s*(?:please\s+)?remember(?:\s+that|\s+this)?\s*[:,-]?\s+(.{3,300})$/i;
  const RUNNABLE = { javascript: 'javascript', js: 'javascript', python: 'python', py: 'python', html: 'html', css: 'css' };
  const ROLE_NAMES = { thinker: 'Thinker', researcher: 'Researcher', coder: 'Code Bot', creative: 'Creative', verifier: 'Verifier' };
  const DOUBLE_CHECK = 'Double-check your previous answer for mistakes. Correct anything that is wrong, and say clearly what you are not sure about.';
  const SUPPORT_EMAIL = 'bbrootorg@gmail.com';
  const ACCOUNT_DOMAIN = 'users.qrox.bbroot.com';   // hidden account email domain; nothing is sent there
  const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
  let signingUp = false;                            // stops the age prompt from opening during sign-up
  const CREDIT_CEILING = 1000000;
  const AGE_LABELS = { unknown: 'Age not set', under13: 'Under 13', teen: 'Teen (13–17)', adult: 'Adult (18+)' };
  const KEYS = {
    chats: 'qrox.chats.v2',
    drafts: 'qrox.drafts.v2',
    memories: 'qrox.memories.v2',
    workspaces: 'qrox.workspaces.v2',
    prefs: 'qrox.prefs.v2',
  };
  const DEFAULT_PREFS = {
    search: false, code: false, personality: 'balanced', level: 'auto', memoryOn: true, workspace: null,
    voiceReplies: false, voiceName: '', rate: 1,
  };
  const SUGGESTIONS = [
    { label: 'Explain simply', prompt: 'Explain how the internet works, as if I were ten years old.', send: true },
    { label: 'Write code', prompt: 'Write a small Python script that renames photos in a folder by the date they were taken.', send: true },
    { label: 'Improve my writing', prompt: 'Rewrite this to sound clearer and more professional: ', send: false },
    { label: 'Plan something', prompt: 'Plan a relaxed three-day city break in Lisbon with a daily itinerary.', send: true },
  ];
  const SpeechApi = window.SpeechRecognition || window.webkitSpeechRecognition;

  // Runs JavaScript in a Web Worker, so an endless loop can't freeze the page.
  const JS_WORKER = `
self.onmessage = (e) => {
  const show = (args) => args.map((a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a) ?? String(a); } catch (err) { return String(a); }
  }).join(' ');
  const out = (text) => self.postMessage({ type: 'out', text });
  console.log = (...a) => out(show(a));
  console.info = console.log;
  console.warn = console.log;
  console.error = console.log;
  try {
    const result = (0, eval)(e.data);
    if (result !== undefined) out('=> ' + show([result]));
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', text: String(err) });
  }
};`;

  // Runs Python with Pyodide in a Web Worker. Loaded from jsDelivr the first time it is used.
  const PY_WORKER = `
importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');
let pyodideReady = null;
self.onmessage = async (e) => {
  const out = (text) => self.postMessage({ type: 'out', text });
  try {
    if (!pyodideReady) pyodideReady = loadPyodide({ stdout: out, stderr: out });
    const py = await pyodideReady;
    await py.runPythonAsync(e.data);
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', text: String(err) });
  }
};`;

  const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON = {
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'),
    up: svg('<path d="M7 11v9H4v-9z"/><path d="M7 11l4-7a2 2 0 0 1 2 2v3h6.2a2 2 0 0 1 2 2.3l-1.3 7.3A2 2 0 0 1 17.9 20H7"/>'),
    down: svg('<path d="M17 13V4h3v9z"/><path d="M17 13l-4 7a2 2 0 0 1-2-2v-3H5.8a2 2 0 0 1-2-2.3l1.3-7.3A2 2 0 0 1 7.1 4H17"/>'),
    translate: svg('<path d="M4 5h9M9 3v2M6 5c.6 3 2.6 5.5 6 7M13 5c-.6 3-2.6 5.5-6 7"/><path d="M13 21l4-9 4 9M14.5 18h5"/>'),
    regen: svg('<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>'),
    check: svg('<circle cx="12" cy="12" r="9"/><path d="M9 12l2 2 4-4"/>'),
    edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>'),
    trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
    arrow: svg('<path d="M7 7l10 10"/><path d="M17 9v8H9"/>'),
    pin: svg('<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z"/><path d="M12 14v6"/>'),
    speak: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6"/>'),
  };
  const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5l2.6 7.9 7.9 2.6-7.9 2.6L12 22.5l-2.6-7.9-7.9-2.6 7.9-2.6z" fill="#fff"/></svg>';

  const $ = (id) => document.getElementById(id);
  const els = {
    app: $('app'), scrim: $('scrim'), toast: $('toast'),
    signin: $('signin'), tabLogin: $('tabLogin'), tabSignup: $('tabSignup'), loginForm: $('loginForm'), signupForm: $('signupForm'),
    loginUser: $('loginUser'), loginPass: $('loginPass'), loginError: $('loginError'),
    signupUser: $('signupUser'), signupPass: $('signupPass'), signupPass2: $('signupPass2'), signupDob: $('signupDob'),
    signupEmail: $('signupEmail'), signupError: $('signupError'),
    account: $('account'), accountLabel: $('accountLabel'), creditsText: $('creditsText'),
    creditBar: $('creditBar'), refill: $('refill'), ageLabel: $('ageLabel'), ageBtn: $('ageBtn'), signOutBtn: $('signOutBtn'),
    notice: $('notice'), noticeText: $('noticeText'), noticeBtn: $('noticeBtn'),
    toggleSidebar: $('toggleSidebar'), collapseBtn: $('collapseBtn'), searchNav: $('searchNav'), newChat: $('newChat'),
    labNav: $('labNav'), memoryNav: $('memoryNav'), settingsNav: $('settingsNav'),
    addWorkspace: $('addWorkspace'), workspaceList: $('workspaceList'), chatSearch: $('chatSearch'), chatList: $('chatList'),
    messages: $('messages'), thread: $('thread'), jump: $('jumpBtn'),
    form: $('composer'), input: $('input'), send: $('sendBtn'), attachBtn: $('attachBtn'), fileInput: $('fileInput'),
    attachments: $('attachments'), mic: $('micBtn'), wave: $('wave'), search: $('searchToggle'), code: $('codeToggle'),
    roleLabel: $('roleLabel'), exportBtn: $('exportBtn'), helpBtn: $('helpBtn'),
    shortcuts: $('shortcuts'), closeShortcuts: $('closeShortcuts'),
    settings: $('settings'), closeSettings: $('closeSettings'), personality: $('personality'), level: $('level'),
    memoryOn: $('memoryOn'), voiceReplies: $('voiceReplies'), voiceSelect: $('voiceSelect'), rate: $('rate'), wipeData: $('wipeData'),
    memory: $('memoryDialog'), closeMemory: $('closeMemory'), memoryForm: $('memoryForm'), memoryInput: $('memoryInput'),
    memoryList: $('memoryList'), clearMemories: $('clearMemories'),
    lab: $('lab'), labLang: $('labLang'), labCode: $('labCode'), labRun: $('labRun'), labCopy: $('labCopy'),
    labClose: $('labClose'), labOutput: $('labOutput'), labPreview: $('labPreview'),
    ageDialog: $('ageDialog'), ageForm: $('ageForm'), dob: $('dob'), ageResult: $('ageResult'),
    verifyBtn: $('verifyBtn'), verifyStatus: $('verifyStatus'),
    reportAge: $('reportAge'), closeAge: $('closeAge'),
  };

  // ---------- State ----------
  let prefs = { ...DEFAULT_PREFS };
  let chats = [];
  let memories = [];
  let workspaces = [];
  let drafts = {};
  let user = null;          // signed-in Firebase user
  let profile = null;       // account summary from the server
  let currentId = null;     // open chat, or null for a fresh one
  let pending = [];         // files attached to the message being written
  let busy = false;         // true while a reply is in progress
  let controller = null;    // cancels the reply in progress
  let draftTimer = null;
  let toastTimer = null;
  let talking = false;      // hands-free talk mode
  let talkBuffer = '';
  let talkTimer = null;
  let speaking = false;     // Qrox is reading a reply aloud
  let rec = null;           // speech recognition instance
  let voices = [];
  let ageAsked = false;

  const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
  const currentChat = () => chats.find((c) => c.id === currentId) || null;
  const draftKey = () => currentId || 'new';
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------- Storage (chats and memories are kept per account on this device) ----------
  function loadJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value ?? fallback;
    } catch {
      return fallback;
    }
  }

  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage is full or unavailable. The app keeps working for this session.
    }
  }

  function scopedKey(name) {
    return `${KEYS[name]}.${user ? user.uid : 'guest'}`;
  }

  function loadUserData() {
    chats = loadJson(scopedKey('chats'), []);
    if (!Array.isArray(chats)) chats = [];
    memories = loadJson(scopedKey('memories'), []);
    workspaces = loadJson(scopedKey('workspaces'), []);
    drafts = loadJson(scopedKey('drafts'), {});
    currentId = null;
    pending = [];
  }

  function saveChats() {
    // Image and PDF data stays in memory only, so storage isn't filled with large files.
    const slim = chats.map((c) => ({ ...c, messages: c.messages.map(({ media, ...rest }) => rest) }));
    saveJson(scopedKey('chats'), slim);
  }

  function saveMemories() { saveJson(scopedKey('memories'), memories); }
  function saveWorkspaces() { saveJson(scopedKey('workspaces'), workspaces); }
  function savePrefs() { saveJson(KEYS.prefs, prefs); }

  function persistDrafts() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => saveJson(scopedKey('drafts'), drafts), 300);
  }

  function storeDraft() {
    const key = draftKey();
    if (els.input.value) drafts[key] = els.input.value;
    else delete drafts[key];
    persistDrafts();
  }

  function restoreDraft() {
    els.input.value = drafts[draftKey()] || '';
    autoResize();
    updateSendState();
  }

  // ---------- Markdown and code ----------
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  if (window.DOMPurify) {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }

  function renderMarkdown(text) {
    if (!window.marked || !window.DOMPurify) return escapeHtml(text).replace(/\n/g, '<br>');
    return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }));
  }

  // Adds Copy (and Run, for runnable languages) buttons to each code block.
  function decorateCode(root) {
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.code-tools')) return;
      const codeEl = pre.querySelector('code');
      const lang = (codeEl?.className.match(/language-([\w+-]+)/) || [])[1]?.toLowerCase() || '';
      const tools = el('div', 'code-tools');

      const copy = el('button', '', 'Copy');
      copy.type = 'button';
      copy.addEventListener('click', () => copyText(codeEl?.textContent ?? pre.textContent, 'Code copied'));
      tools.append(copy);

      if (RUNNABLE[lang]) {
        const run = el('button', 'run', 'Run');
        run.type = 'button';
        run.addEventListener('click', () => openLab(codeEl?.textContent ?? '', RUNNABLE[lang]));
        tools.append(run);
      }
      pre.append(tools);
    });
  }

  // ---------- Feedback ----------
  function showToast(message, duration = 2200) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), duration);
  }

  async function copyText(text, message = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = el('textarea');
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    showToast(message);
  }

  // ---------- Voice: read-aloud ----------
  // Removes markdown symbols and replaces code blocks, so the voice reads naturally.
  function speakable(markdown) {
    return markdown
      .replace(/```[\s\S]*?```/g, ' (code example) ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'link')
      .replace(/[*_#>|~-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);
  }

  function loadVoices() {
    if (!('speechSynthesis' in window)) return;
    voices = speechSynthesis.getVoices();
    els.voiceSelect.innerHTML = '';
    for (const v of voices) {
      const option = el('option', '', `${v.name} (${v.lang})`);
      option.value = v.name;
      els.voiceSelect.append(option);
    }
    els.voiceSelect.value = prefs.voiceName || voices.find((v) => v.lang.startsWith('en'))?.name || voices[0]?.name || '';
  }

  function speak(markdown, onDone) {
    if (!('speechSynthesis' in window)) {
      showToast('Read-aloud is not supported in this browser.', 3000);
      return;
    }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(speakable(markdown));
    const chosen = voices.find((v) => v.name === prefs.voiceName);
    if (chosen) {
      utterance.voice = chosen;
      utterance.lang = chosen.lang;
    }
    utterance.rate = prefs.rate || 1;
    utterance.pitch = 1.05;
    const finish = () => {
      speaking = false;
      if (onDone) onDone();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    speaking = true;
    speechSynthesis.speak(utterance);
  }

  function stopSpeaking() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    speaking = false;
  }

  function toggleSpeak(text) {
    if (speaking) stopSpeaking();
    else speakReply(text);
  }

  // Pauses listening while Qrox talks, so it doesn't hear itself.
  function speakReply(text) {
    const wasTalking = talking;
    if (wasTalking) {
      try { rec?.stop(); } catch { /* not running */ }
    }
    speak(text, () => {
      if (wasTalking && talking) {
        try { rec?.start(); } catch { /* already running */ }
      }
    });
  }

  // ---------- Voice: talk to Qrox (hands-free) ----------
  function ensureRec() {
    if (rec || !SpeechApi) return rec;
    rec = new SpeechApi();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';

    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const piece = e.results[i][0].transcript;
        if (e.results[i].isFinal) talkBuffer += piece + ' ';
        else interim += piece;
      }
      els.input.value = (talkBuffer + interim).trim();
      autoResize();
      updateSendState();
      clearTimeout(talkTimer);
      talkTimer = setTimeout(sendTalk, 1400); // send after a short pause
    };

    rec.onend = () => {
      if (talking && !speaking) {
        try { rec.start(); } catch { /* already running */ }
      }
    };

    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        stopTalk();
        showToast('Microphone access is blocked for this site.', 3200);
      }
    };
    return rec;
  }

  function sendTalk() {
    const text = els.input.value.trim();
    talkBuffer = '';
    if (!text || busy) return; // if a reply is still coming, the text stays in the box
    els.input.value = '';
    autoResize();
    updateSendState();
    send({ text });
  }

  function startTalk() {
    if (!SpeechApi) {
      showToast('Voice input is not supported in this browser.', 3000);
      return;
    }
    if (!user) {
      showToast('Sign in to talk to Qrox.', 2600);
      return;
    }
    talking = true;
    talkBuffer = '';
    els.mic.classList.add('listening');
    els.wave.classList.remove('hidden');
    try { ensureRec().start(); } catch { /* already listening */ }
    showToast('Listening. Pause when you finish and Qrox will reply.', 3000);
  }

  function stopTalk() {
    talking = false;
    clearTimeout(talkTimer);
    talkBuffer = '';
    try { rec?.stop(); } catch { /* not running */ }
    els.mic.classList.remove('listening');
    els.wave.classList.add('hidden');
  }

  // ---------- Thinking star ----------
  // A small star flies while Qrox works. When the reply is done, it grows, pops and throws sparks.
  function startStar(turn) {
    const stage = el('div', 'stage');
    const star = el('div', 'star');
    star.innerHTML = STAR_SVG;
    stage.append(star);
    turn.append(stage);

    const t0 = performance.now();
    let frame = 0;
    const fly = (now) => {
      const t = (now - t0) / 1000;
      const x = 50 + 40 * Math.sin(t * 1.25) * Math.cos(t * 0.45);
      const y = 50 + 36 * Math.sin(t * 2.2 + 0.6);
      star.style.left = `${x}%`;
      star.style.top = `${y}%`;
      star.style.transform = `translate(-50%, -50%) rotate(${t * 120}deg)`;
      frame = requestAnimationFrame(fly);
    };
    frame = requestAnimationFrame(fly);
    return { stage, star, stop: () => cancelAnimationFrame(frame) };
  }

  function finishStar(handle) {
    if (!handle) return;
    handle.stop();
    handle.star.classList.add('pop');
    setTimeout(() => {
      for (let i = 0; i < 10; i++) {
        const spark = el('i', 'spark');
        const angle = (i / 10) * Math.PI * 2;
        spark.style.setProperty('--dx', `${Math.cos(angle) * 52}px`);
        spark.style.setProperty('--dy', `${Math.sin(angle) * 52}px`);
        handle.stage.append(spark);
      }
    }, 420);
    setTimeout(() => handle.stage.remove(), 1300);
  }

  // ---------- Account ----------
  // Every server call sends the Firebase sign-in token. The server checks it, so it can't be faked.
  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (auth.currentUser) headers.Authorization = `Bearer ${await auth.currentUser.getIdToken()}`;
    return fetch(path, { ...options, headers });
  }

  function formatMs(ms) {
    const minutes = Math.ceil(ms / 60000);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  async function loadProfile() {
    if (!user) {
      profile = null;
      renderAccount();
      return;
    }
    try {
      const res = await api('/api/me');
      if (res.ok) profile = await res.json();
      else if (res.status === 401) showToast('Your sign-in expired. Please sign in again.', 3200);
    } catch {
      // Offline: keep the last known profile.
    }
    renderAccount();
  }

  function renderAccount() {
    const signedIn = Boolean(user);
    els.signin.classList.toggle('hidden', signedIn);
    els.account.classList.toggle('hidden', !signedIn);
    els.accountLabel.textContent = signedIn ? `Account: ${profile?.username || 'Member'}` : 'Account: Guest';
    if (signedIn) {
      if (!profile) {
        els.creditsText.textContent = 'Loading…';
      } else {
        els.creditsText.textContent = `${profile.credits.toLocaleString()} credits`;
        els.creditBar.style.width = `${Math.min(100, (profile.credits / CREDIT_CEILING) * 100)}%`;
        els.ageLabel.textContent = (AGE_LABELS[profile.ageTier] || AGE_LABELS.unknown) + (profile.verified ? ' · verified' : '');
        els.refill.textContent = profile.refillInMs ? `Empty. You get 9,000 credits in ${formatMs(profile.refillInMs)}.` : '';
      }
    }
    renderNotice();
    updateSendState();
  }

  // Shows the reason a chat can't be used, or that the age still needs confirming.
  function renderNotice() {
    const chat = currentChat();
    let message = '';
    let showAgeButton = false;
    if (!user) {
      message = '';
    } else if (chat?.ended) {
      message = 'This conversation has ended because of repeated abusive messages. Start a new chat to continue.';
    } else if (profile?.blockedInMs) {
      message = `Chats are paused for ${formatMs(profile.blockedInMs)} after repeated abusive messages.`;
    } else if (profile?.needsAge) {
      message = 'Confirm your age to unlock your full experience. Until then, Qrox uses teen-safe settings.';
      showAgeButton = true;
    }
    els.notice.classList.toggle('hidden', !message);
    els.noticeText.textContent = message;
    els.noticeBtn.classList.toggle('hidden', !showAgeButton);
  }

  function openAge() {
    els.dob.max = new Date().toISOString().slice(0, 10);
    els.verifyBtn.disabled = Boolean(profile?.verified);
    els.verifyBtn.textContent = profile?.verified ? 'Verified' : 'Verify with ID';
    setVerifyStatus('');
    els.ageResult.textContent = '';
    const body = `My Qrox age group looks wrong.\nUsername: ${profile?.username || 'unknown'}\nWhat it should be: `;
    els.reportAge.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Qrox: wrong age group')}&body=${encodeURIComponent(body)}`;
    if (!els.ageDialog.open) els.ageDialog.showModal();
  }

  // ---------- Sidebar ----------
  function visibleChats() {
    const q = els.chatSearch.value.trim().toLowerCase();
    return chats.filter((c) => {
      if (prefs.workspace !== null && c.workspace !== prefs.workspace) return false;
      if (!q) return true;
      return c.title.toLowerCase().includes(q) || c.messages.some((m) => (m.text || '').toLowerCase().includes(q));
    });
  }

  function renderSidebar() {
    const list = visibleChats().sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
    els.chatList.innerHTML = '';
    if (list.length === 0) {
      els.chatList.append(el('p', 'empty-list', chats.length ? 'No chats match.' : 'Your chats will appear here.'));
      return;
    }

    list.forEach((chat, index) => {
      const row = el('div', 'chat-row' + (chat.id === currentId ? ' active' : ''));
      row.style.setProperty('--i', index);

      const open = el('button', 'chat-open', chat.title);
      open.type = 'button';
      open.title = chat.title;
      open.addEventListener('click', () => openChat(chat.id));

      const pin = el('button', 'chat-action' + (chat.pinned ? ' pinned-mark' : ''));
      pin.type = 'button';
      pin.title = chat.pinned ? 'Unpin chat' : 'Pin chat';
      pin.setAttribute('aria-label', pin.title);
      pin.innerHTML = ICON.pin;
      pin.addEventListener('click', (e) => { e.stopPropagation(); togglePin(chat.id); });

      const rename = el('button', 'chat-action');
      rename.type = 'button';
      rename.title = 'Rename chat';
      rename.setAttribute('aria-label', 'Rename chat');
      rename.innerHTML = ICON.edit;
      rename.addEventListener('click', (e) => { e.stopPropagation(); renameChat(chat.id); });

      const remove = el('button', 'chat-action');
      remove.type = 'button';
      remove.title = 'Delete chat';
      remove.setAttribute('aria-label', 'Delete chat');
      remove.innerHTML = ICON.trash;
      remove.addEventListener('click', (e) => { e.stopPropagation(); deleteChat(chat.id); });

      row.append(open, pin, rename, remove);
      els.chatList.append(row);
    });
  }

  function renderWorkspaces() {
    els.workspaceList.innerHTML = '';
    const all = el('button', 'workspace' + (prefs.workspace === null ? ' active' : ''), 'All chats');
    all.type = 'button';
    all.addEventListener('click', () => setWorkspace(null));
    els.workspaceList.append(all);

    for (const ws of workspaces) {
      const item = el('button', 'workspace' + (prefs.workspace === ws.id ? ' active' : ''), ws.name);
      item.type = 'button';
      item.title = 'Double-click to delete this workspace';
      item.addEventListener('click', () => setWorkspace(ws.id));
      item.addEventListener('dblclick', () => deleteWorkspace(ws.id));
      els.workspaceList.append(item);
    }
  }

  function setWorkspace(id) {
    prefs.workspace = id;
    savePrefs();
    renderWorkspaces();
    renderSidebar();
  }

  function addWorkspace() {
    const name = window.prompt('Name for the new workspace');
    if (!name || !name.trim()) return;
    const ws = { id: newId(), name: name.trim().slice(0, 40) };
    workspaces.push(ws);
    saveWorkspaces();
    setWorkspace(ws.id);
  }

  function deleteWorkspace(id) {
    const ws = workspaces.find((w) => w.id === id);
    if (!ws || !window.confirm(`Delete the workspace "${ws.name}"? Its chats stay in All chats.`)) return;
    workspaces = workspaces.filter((w) => w.id !== id);
    chats.forEach((c) => { if (c.workspace === id) c.workspace = null; });
    saveWorkspaces();
    saveChats();
    if (prefs.workspace === id) prefs.workspace = null;
    savePrefs();
    renderWorkspaces();
    renderSidebar();
  }

  // ---------- Conversation ----------
  // animateFrom: index of the first message to animate in. -1 keeps the current scroll position.
  function renderThread(animateFrom = -1) {
    const chat = currentChat();
    const msgs = chat ? chat.messages : [];
    const atBottom = isNearBottom();
    const scrollTop = els.messages.scrollTop;

    els.thread.innerHTML = '';
    els.thread.classList.toggle('is-empty', msgs.length === 0);
    if (msgs.length === 0) {
      renderGreeting();
    } else {
      msgs.forEach((m, i) => {
        const turn = buildTurn(m, i, msgs);
        if (animateFrom >= 0 && i >= animateFrom) turn.classList.add('enter');
        els.thread.append(turn);
      });
    }

    if (animateFrom >= 0 || atBottom) scrollToBottom();
    else els.messages.scrollTop = scrollTop;
    updateJump();
    updateRoleLabel();
  }

  function renderGreeting() {
    const hero = el('div', 'hero');
    const logo = el('img', 'hero-logo');
    logo.src = '/logo.svg';
    logo.alt = '';

    const row = el('div', 'suggestions');
    SUGGESTIONS.forEach((s, i) => {
      const chip = el('button', 'chip', s.label);
      chip.type = 'button';
      chip.style.setProperty('--i', i);
      chip.addEventListener('click', () => useSuggestion(s));
      row.append(chip);
    });

    hero.append(logo, el('h1', '', 'Welcome to QROX!'), el('p', 'hero-sub', 'How can I help you today?'), row);
    els.thread.append(hero);
  }

  function buildTurn(m, index, msgs) {
    const turn = el('div', `turn ${m.role}`);
    const bubble = el('div', `msg ${m.role}`);

    if (m.role === 'user') {
      if (m.thumbs?.length) {
        const row = el('div', 'thumbs');
        m.thumbs.forEach((src) => {
          const img = el('img');
          img.src = src;
          img.alt = 'Image you sent';
          row.append(img);
        });
        bubble.append(row);
      }
      if (m.text) bubble.append(m.text);
      if (m.files && m.files.length) bubble.append(el('div', 'msg-files', 'Attached: ' + m.files.join(', ')));
    } else {
      bubble.innerHTML = renderMarkdown(m.text);
      decorateCode(bubble);
    }

    turn.append(bubble, buildActions(m, index, msgs));
    if (m.role === 'assistant' && index === msgs.length - 1 && !busy && m.followups?.length) {
      turn.append(buildFollowups(m.followups));
    }
    return turn;
  }

  function buildActions(m, index, msgs) {
    const bar = el('div', 'actions');
    bar.append(actionButton('copy', 'Copy', () => copyText(m.text || '', 'Message copied')));
    if (busy) return bar;

    if (m.role === 'assistant') {
      const up = actionButton('up', 'Good answer', () => setFeedback(m, 'up'));
      const down = actionButton('down', 'Not a good answer', () => setFeedback(m, 'down'));
      up.classList.toggle('on', m.feedback === 'up');
      down.classList.toggle('on', m.feedback === 'down');
      bar.append(up, down, actionButton('speak', 'Read aloud', () => toggleSpeak(m.text || '')));
      bar.append(actionButton('translate', 'Translate', () => translateText(m.text || '')));
      if (index === msgs.length - 1) {
        bar.append(actionButton('regen', 'Regenerate', () => regenerate()));
        bar.append(actionButton('check', 'Double-check this answer', () => doubleCheck()));
      }
    } else if (index === lastIndexOfRole(msgs, 'user')) {
      bar.append(actionButton('edit', 'Edit and resend', () => editMessage(index)));
    }
    return bar;
  }

  function buildFollowups(list) {
    const box = el('div', 'followups');
    list.forEach((text, i) => {
      const item = el('button', 'followup');
      item.type = 'button';
      item.style.setProperty('--i', i);
      item.innerHTML = ICON.arrow;
      item.append(el('span', '', text));
      item.addEventListener('click', () => send({ text }));
      box.append(item);
    });
    return box;
  }

  function actionButton(icon, label, onClick) {
    const button = el('button', 'action');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = ICON[icon];
    button.addEventListener('click', onClick);
    return button;
  }

  function lastIndexOfRole(msgs, role) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === role) return i;
    }
    return -1;
  }

  function setFeedback(message, value) {
    message.feedback = message.feedback === value ? null : value;
    saveChats();
    renderThread();
  }

  function updateRoleLabel() {
    const chat = currentChat();
    const last = chat ? [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.by) : null;
    const label = last ? ROLE_NAMES[last.by] || 'Auto' : 'Auto';
    if (els.roleLabel.textContent === label) return;
    els.roleLabel.textContent = label;
    els.roleLabel.classList.remove('flash');
    void els.roleLabel.offsetWidth; // restarts the fade
    els.roleLabel.classList.add('flash');
  }

  function renderAttachments() {
    els.attachments.innerHTML = '';
    els.attachments.classList.toggle('hidden', pending.length === 0);

    pending.forEach((file, index) => {
      const chip = el('span', 'att');
      const name = el('span', '', file.name);
      const remove = el('button', '', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.addEventListener('click', () => {
        pending.splice(index, 1);
        renderAttachments();
        updateSendState();
      });
      chip.append(name, remove);
      els.attachments.append(chip);
    });
  }

  // ---------- Scrolling and composer state ----------
  function isNearBottom() {
    const { scrollTop, scrollHeight, clientHeight } = els.messages;
    return scrollHeight - scrollTop - clientHeight < 120;
  }

  function scrollToBottom(smooth = false) {
    els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function updateJump() {
    els.jump.classList.toggle('show', !isNearBottom() && Boolean(currentChat()?.messages.length));
  }

  function updateSendState() {
    const chat = currentChat();
    const locked = !user || Boolean(chat?.ended) || Boolean(profile?.blockedInMs);
    els.input.disabled = locked;
    els.input.placeholder = !user ? 'Sign in to chat' : chat?.ended ? 'This conversation has ended' : 'Ask anything';
    els.send.classList.toggle('stop', busy);
    els.send.setAttribute('aria-label', busy ? 'Stop reply' : 'Send message');
    els.send.disabled = busy ? false : locked || (!els.input.value.trim() && pending.length === 0);
  }

  function autoResize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px';
  }

  function syncToggles() {
    els.search.setAttribute('aria-pressed', String(prefs.search));
    els.code.setAttribute('aria-pressed', String(prefs.code));
  }

  // ---------- Sending ----------
  // Only the newest message carries its images and PDFs, so older files aren't re-sent on every request.
  function toPayload(chat) {
    const last = chat.messages.length - 1;
    return chat.messages.map((m, i) => (m.role === 'user'
      ? { role: 'user', content: m.modelText ?? m.text, attachments: i === last ? (m.media || []) : [] }
      : { role: 'assistant', content: m.text }));
  }

  // send() takes the composer (no options) or a message the app writes itself (options.text).
  async function send(options = {}) {
    if (busy) return;
    const fromComposer = options.text === undefined;
    const text = (fromComposer ? els.input.value : options.text).trim();
    const files = fromComposer ? pending : [];
    if (!text && files.length === 0) return;
    if (!user) {
      showToast('Sign in to chat with Qrox.', 2600);
      return;
    }
    if (currentChat()?.ended) {
      showToast('This conversation has ended. Start a new chat.', 2600);
      return;
    }
    if (profile?.blockedInMs) {
      showToast('Chats are paused for a while after repeated abusive messages.', 3000);
      return;
    }

    if (fromComposer) {
      const remembered = text.match(MEMORY_RE);
      if (remembered) {
        addMemory(remembered[1]);
        showToast('Saved to memory');
      }
    }

    const key = draftKey();
    if (!currentId) {
      const created = { id: newId(), title: (text || files[0].name).slice(0, 60), workspace: prefs.workspace, pinned: false, ended: false, messages: [] };
      chats.unshift(created);
      currentId = created.id;
    }
    const chat = currentChat();
    const startIndex = chat.messages.length;

    const mediaFiles = files.filter((f) => f.kind !== 'text');
    const textFiles = files.filter((f) => f.kind === 'text');
    const fileText = textFiles.map((f) => `\n\n--- ${f.name} ---\n${f.text}`).join('');
    const modelText = (text || (mediaFiles.length ? 'Please look at the attached file(s).' : '')) + fileText;
    const mode = options.mode || 'auto';

    chat.messages.push({
      role: 'user',
      text,
      mode,
      files: files.map((f) => f.name),
      thumbs: files.filter((f) => f.thumb).map((f) => f.thumb),
      modelText,
      media: mediaFiles.map(({ kind, name, mediaType, data }) => ({ kind, name, mediaType, data })),
    });

    if (fromComposer) {
      pending = [];
      els.input.value = '';
      delete drafts[key];
      persistDrafts();
      autoResize();
      renderAttachments();
    }
    await streamReply(chat, startIndex, mode);
  }

  async function streamReply(chat, animateFrom, mode) {
    const payload = toPayload(chat);
    const reply = { role: 'assistant', text: '', by: '', feedback: null, followups: [] };
    chat.messages.push(reply);

    busy = true;
    controller = new AbortController();
    updateSendState();
    renderThread(animateFrom);

    const turn = els.thread.lastElementChild;
    const bubble = turn.querySelector('.msg');
    const star = startStar(turn);
    const revealAt = performance.now() + THINK_MS;
    const paint = () => {
      bubble.innerHTML = renderMarkdown(reply.text);
      decorateCode(bubble);
    };
    let completed = false;

    try {
      const res = await api('/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: payload,
          mode: mode === 'auto' && prefs.code ? 'code' : mode,
          webSearch: prefs.search,
          settings: { personality: prefs.personality, level: prefs.level },
          memories: prefs.memoryOn ? memories.map((m) => m.text) : [],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const info = await res.json().catch(() => ({}));
        throw new Error(info.error || `Request failed (${res.status}).`);
      }
      reply.by = res.headers.get('X-Qrox-Role') || '';
      if (res.headers.get('X-Qrox-Ended')) chat.ended = true;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        reply.text += decoder.decode(value, { stream: true });
        if (performance.now() >= revealAt) { // hold the text until the thinking time is over
          paint();
          if (isNearBottom()) scrollToBottom();
          updateJump();
        }
      }
      reply.text += decoder.decode();

      const wait = revealAt - performance.now();
      if (wait > 0) await sleep(wait);
      paint();
      completed = true;
    } catch (err) {
      if (err.name === 'AbortError') {
        reply.text = (reply.text ? reply.text + '\n\n' : '') + '*Stopped.*';
      } else {
        reply.text += (reply.text ? '\n\n' : '') + `⚠️ ${err.message}`;
      }
    } finally {
      busy = false;
      controller = null;
      finishStar(star);
      saveChats();
      renderSidebar();
      updateSendState();
      renderNotice();
      loadProfile();
      // Wait for the star's pop to finish before rebuilding the thread, so the animation isn't cut off.
      setTimeout(() => { if (!busy) renderThread(); }, 1300);
    }

    if (completed) {
      if (talking || prefs.voiceReplies) speakReply(reply.text);
      if (reply.by !== 'safety' && !chat.ended) loadFollowups(chat, reply);
    }
  }

  async function loadFollowups(chat, reply) {
    const index = chat.messages.indexOf(reply);
    const question = chat.messages[index - 1]?.text || '';
    try {
      const res = await api('/api/followups', {
        method: 'POST',
        body: JSON.stringify({ question, answer: reply.text }),
      });
      const data = await res.json();
      reply.followups = Array.isArray(data.suggestions) ? data.suggestions : [];
    } catch {
      reply.followups = [];
    }
    saveChats();
    if (!busy && currentChat() === chat) renderThread();
  }

  function stopReply() {
    if (controller) controller.abort();
  }

  function regenerate() {
    const chat = currentChat();
    if (busy || !chat) return;
    if (chat.messages[chat.messages.length - 1]?.role === 'assistant') chat.messages.pop();
    const last = chat.messages[chat.messages.length - 1];
    if (last?.role !== 'user') return;
    streamReply(chat, chat.messages.length, last.mode || 'auto');
  }

  function doubleCheck() {
    send({ text: DOUBLE_CHECK, mode: 'verify' });
  }

  function translateText(text) {
    const language = window.prompt('Translate into which language?', 'English');
    if (language && language.trim()) {
      send({ text: `Translate the following into ${language.trim()}. Keep the formatting.\n\n${text}` });
    }
  }

  // Puts the last message back in the composer so it can be changed and sent again.
  function editMessage(index) {
    const chat = currentChat();
    if (busy || !chat || chat.messages[index]?.role !== 'user') return;

    const message = chat.messages[index];
    chat.messages.splice(index);
    pending = (message.media || []).map(({ kind, name, mediaType, data }) => ({ kind, name, mediaType, data }));
    els.input.value = message.text || '';

    saveChats();
    renderAttachments();
    renderSidebar();
    renderThread();
    autoResize();
    updateSendState();
    storeDraft();
    els.input.focus();
    showToast('Edit your message, then press Enter to resend.');
  }

  function useSuggestion(s) {
    if (s.send) {
      send({ text: s.prompt });
      return;
    }
    els.input.value = s.prompt;
    autoResize();
    updateSendState();
    storeDraft();
    els.input.focus();
    els.input.setSelectionRange(s.prompt.length, s.prompt.length);
  }

  // ---------- Chats ----------
  function setSidebar(open) {
    els.app.classList.toggle('collapsed', !open);
  }

  function resetToNewChat() {
    currentId = null;
    pending = [];
    renderAttachments();
    restoreDraft();
    renderSidebar();
    renderThread();
    renderNotice();
  }

  function newChatAction() {
    if (busy) return;
    resetToNewChat();
    if (isMobile()) setSidebar(false);
    els.input.focus();
  }

  function openChat(id) {
    if (busy) return;
    currentId = id;
    pending = [];
    renderAttachments();
    restoreDraft();
    renderSidebar();
    renderThread();
    renderNotice();
    scrollToBottom();
    if (isMobile()) setSidebar(false);
  }

  function deleteChat(id) {
    const chat = chats.find((c) => c.id === id);
    if (!chat || (busy && id === currentId)) return;
    if (!window.confirm(`Delete "${chat.title}"? This can't be undone.`)) return;

    chats = chats.filter((c) => c.id !== id);
    delete drafts[id];
    persistDrafts();
    if (currentId === id) resetToNewChat();
    saveChats();
    renderSidebar();
    renderThread();
    updateSendState();
  }

  function renameChat(id) {
    const chat = chats.find((c) => c.id === id);
    if (!chat) return;
    const name = window.prompt('Rename chat', chat.title);
    if (name && name.trim()) {
      chat.title = name.trim().slice(0, 80);
      saveChats();
      renderSidebar();
    }
  }

  function togglePin(id) {
    const chat = chats.find((c) => c.id === id);
    if (!chat) return;
    chat.pinned = !chat.pinned;
    saveChats();
    renderSidebar();
  }

  function safeFileName(title) {
    return title.replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 60) || 'qrox-chat';
  }

  function exportChat() {
    const chat = currentChat();
    if (!chat || chat.messages.length === 0) {
      showToast('Nothing to export yet.');
      return;
    }

    const lines = [`# ${chat.title}`, ''];
    for (const m of chat.messages) {
      lines.push(m.role === 'user' ? '## You' : '## Qrox', '', m.text || '', '');
    }

    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown' }));
    const link = el('a');
    link.href = url;
    link.download = `${safeFileName(chat.title)}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Chat exported as Markdown.');
  }

  // ---------- Memory ----------
  function addMemory(text) {
    const clean = text.trim().slice(0, 300);
    if (!clean) return;
    memories.unshift({ id: newId(), text: clean });
    saveMemories();
  }

  function renderMemories() {
    els.memoryList.innerHTML = '';
    if (memories.length === 0) {
      els.memoryList.append(el('li', 'muted', 'Nothing saved yet.'));
      return;
    }
    for (const memory of memories) {
      const item = el('li', 'memory-item');
      item.append(el('span', '', memory.text));
      const remove = el('button', 'icon-btn');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Delete memory');
      remove.innerHTML = ICON.trash;
      remove.addEventListener('click', () => {
        memories = memories.filter((m) => m.id !== memory.id);
        saveMemories();
        renderMemories();
      });
      item.append(remove);
      els.memoryList.append(item);
    }
  }

  // ---------- Files and images ----------
  function toBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.readAsDataURL(file);
    });
  }

  // A small preview of an image, so the chat can show what you sent.
  function makeThumb(file) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, 240 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve('');
      };
      img.src = url;
    });
  }

  async function readFile(file) {
    if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 10 MB.`);

    if (IMAGE_TYPES.includes(file.type)) {
      if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} is larger than 2.5 MB. Please use a smaller image.`);
      const data = await toBase64(file);
      return { name: file.name, kind: 'image', mediaType: file.type, data, thumb: await makeThumb(file) };
    }
    if (file.type === 'application/pdf') {
      return { name: file.name, kind: 'pdf', mediaType: 'application/pdf', data: await toBase64(file) };
    }
    if (file.type.startsWith('text/') || file.type === 'application/json' || TEXT_EXT.test(file.name)) {
      const text = (await file.text()).slice(0, MAX_TEXT_CHARS);
      return { name: file.name, kind: 'text', text };
    }
    throw new Error(`${file.name} isn't supported. Try an image, a PDF or a text file.`);
  }

  async function addFiles(fileList) {
    for (const file of Array.from(fileList || [])) {
      try {
        const item = await readFile(file);
        const imageCount = pending.filter((f) => f.kind === 'image').length;
        if (item.kind === 'image' && imageCount >= MAX_IMAGES) {
          throw new Error(`You can attach up to ${MAX_IMAGES} images to one message.`);
        }
        pending.push(item);
      } catch (err) {
        showToast(err.message, 3000);
      }
    }
    renderAttachments();
    updateSendState();
  }

  // ---------- Code Lab ----------
  let pyWorker = null;
  let runHandler = null;   // receives messages from the worker that is running
  let runTimer = null;

  function openLab(code = '', lang = 'javascript') {
    els.labCode.value = code;
    els.labLang.value = RUNNABLE[lang] || 'javascript';
    els.labOutput.textContent = '';
    showPreview(null);
    if (!els.lab.open) els.lab.showModal();
    els.labCode.focus();
  }

  function logLine(text) {
    els.labOutput.textContent += text + '\n';
    els.labOutput.scrollTop = els.labOutput.scrollHeight;
  }

  function showPreview(html) {
    if (html === null) {
      els.labPreview.classList.add('hidden');
      els.labPreview.removeAttribute('srcdoc');
      return;
    }
    els.labPreview.srcdoc = html;
    els.labPreview.classList.remove('hidden');
  }

  function setRunning(on) {
    els.labRun.disabled = on;
    els.labRun.textContent = on ? 'Running…' : 'Run';
  }

  function finishRun(message) {
    clearTimeout(runTimer);
    runHandler = null;
    if (message) logLine(message);
    setRunning(false);
  }

  function runLab() {
    const code = els.labCode.value;
    const lang = els.labLang.value;
    els.labOutput.textContent = '';

    if (lang === 'html' || lang === 'css') {
      showPreview(lang === 'css'
        ? `<!doctype html><html><head><style>${code}</style></head><body><h1>Heading</h1><p>Sample text styled by your CSS.</p><button>Button</button></body></html>`
        : code);
      return;
    }
    showPreview(null);
    setRunning(true);
    if (lang === 'javascript') runJavaScript(code);
    else runPython(code);
  }

  function runJavaScript(code) {
    const url = URL.createObjectURL(new Blob([JS_WORKER], { type: 'text/javascript' }));
    const worker = new Worker(url);
    const stop = (message) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      finishRun(message);
    };

    runHandler = (data) => {
      if (data.type === 'out') logLine(data.text);
      if (data.type === 'error') stop('Error: ' + data.text);
      if (data.type === 'done') stop('');
    };
    runTimer = setTimeout(() => stop('Stopped after 5 seconds. Check for an endless loop.'), 5000);
    worker.onmessage = (e) => runHandler && runHandler(e.data);
    worker.onerror = (e) => stop('Error: ' + (e.message || 'the code could not run'));
    worker.postMessage(code);
  }

  function getPyWorker() {
    if (!pyWorker) {
      const url = URL.createObjectURL(new Blob([PY_WORKER], { type: 'text/javascript' }));
      pyWorker = new Worker(url);
      pyWorker.onmessage = (e) => runHandler && runHandler(e.data);
      pyWorker.onerror = (e) => runHandler && runHandler({ type: 'error', text: e.message || 'Python could not start' });
    }
    return pyWorker;
  }

  function runPython(code) {
    const worker = getPyWorker();
    logLine('Running Python. The first run loads Python, which takes a few seconds.');
    runHandler = (data) => {
      if (data.type === 'out') logLine(data.text);
      if (data.type === 'error') finishRun('Error: ' + data.text);
      if (data.type === 'done') finishRun('');
    };
    runTimer = setTimeout(() => {
      pyWorker.terminate();
      pyWorker = null;
      finishRun('Stopped after 30 seconds. Check for an endless loop.');
    }, 30000);
    worker.postMessage(code);
  }

  // ---------- Age verification with Persona ----------
  let personaLoading = null;

  function setVerifyStatus(message) {
    els.verifyStatus.textContent = message;
  }

  // Loads Persona's web SDK once.
  function loadPersona() {
    if (window.Persona) return Promise.resolve(window.Persona);
    if (!personaLoading) {
      personaLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.withpersona.com/dist/persona-v5.1.2.js';
        script.onload = () => resolve(window.Persona);
        script.onerror = () => {
          personaLoading = null;
          reject(new Error('Could not load the verification widget. Check your connection.'));
        };
        document.head.append(script);
      });
    }
    return personaLoading;
  }

  async function startVerification() {
    if (!user) return;
    els.verifyBtn.disabled = true;
    setVerifyStatus('Opening verification…');
    try {
      const res = await api('/api/verify/start', { method: 'POST', body: '{}' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setVerifyStatus(data.error || 'Verification could not start.');
        els.verifyBtn.disabled = false;
        return;
      }
      const Persona = await loadPersona();
      const client = new Persona.Client({
        templateId: data.templateId,
        environmentId: data.environmentId,
        referenceId: data.referenceId,
        onReady: () => client.open(),
        onComplete: () => {
          setVerifyStatus('Checking your ID. This can take a minute.');
          pollVerification(0);
        },
        onCancel: () => {
          setVerifyStatus('Verification was cancelled.');
          els.verifyBtn.disabled = false;
        },
        onError: () => {
          setVerifyStatus('Something went wrong during verification. Please try again.');
          els.verifyBtn.disabled = false;
        },
      });
    } catch (err) {
      setVerifyStatus(err.message || 'Verification could not start.');
      els.verifyBtn.disabled = false;
    }
  }

  // Persona reports the result to the server by webhook. Wait here until the server has recorded it.
  async function pollVerification(attempt) {
    if (attempt > 40) {
      setVerifyStatus('Still checking. Your age group will update when Persona confirms it.');
      els.verifyBtn.disabled = false;
      return;
    }
    await sleep(3000);
    let data = null;
    try {
      const res = await api('/api/verify/status');
      if (res.ok) data = await res.json();
    } catch {
      // Try again on the next round.
    }
    if (data?.verified) {
      setVerifyStatus(`Verified. Your age group: ${AGE_LABELS[data.ageTier]}.`);
      await loadProfile();
      return;
    }
    if (data?.status === 'failed') {
      setVerifyStatus('We could not verify your ID. You can try again.');
      els.verifyBtn.disabled = false;
      return;
    }
    pollVerification(attempt + 1);
  }

  els.verifyBtn.addEventListener('click', startVerification);

  // ---------- Dialogs ----------
  function openMemory() {
    renderMemories();
    if (!els.memory.open) els.memory.showModal();
  }

  function openSettings() {
    els.personality.value = prefs.personality;
    els.level.value = prefs.level;
    els.memoryOn.checked = prefs.memoryOn;
    els.voiceReplies.checked = prefs.voiceReplies;
    els.rate.value = String(prefs.rate || 1);
    if (voices.length) els.voiceSelect.value = prefs.voiceName || els.voiceSelect.value;
    if (!els.settings.open) els.settings.showModal();
  }

  // ---------- Events ----------
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) stopReply();
    else send();
  });

  els.input.addEventListener('input', () => {
    autoResize();
    updateSendState();
    storeDraft();
  });

  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!busy) send();
    }
  });

  els.input.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  els.attachBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    const files = Array.from(els.fileInput.files || []);
    els.fileInput.value = '';
    addFiles(files);
  });

  els.search.addEventListener('click', () => {
    prefs.search = !prefs.search;
    savePrefs();
    syncToggles();
  });

  els.code.addEventListener('click', () => {
    prefs.code = !prefs.code;
    savePrefs();
    syncToggles();
  });

  els.mic.addEventListener('click', () => (talking ? stopTalk() : startTalk()));

  els.toggleSidebar.addEventListener('click', () => setSidebar(els.app.classList.contains('collapsed')));
  els.collapseBtn.addEventListener('click', () => setSidebar(false));
  els.searchNav.addEventListener('click', () => {
    setSidebar(true);
    els.chatSearch.focus();
  });
  els.scrim.addEventListener('click', () => setSidebar(false));
  els.newChat.addEventListener('click', newChatAction);
  document.getElementById('chatFocus').addEventListener('click', () => els.input.focus());
  els.labNav.addEventListener('click', () => openLab());
  els.memoryNav.addEventListener('click', openMemory);
  els.settingsNav.addEventListener('click', openSettings);
  els.addWorkspace.addEventListener('click', addWorkspace);
  els.chatSearch.addEventListener('input', renderSidebar);
  els.exportBtn.addEventListener('click', exportChat);
  els.helpBtn.addEventListener('click', () => { if (!els.shortcuts.open) els.shortcuts.showModal(); });

  els.jump.addEventListener('click', () => scrollToBottom(true));
  els.messages.addEventListener('scroll', updateJump, { passive: true });

  // ---------- Sign up and log in (username and password) ----------
  const accountEmail = (username) => `${username}@${ACCOUNT_DOMAIN}`;

  function setAuthTab(signup) {
    els.loginForm.classList.toggle('hidden', signup);
    els.signupForm.classList.toggle('hidden', !signup);
    els.tabLogin.setAttribute('aria-selected', String(!signup));
    els.tabSignup.setAttribute('aria-selected', String(signup));
    els.loginError.textContent = '';
    els.signupError.textContent = '';
  }

  function authMessage(err) {
    const code = err?.code || '';
    if (['auth/invalid-credential', 'auth/invalid-login-credentials', 'auth/wrong-password', 'auth/user-not-found'].includes(code)) {
      return 'Wrong username or password.';
    }
    if (code === 'auth/email-already-in-use') return 'That username is already taken.';
    if (code === 'auth/weak-password') return 'Choose a stronger password.';
    if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a few minutes and try again.';
    if (code === 'auth/network-request-failed') return 'Check your connection and try again.';
    return 'Something went wrong. Please try again.';
  }

  els.tabLogin.addEventListener('click', () => setAuthTab(false));
  els.tabSignup.addEventListener('click', () => setAuthTab(true));

  els.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = els.loginUser.value.trim().toLowerCase();
    const password = els.loginPass.value;
    els.loginError.textContent = '';
    if (!USERNAME_RE.test(username)) {
      els.loginError.textContent = 'Enter your username.';
      return;
    }
    if (!password) {
      els.loginError.textContent = 'Enter your password.';
      return;
    }
    try {
      await signInWithEmailAndPassword(auth, accountEmail(username), password);
      els.loginPass.value = '';
    } catch (err) {
      els.loginError.textContent = authMessage(err);
    }
  });

  els.signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = els.signupUser.value.trim().toLowerCase();
    const password = els.signupPass.value;
    const confirm = els.signupPass2.value;
    const dob = els.signupDob.value;
    const email = els.signupEmail.value.trim();
    const fail = (message) => { els.signupError.textContent = message; };

    fail('');
    if (!USERNAME_RE.test(username)) return fail('Usernames are 3 to 20 letters, numbers or underscores.');
    if (password.length < 8) return fail('Use at least 8 characters for your password.');
    if (password !== confirm) return fail('The two passwords do not match.');
    if (!dob) return fail('Enter your date of birth.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('That email address does not look right.');

    signingUp = true;
    try {
      await createUserWithEmailAndPassword(auth, accountEmail(username), password);
    } catch (err) {
      signingUp = false;
      return fail(authMessage(err));
    }

    // The account exists now. Save the details the form collected, which also sets the age group.
    try {
      const res = await api('/api/profile', { method: 'POST', body: JSON.stringify({ username, dob, email }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) fail(data.error || 'Your account was created, but your details were not saved. You can confirm your age later.');
    } catch {
      fail('Your account was created, but your details could not be saved. Check your connection and log in again.');
    }
    signingUp = false;
    els.signupPass.value = '';
    els.signupPass2.value = '';
    await loadProfile();
  });
  els.signOutBtn.addEventListener('click', () => signOut(auth).catch(() => showToast('Could not sign out. Try again.')));
  els.ageBtn.addEventListener('click', openAge);
  els.noticeBtn.addEventListener('click', openAge);
  els.closeAge.addEventListener('click', () => els.ageDialog.close());

  els.ageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!user) return;
    els.ageResult.textContent = 'Saving…';
    try {
      const res = await api('/api/age', { method: 'POST', body: JSON.stringify({ dob: els.dob.value }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        els.ageResult.textContent = data.error || 'Could not save your age.';
        return;
      }
      els.ageResult.textContent = `Your age group: ${AGE_LABELS[data.ageTier]}. If that is wrong, use "Report a wrong age".`;
      await loadProfile();
    } catch {
      els.ageResult.textContent = 'Could not reach Qrox. Check your connection and try again.';
    }
  });

  els.closeShortcuts.addEventListener('click', () => els.shortcuts.close());
  els.closeSettings.addEventListener('click', () => els.settings.close());
  els.closeMemory.addEventListener('click', () => els.memory.close());
  els.labClose.addEventListener('click', () => els.lab.close());
  for (const dialog of [els.shortcuts, els.settings, els.memory, els.lab, els.ageDialog]) {
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  }

  els.personality.addEventListener('change', () => { prefs.personality = els.personality.value; savePrefs(); });
  els.level.addEventListener('change', () => { prefs.level = els.level.value; savePrefs(); });
  els.memoryOn.addEventListener('change', () => { prefs.memoryOn = els.memoryOn.checked; savePrefs(); });
  els.voiceReplies.addEventListener('change', () => { prefs.voiceReplies = els.voiceReplies.checked; savePrefs(); });
  els.voiceSelect.addEventListener('change', () => { prefs.voiceName = els.voiceSelect.value; savePrefs(); });
  els.rate.addEventListener('input', () => { prefs.rate = Number(els.rate.value); savePrefs(); });

  els.wipeData.addEventListener('click', () => {
    if (!window.confirm('Delete the chats, memories, drafts and settings stored in this browser? Your account is not affected.')) return;
    for (const name of ['chats', 'drafts', 'memories', 'workspaces']) {
      localStorage.removeItem(scopedKey(name));
    }
    localStorage.removeItem(KEYS.prefs);
    location.reload();
  });

  els.memoryForm.addEventListener('submit', (e) => {
    e.preventDefault();
    addMemory(els.memoryInput.value);
    els.memoryInput.value = '';
    renderMemories();
  });

  els.clearMemories.addEventListener('click', () => {
    if (!window.confirm('Delete all saved memories?')) return;
    memories = [];
    saveMemories();
    renderMemories();
  });

  els.labRun.addEventListener('click', runLab);
  els.labCopy.addEventListener('click', () => copyText(els.labCode.value, 'Code copied'));
  els.labCode.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const { selectionStart: start, selectionEnd: end, value } = els.labCode;
    els.labCode.value = value.slice(0, start) + '  ' + value.slice(end);
    els.labCode.selectionStart = els.labCode.selectionEnd = start + 2;
  });

  // Drag images or files anywhere on the page to attach them.
  let dragDepth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth += 1;
    els.app.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.app.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    els.app.classList.remove('dragging');
    addFiles(e.dataTransfer.files);
  });

  // Keyboard shortcuts.
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

    if (mod && key === 'k') {
      e.preventDefault();
      newChatAction();
    } else if (mod && key === 'b') {
      e.preventDefault();
      setSidebar(els.app.classList.contains('collapsed'));
    } else if (e.key === 'Escape') {
      if (document.querySelector('dialog[open]')) return; // the dialog handles Escape itself
      if (speaking) stopSpeaking();
      else if (busy) stopReply();
      else if (isMobile()) setSidebar(false);
    } else if (!typing && !mod && e.key === '/') {
      e.preventDefault();
      els.input.focus();
    } else if (!typing && !mod && e.key === '?') {
      e.preventDefault();
      if (!els.shortcuts.open) els.shortcuts.showModal();
    }
  });

  // Signing in or out switches to that account's chats on this device.
  onAuthStateChanged(auth, async (signedIn) => {
    user = signedIn;
    profile = null;
    loadUserData();
    renderWorkspaces();
    renderSidebar();
    renderThread();
    restoreDraft();
    renderAccount();
    if (user) {
      await loadProfile();
      if (profile?.needsAge && !ageAsked && !signingUp) {
        ageAsked = true;
        openAge();
      }
    }
  });

  // ---------- Start ----------
  prefs = { ...DEFAULT_PREFS, ...loadJson(KEYS.prefs, {}) };
  loadUserData();
  loadVoices();
  if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', loadVoices);
  setSidebar(!isMobile());
  syncToggles();
  renderWorkspaces();
  restoreDraft();
  renderSidebar();
  renderThread();
  renderAttachments();
  renderAccount();
  updateSendState();
  scrollToBottom();
})();
