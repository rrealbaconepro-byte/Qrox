// app.js: Qrox front end
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
  const KEYS = {
    chats: 'qrox.chats.v1',
    drafts: 'qrox.drafts.v1',
    prefs: 'qrox.prefs.v2',
    memories: 'qrox.memories.v1',
    workspaces: 'qrox.workspaces.v1',
  };
  const DEFAULT_PREFS = { search: false, code: false, personality: 'balanced', level: 'auto', memoryOn: true, workspace: null };
  const SUGGESTIONS = [
    { label: 'Explain simply', prompt: 'Explain how the internet works, as if I were ten years old.', send: true },
    { label: 'Write code', prompt: 'Write a small Python script that renames photos in a folder by the date they were taken.', send: true },
    { label: 'Improve my writing', prompt: 'Rewrite this to sound clearer and more professional: ', send: false },
    { label: 'Plan something', prompt: 'Plan a relaxed three-day city break in Lisbon with a daily itinerary.', send: true },
  ];

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
  };
  const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5l2.6 7.9 7.9 2.6-7.9 2.6L12 22.5l-2.6-7.9-7.9-2.6 7.9-2.6z" fill="#fff"/></svg>';

  const $ = (id) => document.getElementById(id);
  const els = {
    app: $('app'),
    scrim: $('scrim'),
    toast: $('toast'),
    toggleSidebar: $('toggleSidebar'),
    collapseBtn: $('collapseBtn'),
    searchNav: $('searchNav'),
    newChat: $('newChat'),
    labNav: $('labNav'),
    memoryNav: $('memoryNav'),
    settingsNav: $('settingsNav'),
    addWorkspace: $('addWorkspace'),
    workspaceList: $('workspaceList'),
    chatSearch: $('chatSearch'),
    chatList: $('chatList'),
    messages: $('messages'),
    thread: $('thread'),
    jump: $('jumpBtn'),
    form: $('composer'),
    input: $('input'),
    send: $('sendBtn'),
    attachBtn: $('attachBtn'),
    fileInput: $('fileInput'),
    attachments: $('attachments'),
    mic: $('micBtn'),
    search: $('searchToggle'),
    code: $('codeToggle'),
    roleLabel: $('roleLabel'),
    exportBtn: $('exportBtn'),
    helpBtn: $('helpBtn'),
    shortcuts: $('shortcuts'),
    closeShortcuts: $('closeShortcuts'),
    settings: $('settings'),
    closeSettings: $('closeSettings'),
    personality: $('personality'),
    level: $('level'),
    memoryOn: $('memoryOn'),
    wipeData: $('wipeData'),
    memory: $('memoryDialog'),
    closeMemory: $('closeMemory'),
    memoryForm: $('memoryForm'),
    memoryInput: $('memoryInput'),
    memoryList: $('memoryList'),
    clearMemories: $('clearMemories'),
    lab: $('lab'),
    labLang: $('labLang'),
    labCode: $('labCode'),
    labRun: $('labRun'),
    labCopy: $('labCopy'),
    labClose: $('labClose'),
    labOutput: $('labOutput'),
    labPreview: $('labPreview'),
  };

  // ---------- State ----------
  let chats = [];
  let memories = [];
  let workspaces = [];
  let drafts = {};
  let prefs = { ...DEFAULT_PREFS };
  let currentId = null;     // open chat, or null for a fresh one
  let pending = [];         // files attached to the message being written
  let busy = false;         // true while a reply is in progress
  let controller = null;    // cancels the reply in progress
  let draftTimer = null;
  let toastTimer = null;

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

  // ---------- Storage ----------
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

  function saveChats() {
    // Image and PDF data stays in memory only, so storage isn't filled with large files.
    const slim = chats.map((c) => ({ ...c, messages: c.messages.map(({ media, ...rest }) => rest) }));
    saveJson(KEYS.chats, slim);
  }

  function savePrefs() { saveJson(KEYS.prefs, prefs); }
  function saveMemories() { saveJson(KEYS.memories, memories); }
  function saveWorkspaces() { saveJson(KEYS.workspaces, workspaces); }

  function persistDrafts() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => saveJson(KEYS.drafts, drafts), 300);
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
    const list = visibleChats();
    els.chatList.innerHTML = '';
    if (list.length === 0) {
      els.chatList.append(el('p', 'empty-list', chats.length ? 'No chats match.' : 'Your chats will appear here.'));
      return;
    }

    for (const chat of list) {
      const row = el('div', 'chat-row' + (chat.id === currentId ? ' active' : ''));

      const open = el('button', 'chat-open', chat.title);
      open.type = 'button';
      open.title = chat.title;
      open.addEventListener('click', () => openChat(chat.id));

      const rename = el('button', 'chat-action');
      rename.type = 'button';
      rename.title = 'Rename chat';
      rename.setAttribute('aria-label', 'Rename chat');
      rename.innerHTML = ICON.edit;
      rename.addEventListener('click', (e) => {
        e.stopPropagation();
        renameChat(chat.id);
      });

      const remove = el('button', 'chat-action');
      remove.type = 'button';
      remove.title = 'Delete chat';
      remove.setAttribute('aria-label', 'Delete chat');
      remove.innerHTML = ICON.trash;
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteChat(chat.id);
      });

      row.append(open, rename, remove);
      els.chatList.append(row);
    }
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

    hero.append(logo, el('h1', '', 'What can I help you with?'), el('p', 'hero-sub', 'Ask anything, attach files, or start with an idea below.'), row);
    els.thread.append(hero);
  }

  function buildTurn(m, index, msgs) {
    const turn = el('div', `turn ${m.role}`);
    const bubble = el('div', `msg ${m.role}`);

    if (m.role === 'user') {
      bubble.textContent = m.text;
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
      bar.append(up, down, actionButton('translate', 'Translate', () => translateText(m.text || '')));
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
    void els.roleLabel.offsetWidth; // restart the fade
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
    els.send.classList.toggle('stop', busy);
    els.send.setAttribute('aria-label', busy ? 'Stop reply' : 'Send message');
    els.send.disabled = !busy && !els.input.value.trim() && pending.length === 0;
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

  // send() takes either the composer (no options) or a message the app writes itself (options.text).
  async function send(options = {}) {
    if (busy) return;
    const fromComposer = options.text === undefined;
    const text = (fromComposer ? els.input.value : options.text).trim();
    const files = fromComposer ? pending : [];
    if (!text && files.length === 0) return;

    if (fromComposer) {
      const remembered = text.match(MEMORY_RE);
      if (remembered) {
        addMemory(remembered[1]);
        showToast('Saved to memory');
      }
    }

    const key = draftKey();
    if (!currentId) {
      const created = { id: newId(), title: (text || files[0].name).slice(0, 60), workspace: prefs.workspace, messages: [] };
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
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      // Wait for the star's pop to finish before rebuilding the thread, so the animation isn't cut off.
      setTimeout(() => { if (!busy) renderThread(); }, 1300);
    }

    if (completed) loadFollowups(chat, reply);
  }

  async function loadFollowups(chat, reply) {
    const index = chat.messages.indexOf(reply);
    const question = chat.messages[index - 1]?.text || '';
    try {
      const res = await fetch('/api/followups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    if (currentId === id) {
      currentId = null;
      pending = [];
      renderAttachments();
      restoreDraft();
    }
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
    link.download = `${(chat.title.replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 60)) || 'qrox-chat'}.md`;
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

  // ---------- Files ----------
  function toBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.readAsDataURL(file);
    });
  }

  async function readFile(file) {
    if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 10 MB.`);

    if (IMAGE_TYPES.includes(file.type)) {
      if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} is larger than 2.5 MB. Please use a smaller image.`);
      return { name: file.name, kind: 'image', mediaType: file.type, data: await toBase64(file) };
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

  // ---------- Memory and settings dialogs ----------
  function openMemory() {
    renderMemories();
    if (!els.memory.open) els.memory.showModal();
  }

  function openSettings() {
    els.personality.value = prefs.personality;
    els.level.value = prefs.level;
    els.memoryOn.checked = prefs.memoryOn;
    if (!els.settings.open) els.settings.showModal();
  }

  // ---------- Keyboard and drag and drop ----------
  let dragDepth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  // ---------- Voice input ----------
  // Uses the browser's built-in speech recognition. The button is hidden where it isn't supported.
  function setupVoice() {
    const SpeechApi = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechApi) {
      els.mic.classList.add('hidden');
      return;
    }
    const recognition = new SpeechApi();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    let base = '';
    let listening = false;

    recognition.onresult = (e) => {
      const transcript = Array.from(e.results).map((r) => r[0].transcript).join('');
      els.input.value = (base ? base + ' ' : '') + transcript;
      autoResize();
      updateSendState();
      storeDraft();
    };
    recognition.onend = () => {
      listening = false;
      els.mic.classList.remove('active');
    };
    els.mic.addEventListener('click', () => {
      if (listening) {
        recognition.stop();
        return;
      }
      base = els.input.value.trim();
      try {
        recognition.start();
        listening = true;
        els.mic.classList.add('active');
      } catch {
        // Recognition is already running.
      }
    });
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

  els.toggleSidebar.addEventListener('click', () => setSidebar(els.app.classList.contains('collapsed')));
  els.collapseBtn.addEventListener('click', () => setSidebar(false));
  els.searchNav.addEventListener('click', () => {
    setSidebar(true);
    els.chatSearch.focus();
  });
  els.scrim.addEventListener('click', () => setSidebar(false));
  els.newChat.addEventListener('click', newChatAction);
  els.labNav.addEventListener('click', () => openLab());
  els.memoryNav.addEventListener('click', openMemory);
  els.settingsNav.addEventListener('click', openSettings);
  els.addWorkspace.addEventListener('click', addWorkspace);
  els.chatSearch.addEventListener('input', renderSidebar);
  els.exportBtn.addEventListener('click', exportChat);
  els.helpBtn.addEventListener('click', () => { if (!els.shortcuts.open) els.shortcuts.showModal(); });

  els.jump.addEventListener('click', () => scrollToBottom(true));
  els.messages.addEventListener('scroll', updateJump, { passive: true });

  els.closeShortcuts.addEventListener('click', () => els.shortcuts.close());
  els.closeSettings.addEventListener('click', () => els.settings.close());
  els.closeMemory.addEventListener('click', () => els.memory.close());
  els.labClose.addEventListener('click', () => els.lab.close());
  for (const dialog of [els.shortcuts, els.settings, els.memory, els.lab]) {
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  }

  els.personality.addEventListener('change', () => {
    prefs.personality = els.personality.value;
    savePrefs();
  });
  els.level.addEventListener('change', () => {
    prefs.level = els.level.value;
    savePrefs();
  });
  els.memoryOn.addEventListener('change', () => {
    prefs.memoryOn = els.memoryOn.checked;
    savePrefs();
  });
  els.wipeData.addEventListener('click', () => {
    if (!window.confirm('Delete all chats, memories, drafts and settings from this browser? This cannot be undone.')) return;
    Object.values(KEYS).forEach((key) => localStorage.removeItem(key));
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

  // Drag files anywhere on the page to attach them.
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
      if (busy) stopReply();
      else if (isMobile()) setSidebar(false);
    } else if (!typing && !mod && e.key === '/') {
      e.preventDefault();
      els.input.focus();
    } else if (!typing && !mod && e.key === '?') {
      e.preventDefault();
      if (!els.shortcuts.open) els.shortcuts.showModal();
    }
  });

  // ---------- Start ----------
  chats = loadJson(KEYS.chats, []);
  if (!Array.isArray(chats)) chats = [];
  memories = loadJson(KEYS.memories, []);
  workspaces = loadJson(KEYS.workspaces, []);
  drafts = loadJson(KEYS.drafts, {});
  prefs = { ...DEFAULT_PREFS, ...loadJson(KEYS.prefs, {}) };

  setupVoice();
  setSidebar(!isMobile());
  syncToggles();
  renderWorkspaces();
  restoreDraft();
  renderSidebar();
  renderThread();
  renderAttachments();
  updateSendState();
  scrollToBottom();
})();
