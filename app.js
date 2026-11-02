// app.js: Qrox front end
(() => {
  'use strict';

  const STORAGE_KEY = 'qrox.chats.v1';
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024; // Groq allows 4 MB per request, and base64 adds about a third
  const MAX_TEXT_CHARS = 150000;
  const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const TEXT_EXT = /\.(txt|md|csv|tsv|json|js|jsx|ts|tsx|py|html|css|xml|yml|yaml|sql|java|c|h|cpp|go|rs|rb|php|sh|log)$/i;

  const $ = (id) => document.getElementById(id);
  const els = {
    app: $('app'),
    thread: $('thread'),
    messages: $('messages'),
    form: $('composer'),
    input: $('input'),
    send: $('sendBtn'),
    attachBtn: $('attachBtn'),
    fileInput: $('fileInput'),
    attachments: $('attachments'),
    search: $('searchToggle'),
    mic: $('micBtn'),
    chatList: $('chatList'),
    newChat: $('newChat'),
    toggleSidebar: $('toggleSidebar'),
    closeSidebar: $('closeSidebar'),
  };

  let chats = loadChats();  // [{ id, title, messages: [] }]
  let currentId = null;     // open chat, or null for a fresh one
  let pending = [];         // files attached to the message being written
  let busy = false;         // true while a reply is streaming

  const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
  const currentChat = () => chats.find((c) => c.id === currentId) || null;
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // ---------- Storage ----------
  function loadChats() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  function saveChats() {
    // Image and PDF data is large, so it stays in memory and is not saved.
    const slim = chats.map((c) => ({
      ...c,
      messages: c.messages.map(({ media, ...rest }) => rest),
    }));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch {
      // Storage is full. The chat still works for this session.
    }
  }

  // ---------- Markdown ----------
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

  // ---------- Rendering ----------
  function renderSidebar() {
    els.chatList.innerHTML = '';
    for (const chat of chats) {
      const row = document.createElement('div');
      row.className = 'chat-row' + (chat.id === currentId ? ' active' : '');

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'chat-open';
      open.textContent = chat.title;
      open.addEventListener('click', () => openChat(chat.id));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'chat-del';
      del.textContent = '×';
      del.setAttribute('aria-label', `Delete chat: ${chat.title}`);
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteChat(chat.id);
      });

      row.append(open, del);
      els.chatList.append(row);
    }
  }

  function renderThread() {
    const chat = currentChat();
    const msgs = chat ? chat.messages : [];
    els.thread.innerHTML = '';
    els.thread.classList.toggle('is-empty', msgs.length === 0);

    if (msgs.length === 0) {
      const title = document.createElement('h1');
      title.textContent = 'What can I help you with?';
      els.thread.append(title);
      return;
    }
    msgs.forEach((m) => els.thread.append(buildMessage(m)));
    scrollToBottom();
  }

  function buildMessage(m) {
    const div = document.createElement('div');
    div.className = `msg ${m.role}`;
    if (m.role === 'user') {
      div.textContent = m.text;
      if (m.files && m.files.length) {
        const names = document.createElement('div');
        names.className = 'msg-files';
        names.textContent = 'Attached: ' + m.files.join(', ');
        div.append(names);
      }
    } else {
      div.innerHTML = renderMarkdown(m.text);
    }
    return div;
  }

  function renderAttachments() {
    els.attachments.innerHTML = '';
    els.attachments.classList.toggle('hidden', pending.length === 0);
    pending.forEach((file, index) => {
      const chip = document.createElement('span');
      chip.className = 'att';

      const name = document.createElement('span');
      name.textContent = file.name;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
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

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function updateSendState() {
    els.send.disabled = busy || (!els.input.value.trim() && pending.length === 0);
  }

  function autoResize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px';
  }

  // ---------- Sending ----------
  // Builds the message list for the server. Only the newest message carries its images and PDFs,
  // so older files are not re-sent on every request.
  function toPayload(chat) {
    const last = chat.messages.length - 1;
    return chat.messages.map((m, i) => (m.role === 'user'
      ? { role: 'user', content: m.modelText ?? m.text, attachments: i === last ? (m.media || []) : [] }
      : { role: 'assistant', content: m.text }));
  }

  async function send() {
    const text = els.input.value.trim();
    if (busy || (!text && pending.length === 0)) return;

    if (!currentId) {
      const created = { id: newId(), title: (text || pending[0].name).slice(0, 60), messages: [] };
      chats.unshift(created);
      currentId = created.id;
    }
    const chat = currentChat();

    const mediaFiles = pending.filter((f) => f.kind !== 'text');
    const textFiles = pending.filter((f) => f.kind === 'text');
    const fileText = textFiles.map((f) => `\n\n--- ${f.name} ---\n${f.text}`).join('');
    const modelText = (text || (mediaFiles.length ? 'Please look at the attached file(s).' : '')) + fileText;

    chat.messages.push({
      role: 'user',
      text,
      files: pending.map((f) => f.name),
      modelText,
      media: mediaFiles.map(({ kind, name, mediaType, data }) => ({ kind, name, mediaType, data })),
    });
    const payload = toPayload(chat);

    const reply = { role: 'assistant', text: '' };
    chat.messages.push(reply);

    pending = [];
    els.input.value = '';
    autoResize();
    renderAttachments();
    busy = true;
    updateSendState();
    renderThread();

    const bubble = els.thread.lastElementChild;
    bubble.classList.add('pending');

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: payload,
          webSearch: els.search.getAttribute('aria-pressed') === 'true',
        }),
      });
      if (!res.ok) {
        const info = await res.json().catch(() => ({}));
        throw new Error(info.error || `Request failed (${res.status}).`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        reply.text += decoder.decode(value, { stream: true });
        bubble.innerHTML = renderMarkdown(reply.text);
        scrollToBottom();
      }
      reply.text += decoder.decode();
    } catch (err) {
      reply.text += (reply.text ? '\n\n' : '') + `⚠️ ${err.message}`;
    } finally {
      busy = false;
      saveChats();
      renderSidebar();
      renderThread();
      updateSendState();
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

  // ---------- Chat list actions ----------
  function setSidebar(open) {
    els.app.classList.toggle('collapsed', !open);
  }

  function resetToNewChat() {
    currentId = null;
    pending = [];
    renderAttachments();
    renderSidebar();
    renderThread();
    updateSendState();
  }

  function openChat(id) {
    if (busy) return;
    currentId = id;
    pending = [];
    renderAttachments();
    renderSidebar();
    renderThread();
    updateSendState();
    if (isMobile()) setSidebar(false);
  }

  function deleteChat(id) {
    if (busy && id === currentId) return;
    chats = chats.filter((c) => c.id !== id);
    if (currentId === id) currentId = null;
    saveChats();
    renderSidebar();
    renderThread();
    updateSendState();
  }

  // ---------- Events ----------
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });

  els.input.addEventListener('input', () => {
    autoResize();
    updateSendState();
  });

  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  els.attachBtn.addEventListener('click', () => els.fileInput.click());

  els.fileInput.addEventListener('change', async () => {
    const files = Array.from(els.fileInput.files || []);
    els.fileInput.value = '';
    for (const file of files) {
      try {
        pending.push(await readFile(file));
      } catch (err) {
        alert(err.message);
      }
    }
    renderAttachments();
    updateSendState();
  });

  els.search.addEventListener('click', () => {
    const on = els.search.getAttribute('aria-pressed') !== 'true';
    els.search.setAttribute('aria-pressed', String(on));
  });

  els.toggleSidebar.addEventListener('click', () => {
    setSidebar(els.app.classList.contains('collapsed'));
  });

  els.closeSidebar.addEventListener('click', () => setSidebar(false));

  els.newChat.addEventListener('click', () => {
    if (busy) return;
    resetToNewChat();
    if (isMobile()) setSidebar(false);
    els.input.focus();
  });

  // Voice input uses the browser's built-in speech recognition. The button is hidden where it isn't supported.
  const SpeechApi = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechApi) {
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
  } else {
    els.mic.classList.add('hidden');
  }

  // ---------- Start ----------
  setSidebar(!isMobile());
  renderSidebar();
  renderThread();
  renderAttachments();
  updateSendState();
  autoResize();
})();
