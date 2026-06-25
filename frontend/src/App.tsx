import { createStore, produce, unwrap } from 'solid-js/store';
import { For, Show, onMount, onCleanup, createSignal, createEffect, createMemo } from 'solid-js';
import { LANGS, translateAsync, translateBatch, suggestReplies, detectCode, nowTime, setTargetLang } from './translate';
import { parseLog, buildHighlightHtml } from './parse';
import { loadSettings, saveSettings, codexAvailable, isTauri, loadChats, saveChats } from './settings';

// ===== Types =====
type Chat = {
  initial: string;
  name: string;
  preview: string;
  time: string;
  lang: string;
  bg: string;
  untitled?: boolean;
  detecting?: boolean;
  langLocked?: boolean;     // interlocutor language was chosen manually (overrides auto-detect)
};
type Msg = {
  id: number;
  name: string;
  source: string;
  translation: string;
  self: boolean;
  showName: boolean;
  time: string;
  translating: boolean;
  toLang?: string;          // language this message is translated INTO
  suggestions?: string[];   // cached reply suggestions (for incoming messages)
};
type Chip = { id: number; name: string; text: string; self: boolean; start: number; end: number };
type State = {
  value: string;
  chips: Chip[];
  selfNames: string[];
  settingsInput: string;
  searchQuery: string;
  settingsOpen: boolean;
  activeName: string;
  editingName: boolean;
  nameDraft: string;
  targetLang: string;
  ctxOpen: boolean;
  ctxX: number;
  ctxY: number;
  ctxName: string;
  editingRow: string;
  rowDraft: string;
  chats: Chat[];
  sentByChat: Record<string, Msg[]>;
};

export default function App() {
  const [state, setStore] = createStore<State>({
    value: '',
    chips: [],
    selfNames: [],
    settingsInput: '',
    searchQuery: '',
    settingsOpen: false,
    activeName: '',
    editingName: false,
    nameDraft: '',
    targetLang: 'English',
    ctxOpen: false,
    ctxX: 0,
    ctxY: 0,
    ctxName: '',
    editingRow: '',
    rowDraft: '',
    chats: [],
    sentByChat: {},
  });

  // setState helper mirroring React-style partial merges (object or updater fn).
  const setState = (update: Partial<State> | ((s: State) => Partial<State>)) => {
    const partial = typeof update === 'function' ? (update as (s: State) => Partial<State>)(state) : update;
    setStore(
      produce((d) => {
        for (const k in partial) (d as any)[k] = (partial as any)[k];
      }),
    );
  };

  // Whether a `codex` binary was detected on this machine.
  type CodexState = 'checking' | 'found' | 'missing' | 'browser';
  const [codexState, setCodexState] = createSignal<CodexState>('checking');
  const checkCodex = () => {
    if (!isTauri()) { setCodexState('browser'); return; }
    setCodexState('checking');
    codexAvailable().then((ok) => setCodexState(ok ? 'found' : 'missing'));
  };
  const codexDot = () => { const s = codexState(); return s === 'found' ? '#86e0a8' : s === 'missing' ? '#ffb4ab' : '#76777c'; };
  const codexLabel = () => {
    switch (codexState()) {
      case 'found': return 'Codex found on this computer';
      case 'missing': return 'Codex not found — messages stay untranslated';
      case 'browser': return 'Run the desktop app to detect Codex';
      default: return 'Checking for Codex…';
    }
  };
  const codexIcon = () => {
    switch (codexState()) {
      case 'found': return 'check_circle';
      case 'missing': return 'error';
      case 'browser': return 'desktop_windows';
      default: return 'autorenew';
    }
  };
  const codexSpin = () => codexState() === 'checking';

  // Non-reactive instance fields.
  let cid = 1;
  let chatsReady = false;           // becomes true once persisted chats are loaded
  let chatSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let inputRef: HTMLTextAreaElement | undefined;
  let hlRef: HTMLDivElement | undefined;
  let mainRef: HTMLElement | undefined;
  let paneRef: HTMLElement | undefined;
  let nameInputRef: HTMLInputElement | undefined;
  let rowInputRef: HTMLInputElement | undefined;

  // ===== Helpers =====
  function nowTime() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  // Pin the chat scroll to the bottom. Runs across a couple of frames/timeouts so
  // it survives late layout (skeletons growing, fonts/render settling).
  function scrollSoon() {
    const go = () => { if (mainRef) mainRef.scrollTop = mainRef.scrollHeight; };
    requestAnimationFrame(go);
    setTimeout(go, 60);
    setTimeout(go, 180);
  }
  // Auto-grow the input and keep the highlight overlay scroll-aligned with it.
  function resizeInput() {
    if (!inputRef) return;
    inputRef.style.height = '36px';
    if (inputRef.scrollHeight > 36) inputRef.style.height = Math.min(inputRef.scrollHeight, 120) + 'px';
    if (hlRef) hlRef.scrollTop = inputRef.scrollTop;
  }
  const onInputScroll = (e: any) => { if (hlRef) hlRef.scrollTop = e.target.scrollTop; };
  // Re-derive the parsed messages from the source text (idempotent). Auto-names an
  // untitled chat from the first parsed sender on first parse only.
  const reparse = (text: string) => {
    const parsed = parseLog(text, state.selfNames);
    const chips: Chip[] = parsed.map((m, i) => ({
      id: state.chips[i] ? state.chips[i].id : cid++,
      name: m.name, text: m.text, self: m.self, start: m.start, end: m.end,
    }));
    let activeName = state.activeName;
    let chats = state.chats;
    let sentByChat = state.sentByChat;
    let detect: { name: string; text: string } | null = null;
    const active = chats.find((c) => c.name === activeName);
    if (active && active.untitled && parsed.length) {
      const cand = parsed.find((c) => !c.self) || parsed[0];
      if (cand && cand.name) {
        const newName = cand.name;
        const initial = (newName.match(/\S/) || ['?'])[0].toUpperCase();
        // A manually chosen interlocutor language wins: don't reset it to detecting.
        const locked = !!active.langLocked;
        chats = chats.map((c) => (c.name === activeName ? { ...c, name: newName, initial, untitled: false, ...(locked ? {} : { lang: 'NEW', detecting: true }) } : c));
        sentByChat = { ...sentByChat };
        if (activeName in sentByChat) { sentByChat[newName] = sentByChat[activeName]; delete sentByChat[activeName]; }
        activeName = newName;
        if (!locked) detect = { name: newName, text: cand.text };
      }
    }
    setState({ value: text, chips, chats, sentByChat, activeName });
    if (detect) {
      const d = detect;
      setTimeout(() => {
        const code = detectCode(d.text);
        setState((st) => ({ chats: st.chats.map((c) => (c.name === d.name ? { ...c, lang: code, detecting: false } : c)) }));
      }, 1700);
    }
  };
  const highlightHtml = () => buildHighlightHtml(state.value, state.chips);
  function swapAnim() {
    const root = paneRef;
    if (!root) return;
    const nodes = root.querySelectorAll<HTMLElement>('.ls-swap');
    nodes.forEach((el, i) => {
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
      el.style.animationDelay = (i === nodes.length - 1 ? 0.1 : 0) + 's';
    });
  }
  // Build a bounded slice of recent chat history (most recent first-capped on the
  // backend) to give Codex conversational context. `beforeId`, when set, stops at
  // the message being translated so its own text isn't fed back as context.
  const HIST_LIMIT = 12;
  function histFor(chat: string, beforeId?: number): { speaker: string; text: string }[] {
    const list = state.sentByChat[chat] || [];
    const out: { speaker: string; text: string }[] = [];
    for (const m of list) {
      if (beforeId != null && m.id >= beforeId) break;
      if (!m.source || !m.source.trim()) continue;
      out.push({ speaker: m.self ? 'Me' : m.name || '?', text: m.source });
    }
    return out.slice(-HIST_LIMIT);
  }

  function revealTranslation(id: number, src: string, started: number, chat: string, toLang?: string) {
    translateAsync(src, toLang, histFor(chat, id), chat).then((tr) => {
      const wait = Math.max(0, 1400 - (Date.now() - started));
      setTimeout(() => {
        setState((st) => {
          const list = (st.sentByChat[chat] || []).map((x) => (x.id === id ? { ...x, translation: tr, translating: false } : x));
          return { sentByChat: { ...st.sentByChat, [chat]: list } };
        });
        scrollSoon();
      }, wait);
    });
  }
  // Translate every message from one send, grouped by translation direction so a
  // mixed paste (your messages + theirs) goes out as one batch per language.
  function revealTranslationBatch(items: { id: number; src: string; toLang: string }[], started: number, chat: string) {
    if (!items.length) return;
    const groups = new Map<string, { id: number; src: string }[]>();
    for (const it of items) {
      const lang = it.toLang || state.targetLang;
      let g = groups.get(lang);
      if (!g) { g = []; groups.set(lang, g); }
      g.push({ id: it.id, src: it.src });
    }
    // Context = everything in the chat before this batch (the lowest pending id).
    const boundary = Math.min(...items.map((it) => it.id));
    const history = histFor(chat, boundary);
    const byId = new Map<number, string>();
    const tasks = [...groups.entries()].map(([lang, group]) =>
      translateBatch(group.map((g) => g.src), lang, history, chat).then((trs) => {
        group.forEach((g, i) => byId.set(g.id, trs[i] ?? g.src));
      }),
    );
    Promise.all(tasks).then(() => {
      const wait = Math.max(0, 1400 - (Date.now() - started));
      setTimeout(() => {
        setState((st) => {
          const list = (st.sentByChat[chat] || []).map((x) =>
            byId.has(x.id) ? { ...x, translation: byId.get(x.id)!, translating: false } : x,
          );
          return { sentByChat: { ...st.sentByChat, [chat]: list } };
        });
        scrollSoon();
      }, wait);
    });
  }

  // ===== Conversations =====
  const openSettings = () => { setState({ settingsOpen: true }); checkCodex(); };
  const closeSettings = () => setState({ settingsOpen: false });
  const stopProp = (e: Event) => e.stopPropagation();
  const onSelect = (e: any) => {
    if (e.currentTarget.dataset.name === state.activeName) return;
    swapAnim();
    setState({ activeName: e.currentTarget.dataset.name });
  };

  const onRowContext = (e: any) => {
    e.preventDefault();
    setState({ ctxOpen: true, ctxX: e.clientX, ctxY: e.clientY, ctxName: e.currentTarget.dataset.name });
  };
  const closeCtx = () => setState({ ctxOpen: false });
  const ctxBackdrop = (e: Event) => { e.preventDefault(); setState({ ctxOpen: false }); };
  const ctxEdit = () => {
    const c = state.chats.find((x) => x.name === state.ctxName);
    setState({ editingRow: state.ctxName, rowDraft: c && !c.untitled ? c.name : '', ctxOpen: false });
    setTimeout(() => { if (rowInputRef) { rowInputRef.focus(); rowInputRef.select(); } }, 30);
  };
  const ctxDelete = () => {
    const name = state.ctxName;
    const chats = state.chats.filter((c) => c.name !== name);
    const sentByChat = { ...state.sentByChat };
    delete sentByChat[name];
    let activeName = state.activeName;
    if (activeName === name) activeName = chats.length ? chats[0].name : '';
    setState({ chats, sentByChat, activeName, ctxOpen: false });
    toast('Чат удалён', 'del');
  };

  // ----- Message context menu (right-click a bubble) + inline edit -----
  const [msgCtx, setMsgCtx] = createSignal<{ open: boolean; x: number; y: number; id: number }>({ open: false, x: 0, y: 0, id: -1 });
  const [editingMsgId, setEditingMsgId] = createSignal<number>(-1);
  const [msgDraft, setMsgDraft] = createSignal('');

  // ----- Toast notifications -----
  type Toast = { id: number; text: string; icon: string; tone: 'ok' | 'del' | 'edit' };
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  const [leavingToasts, setLeavingToasts] = createSignal<number[]>([]);
  let toastSeq = 1;
  const toastIcon = (tone: Toast['tone']) => (tone === 'del' ? 'delete' : tone === 'edit' ? 'edit' : 'check_circle');
  const toastColor = (tone: Toast['tone']) => (tone === 'del' ? '#ffb4ab' : tone === 'edit' ? '#bdc7d7' : '#86e0a8');
  const dismissToast = (id: number) => {
    setLeavingToasts((l) => (l.includes(id) ? l : [...l, id]));
    setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id));
      setLeavingToasts((l) => l.filter((x) => x !== id));
    }, 220);
  };
  // Push a transient toast. tone drives the icon + accent colour (ok / del / edit).
  const toast = (text: string, tone: Toast['tone'] = 'ok') => {
    const id = toastSeq++;
    setToasts((list) => [...list.slice(-3), { id, text, icon: toastIcon(tone), tone }]);
    setTimeout(() => dismissToast(id), 2400);
  };

  // Copy a message's translation to the clipboard, with a brief "copied" tick.
  const [copiedId, setCopiedId] = createSignal<number>(-1);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  // Synchronous textarea+execCommand fallback for when the async clipboard API is missing
  // or rejects (e.g. some WKWebView contexts).
  const fallbackCopy = (text: string) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.top = '-9999px'; ta.style.opacity = '0'; ta.style.pointerEvents = 'none';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    } catch (_) { /* clipboard unavailable */ }
  };
  const writeClipboard = (text: string) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
        return;
      }
    } catch (_) { /* fall through to execCommand */ }
    fallbackCopy(text);
  };
  // Feedback (tick + toast) fires synchronously so it never waits on the clipboard
  // round-trip, which can stall on WKWebView; the write itself runs fire-and-forget.
  const copyText = (text: string, id: number) => {
    if (!text) return;
    setCopiedId(id);
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => setCopiedId(-1), 1200);
    toast('Скопировано', 'ok');
    writeClipboard(text);
  };
  // Click a translated line → copy it straight to the clipboard (instant; sidesteps the
  // backdrop-filter re-blur that native text selection triggers behind the frosted header/
  // input bars). A manual drag-selection inside the line is respected — no copy in that case.
  const copyOnClick = (e: MouseEvent, text: string, id: number) => {
    const el = e.currentTarget as HTMLElement | null;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && el && el.contains(sel.anchorNode)) return;
    copyText(text, id);
  };
  const msgList = () => state.sentByChat[state.activeName] || [];
  const onMsgContext = (e: MouseEvent, m: { id: number }) => {
    e.preventDefault();
    setMsgCtx({ open: true, x: e.clientX, y: e.clientY, id: m.id });
  };
  const closeMsgCtx = () => setMsgCtx((c) => ({ ...c, open: false }));
  const startMsgEdit = () => {
    const id = msgCtx().id;
    const m = msgList().find((x) => x.id === id);
    setMsgCtx((c) => ({ ...c, open: false }));
    if (!m) return;
    setEditingMsgId(id);
    setMsgDraft(m.source);
  };
  const deleteMsg = () => {
    const id = msgCtx().id;
    const chat = state.activeName;
    setMsgCtx((c) => ({ ...c, open: false }));
    record('msgdelete');
    setState({ sentByChat: { ...state.sentByChat, [chat]: msgList().filter((m) => m.id !== id) } });
    toast('Сообщение удалено', 'del');
  };
  const onMsgEditInput = (e: any) => setMsgDraft(e.currentTarget.value);
  const onMsgEditKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitMsgEdit(); }
    else if (e.key === 'Escape') setEditingMsgId(-1);
  };
  const commitMsgEdit = () => {
    const id = editingMsgId();
    if (id < 0) return;
    const chat = state.activeName;
    const draft = msgDraft().trim();
    const m = msgList().find((x) => x.id === id);
    if (!m || !draft || draft === m.source) { setEditingMsgId(-1); return; }
    record('msgedit');
    // Recompute the translation direction from the edited text's language (e.g. you
    // rewrote a Russian message in Chinese) instead of reusing the stale stored one.
    const toLang = directionFor(draft, m.self, chat);
    const list = msgList().map((x) => (x.id === id ? { ...x, source: draft, translation: '', translating: true, toLang } : x));
    setState({ sentByChat: { ...state.sentByChat, [chat]: list } });
    setEditingMsgId(-1);
    revealTranslation(id, draft, Date.now(), chat, toLang);
    toast('Сообщение изменено', 'edit');
  };
  // Renders a message's source: the text, or an inline editor while editing it.
  const MsgSource = (props: { m: { id: number; source: string } }) => (
    <Show when={editingMsgId() === props.m.id} fallback={<>{props.m.source}</>}>
      <textarea
        value={msgDraft()}
        onInput={onMsgEditInput}
        onKeyDown={onMsgEditKey}
        onBlur={commitMsgEdit}
        ref={(el) => setTimeout(() => { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) {} }, 20)}
        style="width:100%; box-sizing:border-box; resize:none; min-height:40px; font-family:'JetBrains Mono', monospace; font-size:13.5px; line-height:1.5; color:#e4e2e3; background:rgba(13,13,14,0.55); border:1px solid rgba(189,199,215,0.45); border-radius:8px; outline:none; padding:6px 8px;"
      />
    </Show>
  );

  const onRowDraftInput = (e: any) => setState({ rowDraft: e.target.value });
  const onRowKey = (e: any) => {
    if (e.key === 'Enter') { e.preventDefault(); commitRow(); }
    else if (e.key === 'Escape') setState({ editingRow: '' });
  };
  const commitRow = () => {
    const old = state.editingRow;
    if (!old) return;
    const newName = (state.rowDraft || '').trim();
    if (!newName || newName === old) { setState({ editingRow: '' }); return; }
    const initial = (newName.match(/\S/) || ['?'])[0].toUpperCase();
    const chats = state.chats.map((c) => (c.name === old ? { ...c, name: newName, initial, untitled: false } : c));
    const sentByChat = { ...state.sentByChat };
    if (old in sentByChat) { sentByChat[newName] = sentByChat[old]; delete sentByChat[old]; }
    const activeName = state.activeName === old ? newName : state.activeName;
    setState({ chats, sentByChat, activeName, editingRow: '' });
    toast('Имя изменено на ' + newName, 'edit');
  };

  const onNameDblClick = () => {
    const c = state.chats.find((x) => x.name === state.activeName);
    setState({ editingName: true, nameDraft: c && !c.untitled ? c.name : '' });
    setTimeout(() => { if (nameInputRef) { nameInputRef.focus(); nameInputRef.select(); } }, 30);
  };
  const onNameInput = (e: any) => setState({ nameDraft: e.target.value });
  const onNameKey = (e: any) => {
    if (e.key === 'Enter') { e.preventDefault(); commitName(); }
    else if (e.key === 'Escape') setState({ editingName: false });
  };
  const commitName = () => {
    if (!state.editingName) return;
    const newName = (state.nameDraft || '').trim();
    const old = state.activeName;
    if (!newName || newName === old) { setState({ editingName: false }); return; }
    const initial = (newName.match(/\S/) || ['?'])[0].toUpperCase();
    const chats = state.chats.map((c) => (c.name === old ? { ...c, name: newName, initial, untitled: false } : c));
    const sentByChat = { ...state.sentByChat };
    if (old in sentByChat) { sentByChat[newName] = sentByChat[old]; delete sentByChat[old]; }
    setState({ chats, sentByChat, activeName: newName, editingName: false });
    toast('Имя изменено на ' + newName, 'edit');
  };

  // Create a fresh untitled chat, make it active, and return its (internal) name.
  const createChat = (): string => {
    const palette = [
      'linear-gradient(145deg,#5a4e63,#332b3a)', 'linear-gradient(145deg,#4e5d63,#2b343a)',
      'linear-gradient(145deg,#63584e,#3a322b)', 'linear-gradient(145deg,#4e6359,#2b3a33)',
      'linear-gradient(145deg,#46494f,#2a2a2b)',
    ];
    const bg = palette[state.chats.length % palette.length];
    const name = '__new' + cid++;
    const chat: Chat = { initial: '?', name, untitled: true, preview: 'No messages yet', time: 'now', lang: 'NEW', bg };
    setState({ chats: [chat, ...state.chats], activeName: name, sentByChat: { ...state.sentByChat, [name]: [] } });
    return name;
  };
  const openNewChat = () => {
    createChat();
    setTimeout(() => swapAnim(), 0);
  };

  // ===== Settings =====
  // Persist targetLang + selfNames to the Tauri store (falls back to
  // localStorage outside Tauri) so they survive restarts.
  const persistSettings = () => { void saveSettings({ targetLang: state.targetLang, selfNames: state.selfNames }); };
  const addSelf = (v: string) => {
    if (!v) return;
    if (state.selfNames.some((n) => n.trim().toLowerCase() === v.trim().toLowerCase())) { setState({ settingsInput: '' }); return; }
    setState({ selfNames: [...state.selfNames, v], settingsInput: '' });
    persistSettings();
  };
  const onSettingsInput = (e: any) => setState({ settingsInput: e.target.value });
  const onSearchInput = (e: any) => setState({ searchQuery: e.target.value });
  const onAddSelf = () => addSelf(state.settingsInput.trim());
  const onAddFiller = () => addSelf('ㅤ');
  const onRemoveSelf = (e: any) => {
    const name = e.currentTarget.dataset.name;
    setState({ selfNames: state.selfNames.filter((n) => n !== name) });
    persistSettings();
  };
  const onSetTarget = (e: any) => {
    setState({ targetLang: e.currentTarget.dataset.lang });
    setTargetLang(state.targetLang);
    persistSettings();
  };

  // ===== Undo / Redo =====
  // Snapshots store the source text; chips are re-derived from it on restore.
  type Snap = { value: string; sentByChat: Record<string, Msg[]> };
  let past: Snap[] = [];
  let future: Snap[] = [];
  let lastAction: string | null = null;
  const snap = (): Snap => ({
    value: state.value,
    sentByChat: JSON.parse(JSON.stringify(state.sentByChat)),
  });
  const record = (action: string) => {
    const coalesce = action === lastAction && action === 'type';
    lastAction = action;
    if (coalesce) return;
    past.push(snap());
    if (past.length > 120) past.shift();
    future = [];
  };
  const applySnap = (s: Snap) => {
    const parsed = parseLog(s.value, state.selfNames);
    const chips: Chip[] = parsed.map((m) => ({ id: cid++, name: m.name, text: m.text, self: m.self, start: m.start, end: m.end }));
    setState({ value: s.value, chips, sentByChat: s.sentByChat });
    setTimeout(resizeInput, 0);
  };
  const undo = () => { if (!past.length) return; future.push(snap()); lastAction = 'undo'; applySnap(past.pop()!); };
  const redo = () => { if (!future.length) return; past.push(snap()); lastAction = 'redo'; applySnap(future.pop()!); };
  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  };
  // ----- AI reply suggestions, based on the last message FROM the other person -----
  const [suggestions, setSuggestions] = createSignal<string[]>([]);
  const [suggesting, setSuggesting] = createSignal(false);
  // The most recent message, but ONLY if it's from the other person — so while my
  // own message is the latest one, no suggestions are shown/generated.
  const lastIncoming = () => {
    const list = state.sentByChat[state.activeName] || [];
    const last = list[list.length - 1];
    return last && !last.self ? last : null;
  };
  const useSuggestion = (text: string) => {
    setState({ value: text });
    setTimeout(() => { resizeInput(); if (inputRef) inputRef.focus(); }, 0);
  };
  // Regenerate ONLY when the last message from the other person changes (a new
  // incoming message). Replies are cached per message id, so sending your own
  // messages, a translation completing, or changing the language never re-runs it.
  let suggestId = -1;
  createEffect(() => {
    const m = lastIncoming();
    const id = m ? m.id : -1;
    if (id === suggestId) return;
    suggestId = id;
    if (!m) { setSuggestions([]); setSuggesting(false); return; }
    // Already generated for THIS message? Reuse it (cached on the message, so it
    // also survives a restart) instead of regenerating.
    if (Array.isArray(m.suggestions)) { setSuggestions(m.suggestions); setSuggesting(false); return; }
    setSuggestions([]);
    setSuggesting(true);
    const chat = state.activeName;
    suggestReplies(m.source, state.targetLang, histFor(chat, m.id), chat).then((s) => {
      if (s.length) {
        setState({ sentByChat: { ...state.sentByChat, [chat]: (state.sentByChat[chat] || []).map((x) => (x.id === id ? { ...x, suggestions: s } : x)) } });
      }
      if (suggestId === id) { setSuggestions(s); setSuggesting(false); }
    });
  });

  // Keep the chat pinned to the bottom: jump there when the active chat changes
  // or a new message is added (keyed on activeName + last message id, so a
  // translation completing or an edit doesn't yank the scroll).
  let lastScrollKey = '';
  createEffect(() => {
    const an = state.activeName;
    const list = state.sentByChat[an] || [];
    const key = an + ':' + (list.length ? list[list.length - 1].id : -1);
    if (key === lastScrollKey) return;
    lastScrollKey = key;
    scrollSoon();
  });

  // Persist chats + messages (debounced), but only after the initial load so we
  // never overwrite saved data with the empty startup state.
  createEffect(() => {
    const snapshot = { chats: unwrap(state.chats), sentByChat: unwrap(state.sentByChat), activeName: state.activeName };
    if (!chatsReady) return;
    clearTimeout(chatSaveTimer);
    chatSaveTimer = setTimeout(() => { void saveChats(snapshot); }, 250);
  });

  onMount(() => {
    document.addEventListener('keydown', onKey);
    checkCodex();
    // Load persisted targetLang + selfNames (Tauri store / localStorage fallback).
    loadSettings().then((s) => {
      setState({ targetLang: s.targetLang, selfNames: s.selfNames });
      setTargetLang(s.targetLang);
      if (state.value) reparse(state.value);
    });
    // Load persisted chats + messages; clear any half-finished translations.
    loadChats().then((data) => {
      if (data && Array.isArray(data.chats)) {
        const chats = (data.chats as Chat[]).map((c) => ({ ...c, detecting: false }));
        const sentByChat = (data.sentByChat && typeof data.sentByChat === 'object' ? data.sentByChat : {}) as Record<string, Msg[]>;
        let maxId = 0;
        for (const k in sentByChat) {
          const list = sentByChat[k];
          if (!Array.isArray(list)) { sentByChat[k] = []; continue; }
          for (const m of list) {
            if (typeof m.id === 'number' && m.id > maxId) maxId = m.id;
            if (m.translating) { m.translating = false; if (!m.translation) m.translation = m.source; }
          }
        }
        cid = Math.max(cid, maxId + 1);
        let activeName = typeof data.activeName === 'string' ? data.activeName : '';
        if (activeName && !chats.some((c) => c.name === activeName)) activeName = chats.length ? chats[0].name : '';
        setState({ chats, sentByChat, activeName });
      }
      chatsReady = true;
    });
    if (state.value) reparse(state.value);
    setTimeout(resizeInput, 0);
  });
  onCleanup(() => document.removeEventListener('keydown', onKey));

  // ===== Input parsing (the textarea is the source of truth) =====
  // The pasted/typed text stays in the input; parseLog re-derives the message list
  // from it on every change — idempotently, so nothing is parsed "as new" twice.
  const onInput = (e: any) => {
    record(e.inputType === 'insertFromPaste' ? 'paste' : 'type');
    resizeInput();
    reparse(e.target.value);
  };

  // Enter sends; Shift+Enter inserts a newline. The `isComposing` / keyCode 229
  // checks guard IME input (e.g. typing Chinese/Japanese) so confirming a
  // candidate with Enter doesn't fire a send.
  const onInputKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (e as any).keyCode !== 229) {
      e.preventDefault();
      onSend();
    }
  };

  // Delete a parsed message by removing its source line(s) from the input.
  const onChipDelete = (e: any) => {
    record('chipdelete');
    const start = +e.currentTarget.dataset.start;
    const end = +e.currentTarget.dataset.end;
    const lines = state.value.split('\n');
    lines.splice(start, end - start + 1);
    reparse(lines.join('\n'));
    setTimeout(resizeInput, 0);
  };
  // Clear removes every parsed line from the source but keeps any free-typed text.
  const onClearChips = () => {
    record('clear');
    const covered = new Set<number>();
    for (const c of state.chips) for (let i = c.start; i <= c.end; i++) covered.add(i);
    const lines = state.value.split('\n').filter((_, i) => !covered.has(i));
    reparse(lines.join('\n'));
    setTimeout(resizeInput, 0);
  };

  const onSend = () => {
    record('send');
    // No chat yet? Auto-create one so the first message has somewhere to land.
    if (!state.chats.some((c) => c.name === state.activeName)) createChat();
    const chat = state.activeName;
    const cur = state.sentByChat[chat] || [];
    const chips = state.chips;
    const now = nowTime();
    if (chips.length) {
      const list = cur.slice();
      // Skip chips whose (sender + text) is already in this dialog — or repeats
      // earlier in the same paste — so identical messages aren't added twice.
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
      const seen = new Set(cur.map((m) => m.name + ' ' + norm(m.source)));
      let prevName: string | null = list.length ? list[list.length - 1].name : null;
      // Direction is chosen by each message's OWN detected language, not by who sent
      // it: text in my target language goes to the interlocutor's language; text in
      // the interlocutor's language (or anything else) comes back into my target —
      // so my own Chinese reply still gets translated to Russian, not echoed.
      const ilLang = resolveInterlocutorLang(chat, chips.map((c) => ({ self: c.self, source: c.text })));
      const pending: { id: number; src: string; toLang: string }[] = [];
      for (const c of chips) {
        if (!c.text.trim()) continue;
        const key = c.name + ' ' + norm(c.text);
        if (seen.has(key)) continue;
        seen.add(key);
        const id = cid++;
        const toLang = directionFor(c.text, c.self, chat, ilLang);
        list.push({ id, name: c.name, source: c.text, translation: '', self: c.self, showName: c.name !== prevName, time: now, translating: true, toLang });
        pending.push({ id, src: c.text, toLang });
        prevName = c.name;
      }
      setState({ chips: [], value: '', sentByChat: { ...state.sentByChat, [chat]: list } });
      setTimeout(resizeInput, 0);
      scrollSoon();
      const started = Date.now();
      revealTranslationBatch(pending, started, chat);
      return;
    }
    const text = state.value.trim();
    if (!text) return;
    const id = cid++;
    const prevName = cur.length ? cur[cur.length - 1].name : null;
    // Unformatted message: if it's already in the target language it's mine ("You");
    // anything in another (source) language is treated as the other person's.
    const mine = detectCode(text) === targetCode();
    const senderName = mine ? 'You' : chat;
    // My (target-language) message → translate into the interlocutor's language;
    // their message → translate into my target language.
    const toLang = mine ? resolveInterlocutorLang(chat) : state.targetLang;
    const msg: Msg = { id, name: senderName, source: text, translation: '', self: mine, showName: senderName !== prevName, time: now, translating: true, toLang };
    setState({ value: '', sentByChat: { ...state.sentByChat, [chat]: [...cur, msg] } });
    if (inputRef) { inputRef.style.height = '36px'; inputRef.value = ''; }
    scrollSoon();
    revealTranslation(id, text, Date.now(), chat, toLang);
  };

  // ===== Derived view values =====
  // Language code shown on translated bubbles.
  const TARGET_CODE: Record<string, string> = { English: 'EN', Spanish: 'ES', French: 'FR', German: 'DE', Russian: 'RU', Japanese: 'JA', Chinese: 'ZH', Korean: 'KO' };
  const codeOf = (langName: string) => TARGET_CODE[langName] || (langName || '').slice(0, 2).toUpperCase();
  const targetCode = () => codeOf(state.targetLang);

  // The interlocutor's language for a chat (the non-target language used here),
  // detected from its messages. `extra` lets a fresh paste contribute before it's
  // stored. Falls back to the target language (making the direction a no-op) when
  // the other language is unknown.
  const resolveInterlocutorLang = (chatName: string, extra: { self: boolean; source: string }[] = []): string => {
    // A manual choice is authoritative — never overridden by message auto-detect.
    const locked = state.chats.find((x) => x.name === chatName);
    if (locked && locked.langLocked && LANGS[locked.lang]) return LANGS[locked.lang];
    const scan = (src: string) => { const n = LANGS[detectCode(src)]; return n && n !== state.targetLang ? n : null; };
    const list = state.sentByChat[chatName] || [];
    for (let i = list.length - 1; i >= 0; i--) if (!list[i].self) { const n = scan(list[i].source); if (n) return n; }
    for (const e of extra) if (!e.self) { const n = scan(e.source); if (n) return n; }
    const c = state.chats.find((x) => x.name === chatName);
    if (c && c.lang && LANGS[c.lang] && LANGS[c.lang] !== state.targetLang) return LANGS[c.lang];
    return state.targetLang;
  };

  // The language a given message should be translated INTO, decided by the
  // message's OWN detected language (not by who sent it). Mine written in my target
  // language → the interlocutor's language; mine written in the interlocutor's
  // language (or anything else) → back into my target. Incoming → my target.
  // Used on send AND on edit, so re-translating an edited message picks the right
  // direction instead of reusing the stale stored one.
  const directionFor = (src: string, self: boolean, chatName: string, ilLang?: string): string => {
    if (!self) return state.targetLang;
    const il = ilLang ?? resolveInterlocutorLang(chatName);
    return detectCode(src) === targetCode() ? il : state.targetLang;
  };

  // Avatars derive from the chat name, so they regenerate (colour + initial) on rename.
  const AVATAR_BGS = [
    'linear-gradient(145deg,#5a4e63,#332b3a)', 'linear-gradient(145deg,#4e5d63,#2b343a)',
    'linear-gradient(145deg,#63584e,#3a322b)', 'linear-gradient(145deg,#4e6359,#2b3a33)',
    'linear-gradient(145deg,#46494f,#2a2a2b)', 'linear-gradient(145deg,#4e5063,#2b2c3a)',
    'linear-gradient(145deg,#634e4e,#3a2b2b)', 'linear-gradient(145deg,#4e6363,#2b3a3a)',
  ];
  const hashStr = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
  const avatarBg = (c: { name: string; untitled?: boolean }) => (c.untitled ? 'linear-gradient(145deg,#3a3a3c,#242425)' : AVATAR_BGS[hashStr(c.name) % AVATAR_BGS.length]);
  const avatarInitial = (c: { name: string; untitled?: boolean }) => (c.untitled ? '?' : (c.name.match(/\S/) || ['?'])[0].toUpperCase());

  const activeConv = () => state.chats.find((c) => c.name === state.activeName) || state.chats[0];
  const activeDisplay = () => { const a = activeConv(); return a ? (a.untitled ? 'New chat' : a.name) : ''; };
  const hasChat = () => state.chats.length > 0 && !!activeConv();
  const showNoChats = () => state.chats.length === 0;
  const rawSent = () => state.sentByChat[state.activeName] || [];
  const showEmpty = () => hasChat() && rawSent().length === 0;
  const detecting = () => !!(activeConv() && activeConv().detecting);
  const routeSource = () => { const a = activeConv(); return a ? LANGS[a.lang] || 'Auto-detect' : 'Auto-detect'; };
  const isAuto = () => !detecting() && routeSource() === 'Auto-detect';
  const hasLang = () => !detecting() && routeSource() !== 'Auto-detect';

  // ----- Interlocutor language picker (header) -----
  // The list offered in the dropdown (code -> display name).
  const INTERLOCUTOR_LANGS = ['ZH', 'JA', 'KO', 'RU', 'ES', 'FR', 'DE', 'EN'].map((code) => ({ code, name: LANGS[code] }));
  const [langMenu, setLangMenu] = createSignal<{ open: boolean; x: number; y: number }>({ open: false, x: 0, y: 0 });
  const activeLangLocked = () => { const a = activeConv(); return !!(a && a.langLocked); };
  const openLangMenu = (e: MouseEvent) => {
    if (!hasChat()) return;
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Anchor under the badge, nudged so a ~190px menu stays on-screen.
    setLangMenu({ open: true, x: Math.max(8, Math.min(r.right - 190, window.innerWidth - 198)), y: r.bottom + 6 });
  };
  const closeLangMenu = () => setLangMenu((m) => ({ ...m, open: false }));
  // Set the active chat's interlocutor language. `null` clears the manual lock and
  // returns to auto-detect (re-derived from the latest incoming message).
  const setInterlocutorLang = (code: string | null) => {
    const name = state.activeName;
    setState((st) => ({
      chats: st.chats.map((c) => {
        if (c.name !== name) return c;
        if (code == null) {
          const list = st.sentByChat[name] || [];
          let detected = 'NEW';
          for (let i = list.length - 1; i >= 0; i--) {
            const m = list[i];
            if (!m.self && m.source && m.source.trim()) { detected = detectCode(m.source); break; }
          }
          return { ...c, lang: detected, langLocked: false, detecting: false };
        }
        return { ...c, lang: code, langLocked: true, detecting: false };
      }),
    }));
    closeLangMenu();
  };

  const conversations = createMemo(() => {
    const q = state.searchQuery.trim().toLowerCase();
    // Derive the row preview + time from the latest actual message in the chat,
    // falling back to the chat's own placeholder when it has no messages yet.
    const rows = state.chats.map((c) => {
      const list = state.sentByChat[c.name];
      const last = list && list.length ? list[list.length - 1] : null;
      const preview = last
        ? (((last.translation && !last.translating ? last.translation : last.source) || '').replace(/\s+/g, ' ').trim() || 'No messages yet')
        : 'No messages yet';
      return {
        ...c,
        preview,
        time: last ? last.time : c.time,
        active: c.name === state.activeName,
        rowBg: c.name === state.activeName ? 'rgba(53,53,54,0.55)' : 'transparent',
        display: c.untitled ? 'New chat' : c.name,
        editing: c.name === state.editingRow,
        notEditing: c.name !== state.editingRow,
      };
    });
    return q ? rows.filter((c) => (c.name + ' ' + c.preview + ' ' + c.lang).toLowerCase().includes(q)) : rows;
  });
  const noResults = () => state.searchQuery.trim().length > 0 && conversations().length === 0;

  const hasChips = () => state.chips.length > 0;
  const hot = () => state.value.trim().length > 0 || hasChips();

  const targetOptions = () =>
    ['English', 'Spanish', 'French', 'German', 'Russian', 'Japanese', 'Chinese'].map((n) => ({
      name: n,
      bg: n === state.targetLang ? 'rgba(189,199,215,0.16)' : 'rgba(53,53,54,0.55)',
      color: n === state.targetLang ? '#bdc7d7' : '#c5c6cc',
      border: n === state.targetLang ? 'rgba(189,199,215,0.45)' : 'rgba(68,71,75,0.5)',
    }));
  const selfNamesView = () =>
    state.selfNames.map((n) => ({ name: n, display: /^[\sㅤㅤ·]*$/.test(n) ? 'ㅤ — empty placeholder' : n }));

  const sendBg = () => (hot() ? 'linear-gradient(155deg,#dbe4f4,#b4bfd1)' : 'rgba(70,73,79,0.55)');
  const sendColor = () => (hot() ? '#1c2531' : '#76777c');
  const sendBorder = () => (hot() ? 'rgba(219,228,244,0.6)' : 'rgba(143,145,150,0.28)');
  const sendShadow = () =>
    hot()
      ? '0 4px 14px rgba(189,199,215,0.32), inset 0 1px 0 rgba(255,255,255,0.45)'
      : 'inset 0 1px 0 rgba(255,255,255,0.05)';

  const ms = "font-family:'Material Symbols Outlined';";

  return (
    <div data-tauri-drag-region style="position:fixed; inset:0; display:flex; align-items:center; justify-content:center; background:#08080a; font-family:'JetBrains Mono', monospace; color:#e4e2e3; overflow:hidden;">
      {/* ambient glow */}
      <div style="position:absolute; inset:0; pointer-events:none; overflow:hidden;">
        <div style="position:absolute; top:-8%; right:6%; width:760px; height:760px; background:radial-gradient(circle, rgba(189,199,215,0.13) 0%, rgba(189,199,215,0) 70%);"></div>
        <div style="position:absolute; bottom:-12%; left:2%; width:820px; height:820px; background:radial-gradient(circle, rgba(70,73,79,0.5) 0%, rgba(70,73,79,0) 70%);"></div>
      </div>

      {/* app window — full-bleed inside the native Tauri window (no faux desktop chrome),
          with padding so the overall content is inset toward the centre */}
      <div data-tauri-drag-region style="position:relative; z-index:10; box-sizing:border-box; width:100%; height:100%; padding:64px 13vw; display:flex; flex-direction:column; overflow:visible; background:rgba(20,20,21,0.78);">
        {/* body */}
        <div style="flex:1; display:flex; gap:18px; padding:14px; min-height:0;">
          {/* ===== SIDEBAR ===== */}
          <aside style="width:320px; flex-shrink:0; display:flex; flex-direction:column; border-radius:18px; overflow:hidden; border:1px solid rgba(255,255,255,0.07); background:linear-gradient(165deg, rgba(47,47,48,0.55), rgba(21,21,22,0.55)); box-shadow:0 16px 44px rgba(0,0,0,0.5);">
            <div style="flex-shrink:0; padding:18px 16px 12px; display:flex; flex-direction:column; gap:13px;">
              <div style="display:flex; align-items:flex-end; justify-content:space-between;">
                <div>
                  <div style="font-size:18px; font-weight:700; color:#e4e2e3; letter-spacing:-0.3px;">Messages</div>
                  <div style="display:flex; align-items:center; gap:5px; margin-top:4px;">
                    <span style={ms + 'font-size:13px; color:#bdc7d7;'}>translate</span>
                    <span style="font-size:10.5px; letter-spacing:0.2px; color:#9a9ba0;">Auto-translated</span>
                  </div>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                  <button aria-label="Settings" onClick={openSettings} class="ls-settings-btn ls-press" style="width:36px; height:36px; border-radius:11px; display:flex; align-items:center; justify-content:center; cursor:pointer; background:rgba(53,53,54,0.6); color:#c5c6cc; border:1px solid rgba(143,145,150,0.28); transition:background 0.15s, color 0.15s, transform 0.08s;">
                    <span style={ms + 'font-size:20px;'}>settings</span>
                  </button>
                  <button aria-label="New chat" onClick={openNewChat} class="ls-press" style="width:36px; height:36px; border-radius:11px; display:flex; align-items:center; justify-content:center; cursor:pointer; background:linear-gradient(155deg,#dbe4f4,#b4bfd1); color:#1c2531; border:1px solid rgba(219,228,244,0.6); box-shadow:0 4px 14px rgba(189,199,215,0.28), inset 0 1px 0 rgba(255,255,255,0.45); transition:transform 0.08s;">
                    <span style={ms + 'font-size:20px;'}>edit_square</span>
                  </button>
                </div>
              </div>
              <div style="display:flex; align-items:center; gap:8px; padding:9px 12px; border-radius:12px; background:rgba(53,53,54,0.55); border:1px solid rgba(68,71,75,0.45);">
                <span style={ms + 'font-size:18px; color:#76777c;'}>search</span>
                <input value={state.searchQuery} onInput={onSearchInput} placeholder="Search conversations" style="flex:1; min-width:0; background:transparent; border:none; outline:none; font-family:'JetBrains Mono', monospace; font-size:13px; color:#e4e2e3; padding:0;" />
              </div>
            </div>

            <div class="ls-scroll" style="flex:1; overflow-y:auto; padding:4px 8px 16px; display:flex; flex-direction:column; gap:4px;">
              <For each={conversations()}>
                {(c) => (
                  <button
                    data-name={c.name}
                    onClick={onSelect}
                    onContextMenu={onRowContext}
                    class="ls-row"
                    style={`position:relative; width:100%; text-align:left; display:flex; align-items:center; gap:12px; padding:10px 12px; border-radius:14px; border:none; cursor:pointer; background:${c.rowBg}; transition:background 0.12s;`}
                  >
                    <Show when={c.active}>
                      <div style="position:absolute; left:1px; top:10px; bottom:10px; width:3px; border-radius:3px; background:#bdc7d7;"></div>
                    </Show>
                    <div style={`flex-shrink:0; width:44px; height:44px; border-radius:9999px; display:flex; align-items:center; justify-content:center; background:${avatarBg(c)}; border:1px solid rgba(143,145,150,0.25); font-size:16px; font-weight:700; color:#e6e4e5;`}>{avatarInitial(c)}</div>
                    <div style="flex:1; min-width:0;">
                      <div style="display:flex; align-items:center; gap:8px;">
                        <Show when={c.editing}>
                          <input
                            value={state.rowDraft}
                            onInput={onRowDraftInput}
                            onKeyDown={onRowKey}
                            onBlur={commitRow}
                            onClick={stopProp}
                            ref={(el) => (rowInputRef = el)}
                            style="width:150px; box-sizing:border-box; font-family:'JetBrains Mono', monospace; font-size:13px; font-weight:700; color:#e4e2e3; background:rgba(13,13,14,0.6); border:1px solid rgba(189,199,215,0.45); border-radius:7px; outline:none; padding:2px 7px;"
                          />
                        </Show>
                        <Show when={c.notEditing}>
                          <span style="font-size:13.5px; font-weight:700; color:#e4e2e3; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{c.display}</span>
                        </Show>
                        <span style="font-size:8.5px; font-weight:700; letter-spacing:0.5px; color:#8a98ac; background:rgba(189,199,215,0.12); border:1px solid rgba(189,199,215,0.2); padding:1px 5px; border-radius:5px; flex-shrink:0;">{c.lang}</span>
                      </div>
                      <div style="font-size:12px; color:#9a9ba0; margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{c.preview}</div>
                    </div>
                    <span style="flex-shrink:0; font-size:10px; color:#76777c; align-self:flex-start; margin-top:2px;">{c.time}</span>
                  </button>
                )}
              </For>
              <Show when={noResults()}>
                <div style="padding:30px 16px; text-align:center; font-size:12px; line-height:1.5; color:#76777c;">No conversations match “{state.searchQuery}”.</div>
              </Show>
            </div>
          </aside>

          {/* ===== MAIN ===== */}
          <section ref={(el) => (paneRef = el)} style="flex:1; min-width:0; display:flex; flex-direction:column; gap:16px; position:relative;">
            {/* chat header — floats over the scroll (like the input tray) so messages
                slide behind it instead of being hard-clipped; frosted glass + downward shadow */}
            <div style="position:absolute; top:0; left:0; right:0; z-index:40; padding:12px 20px; display:flex; align-items:center; gap:12px; border-radius:16px; border:1px solid rgba(255,255,255,0.07); background:linear-gradient(120deg, rgba(51,51,52,0.9), rgba(28,28,29,0.9)); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px); box-shadow:0 16px 44px rgba(0,0,0,0.5);">
              <div class="ls-swap" style={`flex-shrink:0; width:38px; height:38px; border-radius:9999px; display:flex; align-items:center; justify-content:center; background:${activeConv() ? avatarBg(activeConv()) : 'transparent'}; border:1px solid rgba(143,145,150,0.3); font-size:15px; font-weight:700; color:#e6e4e5;`}>{activeConv() ? avatarInitial(activeConv()) : ''}</div>
              <div class="ls-swap" style="min-width:0;">
                <Show when={state.editingName}>
                  <input
                    value={state.nameDraft}
                    onInput={onNameInput}
                    onKeyDown={onNameKey}
                    onBlur={commitName}
                    ref={(el) => (nameInputRef = el)}
                    placeholder="Name…"
                    style="box-sizing:border-box; width:220px; font-family:'JetBrains Mono', monospace; font-size:14.5px; font-weight:700; color:#e4e2e3; background:rgba(53,53,54,0.7); border:1px solid rgba(189,199,215,0.45); border-radius:8px; outline:none; padding:2px 8px;"
                  />
                </Show>
                <Show when={!state.editingName}>
                  <div onDblClick={onNameDblClick} title="Double-click to rename" style="font-size:14.5px; font-weight:700; color:#e4e2e3; letter-spacing:-0.2px; cursor:text; user-select:none; -webkit-user-select:none;">{activeDisplay()}</div>
                </Show>
                <div style="display:flex; align-items:center; gap:5px; margin-top:2px;">
                  <span style={ms + 'font-size:12px; color:#bdc7d7;'}>translate</span>
                  <span style="font-size:10px; color:#9a9ba0;">Live translation on</span>
                </div>
              </div>
              <div style="flex:1;"></div>
              <Show when={hasChat()}>
                <div style="display:flex; align-items:center; gap:4px; padding:5px 11px 5px 5px; border-radius:9999px; background:rgba(42,42,43,0.7); border:1px solid rgba(68,71,75,0.45);">
                  <button onClick={openLangMenu} class="ls-langbtn" title="Choose the other person's language" style="display:flex; align-items:center; gap:5px; cursor:pointer; background:none; border:none; padding:3px 7px; border-radius:9999px; transition:background 0.15s;">
                    <Show when={detecting()}>
                      <span style="display:flex; align-items:center; gap:5px; color:#bdc7d7;">
                        <span style={ms + 'font-size:13px; animation:ls-spin 1s linear infinite;'}>autorenew</span>
                        <span style="font-size:11px; font-weight:600;">Detecting…</span>
                      </span>
                    </Show>
                    <Show when={isAuto()}>
                      <span style="font-size:11px; font-weight:700; white-space:nowrap; background:linear-gradient(90deg,#7e7f85,#bdc7d7,#eef2f8,#bdc7d7,#7e7f85); background-size:200% 100%; -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; color:transparent;">Auto-detect</span>
                    </Show>
                    <Show when={hasLang()}>
                      <span style="font-size:11px; font-weight:600; color:#c5c6cc;">{routeSource()}</span>
                    </Show>
                    <Show when={activeLangLocked()}>
                      <span style={ms + 'font-size:12px; color:#8a98ac;'} title="Manually set">push_pin</span>
                    </Show>
                    <span style={ms + 'font-size:15px; color:#76777c;'}>expand_more</span>
                  </button>
                  <span style={ms + 'font-size:14px; color:#bdc7d7;'}>arrow_right_alt</span>
                  <span style="font-size:11px; font-weight:600; color:#bdc7d7;">{state.targetLang}</span>
                </div>
              </Show>
            </div>

            {/* chat scroll */}
            <main class="ls-scroll ls-chatscroll" ref={(el) => (mainRef = el)} style="flex:1; overflow-y:auto; overflow-x:hidden; padding:90px 20px 160px;">
              <div class="ls-swap" style="width:100%; max-width:780px; margin:0; display:flex; flex-direction:column; gap:18px;">
                {/* No chats yet — first-run prompt to create one */}
                <Show when={showNoChats()}>
                  <div style="min-height:54vh; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; color:#76777c; text-align:center;">
                    <span style={ms + 'font-size:44px; color:#5a5a5b;'}>forum</span>
                    <div style="font-size:14px; letter-spacing:0.2px; color:#9a9ba0;">No chats yet</div>
                    <div style="font-size:12px; line-height:1.6; max-width:280px;">Create a chat, then paste a conversation or type a reply to translate it.</div>
                    <button onClick={openNewChat} class="ls-press" style="margin-top:4px; display:inline-flex; align-items:center; gap:7px; padding:9px 16px; border-radius:12px; cursor:pointer; background:linear-gradient(155deg,#dbe4f4,#b4bfd1); color:#1c2531; border:1px solid rgba(219,228,244,0.6); box-shadow:0 4px 14px rgba(189,199,215,0.28), inset 0 1px 0 rgba(255,255,255,0.45); font-family:'JetBrains Mono', monospace; font-size:12.5px; font-weight:700; transition:transform 0.08s;">
                      <span style={ms + 'font-size:17px;'}>edit_square</span>New chat
                    </button>
                  </div>
                </Show>

                {/* empty state */}
                <Show when={showEmpty()}>
                  <div style="min-height:48vh; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; color:#76777c; text-align:center;">
                    <span style={ms + 'font-size:40px; color:#5a5a5b;'}>forum</span>
                    <div style="font-size:13px; letter-spacing:0.2px;">Сообщений пока нет</div>
                  </div>
                </Show>

                {/* Sent (auto-translated) */}
                <For each={rawSent()}>
                  {(m) => (
                    <Show
                      when={!m.self}
                      fallback={
                        <div class="ls-msg" style="display:flex; flex-direction:column; align-items:flex-end; max-width:78%; align-self:flex-end; gap:6px;">
                          <Show when={m.showName}>
                            <div style="display:flex; align-items:center; gap:8px; padding-right:2px;">
                              <span style="font-size:10px; color:#76777c;">{m.time}</span>
                              <span style="font-size:11px; font-weight:600; color:#bdc7d7;">{m.name}</span>
                            </div>
                          </Show>
                          <div onContextMenu={(e) => onMsgContext(e, m)} style="width:100%; border-radius:18px; border-top-right-radius:5px; background:rgba(189,199,215,0.13); border:1px solid rgba(189,199,215,0.32); box-shadow:0 2px 8px rgba(0,0,0,0.3); overflow:hidden;">
                            <div style="padding:11px 14px 9px; font-size:13.5px; line-height:1.55; color:#9a9ba0; white-space:pre-wrap;"><MsgSource m={m} /></div>
                            <div style="height:1px; background:rgba(189,199,215,0.2);"></div>
                            <div style="position:relative; padding:10px 16px 11px 14px;">
                              <div style="position:absolute; right:0; top:9px; bottom:9px; width:3px; border-radius:3px; background:#bdc7d7;"></div>
                              <Show when={m.translating}>
                                <div style="display:flex; flex-direction:column; gap:8px; align-items:flex-end;">
                                  <div style="display:flex; align-items:center; gap:7px;">
                                    <span style="display:inline-flex; gap:3px; align-items:flex-end; padding-bottom:2px;">
                                      <span style="width:4px; height:4px; border-radius:9999px; background:#bdc7d7; animation:ls-bounce 1s ease-in-out infinite;"></span>
                                      <span style="width:4px; height:4px; border-radius:9999px; background:#bdc7d7; animation:ls-bounce 1s ease-in-out 0.15s infinite;"></span>
                                      <span style="width:4px; height:4px; border-radius:9999px; background:#bdc7d7; animation:ls-bounce 1s ease-in-out 0.3s infinite;"></span>
                                    </span>
                                    <span style="font-size:11px; letter-spacing:0.4px; color:#bdc7d7;">Translating</span>
                                    <span style={ms + 'font-size:15px; color:#bdc7d7; animation:ls-pulse 1.3s ease-in-out infinite;'}>auto_awesome</span>
                                  </div>
                                  <div style="height:9px; border-radius:5px; width:92%; background:linear-gradient(90deg, rgba(143,145,150,0.12) 25%, rgba(189,199,215,0.3) 50%, rgba(143,145,150,0.12) 75%); animation:ls-pulse 1.4s ease-in-out infinite;"></div>
                                  <div style="height:9px; border-radius:5px; width:60%; background:linear-gradient(90deg, rgba(143,145,150,0.12) 25%, rgba(189,199,215,0.3) 50%, rgba(143,145,150,0.12) 75%); animation:ls-pulse 1.4s ease-in-out infinite;"></div>
                                </div>
                              </Show>
                              <Show when={!m.translating}>
                                <p onClick={(e) => copyOnClick(e, m.translation, m.id)} title="Click to copy" style="margin:0; font-size:14px; line-height:1.55; color:#e9e7e8; font-weight:500; animation:ls-rise 0.45s ease; white-space:pre-wrap; cursor:text; user-select:text; -webkit-user-select:text;">{m.translation}</p>
                                <div style="display:flex; align-items:center; justify-content:flex-end; gap:6px; margin-top:8px;">
                                  <span onClick={() => copyText(m.translation, m.id)} title="Copy translation" style={ms + `font-size:15px; cursor:pointer; color:${copiedId() === m.id ? '#86e0a8' : '#76777c'};`}>{copiedId() === m.id ? 'done' : 'content_copy'}</span>
                                  <span style={ms + 'font-size:16px; color:#76777c; cursor:pointer;'}>volume_up</span>
                                  <span style="font-size:9px; font-weight:700; letter-spacing:0.6px; color:#8a98ac; background:rgba(189,199,215,0.12); border:1px solid rgba(189,199,215,0.22); padding:2px 6px; border-radius:6px;">{codeOf(m.toLang || state.targetLang)}</span>
                                </div>
                              </Show>
                            </div>
                          </div>
                        </div>
                      }
                    >
                      <div class="ls-msg" style="display:flex; flex-direction:column; align-items:flex-start; max-width:78%; align-self:flex-start; gap:6px;">
                        <Show when={m.showName}>
                          <div style="display:flex; align-items:center; gap:8px; padding-left:2px;">
                            <span style="font-size:11px; font-weight:600; color:#bdc7d7;">{m.name}</span>
                            <span style="font-size:10px; color:#76777c;">{m.time}</span>
                          </div>
                        </Show>
                        <div onContextMenu={(e) => onMsgContext(e, m)} style="width:100%; border-radius:18px; border-top-left-radius:5px; background:rgba(31,31,32,0.82); border:1px solid rgba(68,71,75,0.45); box-shadow:0 2px 8px rgba(0,0,0,0.3); overflow:hidden;">
                          <div style="padding:11px 14px 9px; font-size:13.5px; line-height:1.55; color:#9a9ba0; white-space:pre-wrap;"><MsgSource m={m} /></div>
                          <div style="height:1px; background:rgba(68,71,75,0.45);"></div>
                          <div style="position:relative; padding:10px 14px 11px 16px;">
                            <div style="position:absolute; left:0; top:9px; bottom:9px; width:3px; border-radius:3px; background:#bdc7d7;"></div>
                            <Show when={m.translating}>
                              <div style="display:flex; flex-direction:column; gap:8px;">
                                <div style="display:flex; align-items:center; gap:7px;">
                                  <span style={ms + 'font-size:15px; color:#bdc7d7; animation:ls-pulse 1.3s ease-in-out infinite;'}>auto_awesome</span>
                                  <span style="font-size:11px; letter-spacing:0.4px; color:#bdc7d7;">Translating</span>
                                  <span style="display:inline-flex; gap:3px; align-items:flex-end; padding-bottom:2px;">
                                    <span style="width:4px; height:4px; border-radius:9999px; background:#bdc7d7; animation:ls-bounce 1s ease-in-out infinite;"></span>
                                    <span style="width:4px; height:4px; border-radius:9999px; background:#bdc7d7; animation:ls-bounce 1s ease-in-out 0.15s infinite;"></span>
                                    <span style="width:4px; height:4px; border-radius:9999px; background:#bdc7d7; animation:ls-bounce 1s ease-in-out 0.3s infinite;"></span>
                                  </span>
                                </div>
                                <div style="height:9px; border-radius:5px; width:92%; background:linear-gradient(90deg, rgba(143,145,150,0.12) 25%, rgba(189,199,215,0.3) 50%, rgba(143,145,150,0.12) 75%); animation:ls-pulse 1.4s ease-in-out infinite;"></div>
                                <div style="height:9px; border-radius:5px; width:60%; background:linear-gradient(90deg, rgba(143,145,150,0.12) 25%, rgba(189,199,215,0.3) 50%, rgba(143,145,150,0.12) 75%); animation:ls-pulse 1.4s ease-in-out infinite;"></div>
                              </div>
                            </Show>
                            <Show when={!m.translating}>
                              <p onClick={(e) => copyOnClick(e, m.translation, m.id)} title="Click to copy" style="margin:0; font-size:14px; line-height:1.55; color:#e9e7e8; font-weight:500; animation:ls-rise 0.45s ease; white-space:pre-wrap; cursor:text; user-select:text; -webkit-user-select:text;">{m.translation}</p>
                              <div style="display:flex; align-items:center; gap:6px; margin-top:8px;">
                                <span style="font-size:9px; font-weight:700; letter-spacing:0.6px; color:#8a98ac; background:rgba(189,199,215,0.12); border:1px solid rgba(189,199,215,0.22); padding:2px 6px; border-radius:6px;">{codeOf(m.toLang || state.targetLang)}</span>
                                <span style={ms + 'font-size:16px; color:#76777c; cursor:pointer;'}>volume_up</span>
                                <span onClick={() => copyText(m.translation, m.id)} title="Copy translation" style={ms + `font-size:15px; cursor:pointer; color:${copiedId() === m.id ? '#86e0a8' : '#76777c'};`}>{copiedId() === m.id ? 'done' : 'content_copy'}</span>
                              </div>
                            </Show>
                          </div>
                        </div>
                      </div>
                    </Show>
                  )}
                </For>
              </div>
            </main>

            {/* input area */}
            <div style="position:absolute; left:0; right:0; bottom:0; z-index:40; padding:0 20px 22px;">
              <div style="max-width:780px; margin:0; display:flex; flex-direction:column; gap:10px;">
                {/* AI reply suggestions — generated from the last message from the other person */}
                <Show when={!hasChips() && (suggesting() || suggestions().length > 0)}>
                  <div class="ls-x" style="overflow-x:auto; padding-bottom:1px;">
                    <div style="display:flex; gap:8px; width:max-content;">
                      <Show when={suggesting() && suggestions().length === 0}>
                        <div style="display:inline-flex; align-items:center; gap:7px; background:rgba(53,53,54,0.85); border:1px solid rgba(189,199,215,0.25); color:#9a9ba0; padding:8px 14px; border-radius:9999px; font-family:'JetBrains Mono', monospace; font-size:12.5px; white-space:nowrap;">
                          <span style={ms + 'font-size:14px; color:#bdc7d7; animation:ls-pulse 1.3s ease-in-out infinite;'}>auto_awesome</span>Thinking of replies…
                        </div>
                      </Show>
                      <For each={suggestions()}>
                        {(s, i) => (
                          <button onClick={() => useSuggestion(s)} class={i() === 0 ? 'ls-chip1' : 'ls-chip2'} style={`display:inline-flex; align-items:center; gap:6px; background:rgba(53,53,54,0.85); border:1px solid ${i() === 0 ? 'rgba(189,199,215,0.35)' : 'rgba(68,71,75,0.45)'}; color:${i() === 0 ? '#bdc7d7' : '#c5c6cc'}; padding:8px 14px; border-radius:9999px; font-family:'JetBrains Mono', monospace; font-size:12.5px; white-space:nowrap; cursor:pointer; transition:background 0.15s, border-color 0.15s;`}>
                            <Show when={i() === 0}><span style={ms + 'font-size:14px;'}>auto_awesome</span></Show>{s}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* parsed chips */}
                <Show when={hasChips()}>
                  <div style="background:rgba(31,31,32,0.95); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px); border:1px solid rgba(143,145,150,0.25); border-radius:18px; box-shadow:0 10px 32px rgba(0,0,0,0.5); padding:10px; display:flex; flex-direction:column; gap:8px;">
                    <div style="display:flex; align-items:center; justify-content:space-between; padding:0 4px;">
                      <div style="display:flex; align-items:center; gap:6px; color:#bdc7d7;">
                        <span style={ms + 'font-size:15px;'}>auto_awesome</span>
                        <span style="font-size:11px; font-weight:600; letter-spacing:0.2px;">Parsed {state.chips.length} messages</span>
                      </div>
                      <button onClick={onClearChips} class="ls-clear" style="display:flex; align-items:center; gap:3px; background:none; border:none; cursor:pointer; color:#76777c; font-family:'JetBrains Mono', monospace; font-size:10.5px; transition:color 0.15s;">
                        <span style={ms + 'font-size:14px;'}>clear_all</span>Clear
                      </button>
                    </div>
                    <div class="ls-scroll" style="display:flex; flex-direction:column; gap:6px; max-height:200px; overflow-y:auto;">
                      <For each={state.chips}>
                        {(chip) => (
                          <div style="display:flex; align-items:flex-start; gap:8px; padding:8px 9px; border-radius:12px; background:rgba(53,53,54,0.55); border:1px solid rgba(68,71,75,0.4);">
                            <span style="flex-shrink:0; margin-top:1px; font-size:9px; font-weight:700; letter-spacing:0.3px; color:#bdc7d7; background:rgba(189,199,215,0.12); border:1px solid rgba(189,199,215,0.22); padding:2px 6px; border-radius:6px; max-width:96px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{chip.name}</span>
                            <div style="flex:1; min-width:0;">
                              <div style="font-size:13px; line-height:1.5; color:#e4e2e3; word-break:break-word; white-space:pre-wrap;">{chip.text}</div>
                            </div>
                            <button data-start={chip.start} data-end={chip.end} onClick={onChipDelete} aria-label="Delete message" class="ls-chipdel" style="flex-shrink:0; width:26px; height:26px; display:flex; align-items:center; justify-content:center; background:none; border:none; cursor:pointer; color:#9a9ba0; border-radius:8px; transition:background 0.15s, color 0.15s;">
                              <span style={ms + 'font-size:17px;'}>close</span>
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* input tray */}
                <div style="position:relative; background:rgba(53,53,54,0.9); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px); border:1px solid rgba(143,145,150,0.28); border-radius:20px; box-shadow:0 12px 36px rgba(0,0,0,0.55); padding:7px 7px 7px 14px; display:flex; align-items:center; gap:10px;">
                  <div style={`position:absolute; top:-26px; right:6px; display:flex; align-items:center; gap:4px; padding:3px 9px; border-radius:9999px; background:rgba(70,73,79,0.6); border:1px solid rgba(196,198,205,0.25); color:#c4c6cd; font-size:9.5px; letter-spacing:0.6px; text-transform:uppercase; transition:opacity 0.25s; opacity:${hasChips() ? 1 : 0};`}>
                    <span style={ms + 'font-size:12px;'}>auto_awesome</span>Auto-parsing
                  </div>
                  <button aria-label="AI options" style={`flex-shrink:0; width:32px; height:32px; display:flex; align-items:center; justify-content:center; background:none; border:none; cursor:pointer; transition:color 0.2s; color:${hot() ? '#bdc7d7' : '#5a5a5b'};`}>
                    <span style={ms + 'font-size:21px;'}>auto_awesome</span>
                  </button>
                  <div style="position:relative; flex:1; min-width:0;">
                    {/* highlight overlay (mirror) — parsed lines get a slate highlight; sits
                        behind the transparent-background textarea, glyph-for-glyph aligned */}
                    <div
                      ref={(el) => (hlRef = el)}
                      aria-hidden="true"
                      class="ls-x"
                      innerHTML={highlightHtml()}
                      style="position:absolute; inset:0; overflow:auto; pointer-events:none; box-sizing:border-box; font-family:'JetBrains Mono', monospace; font-size:14px; line-height:20px; padding:8px 0; color:transparent; white-space:pre-wrap; overflow-wrap:break-word; word-break:break-word;"
                    ></div>
                    <textarea
                      rows="1"
                      placeholder="Paste a chat or type a reply…"
                      value={state.value}
                      onInput={onInput}
                      onKeyDown={onInputKey}
                      onScroll={onInputScroll}
                      ref={(el) => (inputRef = el)}
                      class="ls-x"
                      style="position:relative; width:100%; box-sizing:border-box; background:transparent; border:none; outline:none; resize:none; font-family:'JetBrains Mono', monospace; font-size:14px; line-height:20px; color:#e4e2e3; caret-color:#e4e2e3; padding:8px 0; height:36px; max-height:120px; display:block;"
                    ></textarea>
                  </div>
                  <button aria-label="Send" onClick={onSend} class="ls-press" style={`flex-shrink:0; width:40px; height:40px; border-radius:13px; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:background 0.2s, box-shadow 0.2s, transform 0.08s, border-color 0.2s; background:${sendBg()}; color:${sendColor()}; border:1px solid ${sendBorder()}; box-shadow:${sendShadow()};`}>
                    <span style={ms + "font-size:21px; font-variation-settings:'FILL' 1, 'wght' 600;"}>arrow_upward</span>
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* ===== SETTINGS MODAL ===== */}
      <Show when={state.settingsOpen}>
        <div onClick={closeSettings} style="position:fixed; inset:0; z-index:50; display:flex; align-items:center; justify-content:center; background:rgba(5,5,6,0.6); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);">
          <div onClick={stopProp} style="animation:ls-pop 0.22s cubic-bezier(0.16,1,0.3,1) both; width:460px; max-width:92vw; max-height:84vh; display:flex; flex-direction:column; border-radius:20px; overflow:hidden; background:rgba(24,24,25,0.96); backdrop-filter:blur(40px) saturate(160%); -webkit-backdrop-filter:blur(40px) saturate(160%); border:1px solid rgba(143,145,150,0.25); box-shadow:0 40px 100px rgba(0,0,0,0.6);">
            <div style="flex-shrink:0; padding:18px 20px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid rgba(68,71,75,0.4);">
              <div style="font-size:16px; font-weight:700; letter-spacing:-0.3px; color:#e4e2e3;">Settings</div>
              <button aria-label="Close" onClick={closeSettings} class="ls-close" style="width:32px; height:32px; display:flex; align-items:center; justify-content:center; background:none; border:none; cursor:pointer; color:#9a9ba0; border-radius:9px; transition:background 0.15s, color 0.15s;">
                <span style={ms + 'font-size:20px;'}>close</span>
              </button>
            </div>
            <div class="ls-scroll" style="flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:14px;">
              {/* Translation engine (Codex) detection status */}
              <div style="display:flex; align-items:center; gap:6px; color:#bdc7d7;">
                <span style={ms + 'font-size:16px;'}>terminal</span>
                <span style="font-size:11px; font-weight:700; letter-spacing:0.8px; text-transform:uppercase;">Translation engine</span>
              </div>
              <div style="display:flex; align-items:center; gap:10px; padding:11px 12px; border-radius:12px; background:rgba(31,31,32,0.7); border:1px solid rgba(68,71,75,0.45);">
                <span style={`flex-shrink:0; width:9px; height:9px; border-radius:9999px; background:${codexDot()}; box-shadow:0 0 9px ${codexDot()};`}></span>
                <span style="flex:1; min-width:0; font-size:13px; color:#e4e2e3;">{codexLabel()}</span>
                <span style={ms + `font-size:18px; color:${codexDot()};` + (codexSpin() ? ' animation:ls-spin 1s linear infinite;' : '')}>{codexIcon()}</span>
              </div>
              <div style="height:1px; background:rgba(68,71,75,0.4); margin:4px 0;"></div>
              <div style="display:flex; align-items:center; gap:6px; color:#bdc7d7;">
                <span style={ms + 'font-size:16px;'}>translate</span>
                <span style="font-size:11px; font-weight:700; letter-spacing:0.8px; text-transform:uppercase;">Translate into</span>
              </div>
              <div style="display:flex; flex-wrap:wrap; gap:8px;">
                <For each={targetOptions()}>
                  {(t) => (
                    <button data-lang={t.name} onClick={onSetTarget} style={`padding:7px 13px; border-radius:10px; cursor:pointer; font-family:'JetBrains Mono', monospace; font-size:12px; background:${t.bg}; color:${t.color}; border:1px solid ${t.border};`}>{t.name}</button>
                  )}
                </For>
              </div>
              <div style="height:1px; background:rgba(68,71,75,0.4); margin:4px 0;"></div>
              <div style="display:flex; align-items:center; gap:6px; color:#bdc7d7;">
                <span style={ms + 'font-size:16px;'}>person</span>
                <span style="font-size:11px; font-weight:700; letter-spacing:0.8px; text-transform:uppercase;">Parse as “You”</span>
              </div>
              <p style="margin:0; font-size:12.5px; line-height:1.6; color:#9a9ba0;">Messages whose sender matches one of these names are treated as your own — shown on the right and labelled “You”. Every other name is kept exactly as written.</p>
              <div style="display:flex; gap:8px;">
                <input value={state.settingsInput} onInput={onSettingsInput} placeholder="Add a nickname…" style="flex:1; min-width:0; box-sizing:border-box; background:rgba(53,53,54,0.55); border:1px solid rgba(68,71,75,0.5); border-radius:12px; outline:none; font-family:'JetBrains Mono', monospace; font-size:13px; color:#e4e2e3; padding:10px 12px;" />
                <button onClick={onAddSelf} class="ls-press-96" style="flex-shrink:0; padding:0 16px; border-radius:12px; cursor:pointer; background:linear-gradient(155deg,#dbe4f4,#b4bfd1); color:#1c2531; border:1px solid rgba(219,228,244,0.6); font-family:'JetBrains Mono', monospace; font-size:13px; font-weight:700; transition:transform 0.08s;">Add</button>
              </div>
              <button onClick={onAddFiller} class="ls-filler" style="align-self:flex-start; display:flex; align-items:center; gap:5px; background:none; border:none; cursor:pointer; color:#76777c; font-family:'JetBrains Mono', monospace; font-size:11px; transition:color 0.15s;">
                <span style={ms + 'font-size:15px;'}>add</span>Add empty placeholder (ㅤ)
              </button>
              <div style="display:flex; flex-direction:column; gap:8px;">
                <For each={selfNamesView()}>
                  {(n) => (
                    <div style="display:flex; align-items:center; gap:10px; padding:11px 12px; border-radius:12px; background:rgba(31,31,32,0.7); border:1px solid rgba(68,71,75,0.45);">
                      <span style="flex-shrink:0; padding:0 8px; height:24px; border-radius:7px; display:flex; align-items:center; justify-content:center; background:rgba(189,199,215,0.13); border:1px solid rgba(189,199,215,0.25); color:#bdc7d7; font-size:10px; font-weight:700;">You</span>
                      <span style="flex:1; min-width:0; font-size:13px; color:#e4e2e3; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{n.display}</span>
                      <button data-name={n.name} onClick={onRemoveSelf} aria-label="Remove" class="ls-removeself" style="flex-shrink:0; width:28px; height:28px; display:flex; align-items:center; justify-content:center; background:none; border:none; cursor:pointer; color:#9a9ba0; border-radius:8px; transition:background 0.15s, color 0.15s;">
                        <span style={ms + 'font-size:17px;'}>close</span>
                      </button>
                    </div>
                  )}
                </For>
                <Show when={state.selfNames.length === 0}>
                  <div style="padding:18px; text-align:center; font-size:12px; line-height:1.5; color:#76777c; border:1px dashed rgba(68,71,75,0.6); border-radius:12px;">No names yet — add one above so it shows up as your own messages.</div>
                </Show>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* ===== CONVERSATION CONTEXT MENU ===== */}
      <Show when={state.ctxOpen}>
        <div onClick={closeCtx} onContextMenu={ctxBackdrop} style="position:fixed; inset:0; z-index:60;">
          <div onClick={stopProp} style={`position:fixed; left:${state.ctxX}px; top:${state.ctxY}px; min-width:158px; padding:6px; border-radius:12px; background:rgba(30,30,32,0.97); backdrop-filter:blur(20px) saturate(160%); -webkit-backdrop-filter:blur(20px) saturate(160%); border:1px solid rgba(143,145,150,0.25); box-shadow:0 16px 44px rgba(0,0,0,0.6); display:flex; flex-direction:column; gap:2px; animation:ls-pop 0.14s ease both;`}>
            <button onClick={ctxEdit} class="ls-ctxedit" style="display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:8px; background:none; border:none; cursor:pointer; color:#e4e2e3; font-family:'JetBrains Mono', monospace; font-size:12.5px; text-align:left; transition:background 0.15s;">
              <span style={ms + 'font-size:17px; color:#bdc7d7;'}>edit</span>Rename
            </button>
            <button onClick={ctxDelete} class="ls-ctxdel" style="display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:8px; background:none; border:none; cursor:pointer; color:#ffb4ab; font-family:'JetBrains Mono', monospace; font-size:12.5px; text-align:left; transition:background 0.15s;">
              <span style={ms + 'font-size:17px;'}>delete</span>Delete
            </button>
          </div>
        </div>
      </Show>

      {/* ===== MESSAGE CONTEXT MENU ===== */}
      <Show when={msgCtx().open}>
        <div onClick={closeMsgCtx} onContextMenu={(e) => { e.preventDefault(); closeMsgCtx(); }} style="position:fixed; inset:0; z-index:60;">
          <div onClick={stopProp} style={`position:fixed; left:${msgCtx().x}px; top:${msgCtx().y}px; min-width:150px; padding:6px; border-radius:12px; background:rgba(30,30,32,0.97); backdrop-filter:blur(20px) saturate(160%); -webkit-backdrop-filter:blur(20px) saturate(160%); border:1px solid rgba(143,145,150,0.25); box-shadow:0 16px 44px rgba(0,0,0,0.6); display:flex; flex-direction:column; gap:2px; animation:ls-pop 0.14s ease both;`}>
            <button onClick={startMsgEdit} class="ls-ctxedit" style="display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:8px; background:none; border:none; cursor:pointer; color:#e4e2e3; font-family:'JetBrains Mono', monospace; font-size:12.5px; text-align:left; transition:background 0.15s;">
              <span style={ms + 'font-size:17px; color:#bdc7d7;'}>edit</span>Edit
            </button>
            <button onClick={deleteMsg} class="ls-ctxdel" style="display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:8px; background:none; border:none; cursor:pointer; color:#ffb4ab; font-family:'JetBrains Mono', monospace; font-size:12.5px; text-align:left; transition:background 0.15s;">
              <span style={ms + 'font-size:17px;'}>delete</span>Delete
            </button>
          </div>
        </div>
      </Show>

      {/* ===== INTERLOCUTOR LANGUAGE PICKER ===== */}
      <Show when={langMenu().open}>
        <div onClick={closeLangMenu} onContextMenu={(e) => { e.preventDefault(); closeLangMenu(); }} style="position:fixed; inset:0; z-index:60;">
          <div onClick={stopProp} class="ls-scroll" style={`position:fixed; left:${langMenu().x}px; top:${langMenu().y}px; min-width:190px; max-height:340px; overflow-y:auto; padding:6px; border-radius:12px; background:rgba(30,30,32,0.97); backdrop-filter:blur(20px) saturate(160%); -webkit-backdrop-filter:blur(20px) saturate(160%); border:1px solid rgba(143,145,150,0.25); box-shadow:0 16px 44px rgba(0,0,0,0.6); display:flex; flex-direction:column; gap:2px; animation:ls-pop 0.14s ease both;`}>
            <div style="padding:5px 9px 3px; font-size:9.5px; font-weight:700; letter-spacing:0.6px; text-transform:uppercase; color:#76777c;">Other person speaks</div>
            <button onClick={() => setInterlocutorLang(null)} class="ls-ctxedit" style="display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:8px; background:none; border:none; cursor:pointer; color:#e4e2e3; font-family:'JetBrains Mono', monospace; font-size:12.5px; text-align:left; transition:background 0.15s;">
              <span style={ms + 'font-size:17px; color:#bdc7d7;'}>autorenew</span>
              <span style="flex:1;">Auto-detect</span>
              <Show when={!activeLangLocked()}><span style={ms + 'font-size:16px; color:#86e0a8;'}>check</span></Show>
            </button>
            <div style="height:1px; background:rgba(68,71,75,0.4); margin:3px 4px;"></div>
            <For each={INTERLOCUTOR_LANGS}>
              {(o) => (
                <button onClick={() => setInterlocutorLang(o.code)} class="ls-ctxedit" style="display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:8px; background:none; border:none; cursor:pointer; color:#e4e2e3; font-family:'JetBrains Mono', monospace; font-size:12.5px; text-align:left; transition:background 0.15s;">
                  <span style="flex-shrink:0; width:26px; font-size:9px; font-weight:700; letter-spacing:0.3px; color:#8a98ac;">{o.code}</span>
                  <span style="flex:1;">{o.name}</span>
                  <Show when={activeLangLocked() && activeConv() && activeConv().lang === o.code}>
                    <span style={ms + 'font-size:16px; color:#86e0a8;'}>check</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* ===== TOASTS ===== */}
      <div style="position:fixed; left:0; right:0; bottom:26px; z-index:1000; display:flex; flex-direction:column; align-items:center; gap:9px; pointer-events:none;">
        <For each={toasts()}>
          {(t) => (
            <div
              onClick={() => dismissToast(t.id)}
              class={leavingToasts().includes(t.id) ? 'ls-toast ls-toast-out' : 'ls-toast'}
              style={`pointer-events:auto; cursor:default; display:flex; align-items:center; gap:10px; max-width:min(86vw,440px); padding:11px 16px; border-radius:14px; background:rgba(28,28,30,0.97); border:1px solid rgba(143,145,150,0.28); box-shadow:0 14px 40px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05); color:#e4e2e3; font-family:'JetBrains Mono', monospace; font-size:12.5px; font-weight:500;`}
            >
              <span style={ms + `font-size:18px; color:${toastColor(t.tone)};`}>{t.icon}</span>
              <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{t.text}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
