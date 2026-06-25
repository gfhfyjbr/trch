import { createStore, produce } from 'solid-js/store';
import { For, Show, onMount, onCleanup } from 'solid-js';
import { LANGS, translateAsync, detectCode, nowTime } from './translate';
import { parseLog, buildHighlightHtml } from './parse';

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
};
type Chip = { id: number; name: string; text: string; self: boolean; start: number; end: number };
type Screen = 'chat' | 'list' | 'settings';
type State = {
  value: string;
  screen: Screen;
  chips: Chip[];
  selfNames: string[];
  settingsInput: string;
  searchQuery: string;
  activeName: string;
  sentByChat: Record<string, Msg[]>;
  targetLang: string;
  swipedName: string;
  editingRow: string;
  rowDraft: string;
  chats: Chat[];
};

export default function Mobile() {
  const [state, setStore] = createStore<State>({
    value: '',
    screen: 'chat',
    chips: [],
    selfNames: [],
    settingsInput: '',
    searchQuery: '',
    activeName: 'alkaafi',
    sentByChat: {},
    targetLang: 'English',
    swipedName: '',
    editingRow: '',
    rowDraft: '',
    chats: [
      { initial: 'a', name: 'alkaafi', preview: "It's okay, dear — my deepest condolences.", time: '14:32', lang: 'ZH', bg: 'linear-gradient(145deg,#46494f,#2a2a2b)' },
      { initial: 'M', name: 'María José', preview: 'See you tomorrow at the café?', time: '13:10', lang: 'ES', bg: 'linear-gradient(145deg,#5a4e63,#332b3a)' },
      { initial: '健', name: 'Kenji', preview: 'Thank you so much for today.', time: '11:48', lang: 'JA', bg: 'linear-gradient(145deg,#4e5d63,#2b343a)' },
      { initial: 'Д', name: 'Dimitri', preview: 'Thanks again for all your help.', time: 'Yesterday', lang: 'RU', bg: 'linear-gradient(145deg,#63584e,#3a322b)' },
      { initial: 'A', name: 'Amara', preview: 'Thank you so much, truly.', time: 'Mon', lang: 'FR', bg: 'linear-gradient(145deg,#4e6359,#2b3a33)' },
    ],
  });

  const setState = (update: Partial<State> | ((s: State) => Partial<State>)) => {
    const partial = typeof update === 'function' ? (update as (s: State) => Partial<State>)(state) : update;
    setStore(
      produce((d) => {
        for (const k in partial) (d as any)[k] = (partial as any)[k];
      }),
    );
  };

  let cid = 1;
  let inputRef: HTMLTextAreaElement | undefined;
  let hlRef: HTMLDivElement | undefined;
  let mainRef: HTMLElement | undefined;
  let rowInputRef: HTMLInputElement | undefined;
  let sw: { row: HTMLElement; actions: HTMLElement; name: string; x: number; curX: number | null; moved: boolean } | null = null;

  // ===== Helpers =====
  function scrollSoon() {
    setTimeout(() => { if (mainRef) mainRef.scrollTop = mainRef.scrollHeight; }, 70);
  }
  function resizeInput() {
    if (!inputRef) return;
    inputRef.style.height = '36px';
    if (inputRef.scrollHeight > 36) inputRef.style.height = Math.min(inputRef.scrollHeight, 96) + 'px';
    if (hlRef) hlRef.scrollTop = inputRef.scrollTop;
  }
  const onInputScroll = (e: any) => { if (hlRef) hlRef.scrollTop = e.target.scrollTop; };
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
        chats = chats.map((c) => (c.name === activeName ? { ...c, name: newName, initial, untitled: false, lang: 'NEW', detecting: true } : c));
        sentByChat = { ...sentByChat };
        if (activeName in sentByChat) { sentByChat[newName] = sentByChat[activeName]; delete sentByChat[activeName]; }
        activeName = newName;
        detect = { name: newName, text: cand.text };
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
  // Bounded slice of recent chat history for contextual translation (capped again
  // on the backend so the model's context never overloads).
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
  function revealTranslation(id: number, src: string, started: number, chat: string) {
    translateAsync(src, undefined, histFor(chat, id), chat).then((tr) => {
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

  // ===== Navigation =====
  const goToList = () => setState({ screen: 'list' });
  const goToSettings = () => setState({ screen: 'settings' });
  const stopProp = (e: Event) => e.stopPropagation();
  const onSetTarget = (e: any) => setState({ targetLang: e.currentTarget.dataset.lang });

  // ===== Swipe-to-reveal conversation rows =====
  const onSlideDown = (e: any) => {
    const row = e.currentTarget as HTMLElement;
    const actions = row.parentElement!.querySelector('[data-actions]') as HTMLElement;
    sw = { row, actions, name: row.dataset.name!, x: e.clientX, curX: null, moved: false };
    try { row.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
  };
  const onSlideMove = (e: any) => {
    if (!sw) return;
    const dx = e.clientX - sw.x;
    if (Math.abs(dx) > 6) sw.moved = true;
    const base = state.swipedName === sw.name ? -132 : 0;
    let x = base + dx;
    if (x > 0) x = 0;
    if (x < -132) x = -132;
    sw.curX = x;
    sw.row.style.transition = 'none';
    sw.actions.style.transition = 'none';
    sw.row.style.transform = 'translateX(' + x + 'px)';
    sw.actions.style.transform = 'translateX(' + (132 + x) + 'px)';
  };
  const onSlideUp = (_e: any) => {
    if (!sw) return;
    const s = sw;
    sw = null;
    s.row.style.transition = '';
    s.actions.style.transition = '';
    s.row.style.transform = '';
    s.actions.style.transform = '';
    if (!s.moved) {
      if (state.swipedName === s.name) setState({ swipedName: '' });
      else if (state.editingRow !== s.name) setState({ activeName: s.name, screen: 'chat', swipedName: '' });
      return;
    }
    const open = s.curX != null && s.curX < -66;
    setState({ swipedName: open ? s.name : '' });
  };
  const onSwipeEdit = (e: any) => {
    const name = e.currentTarget.dataset.name;
    const c = state.chats.find((x) => x.name === name);
    setState({ editingRow: name, rowDraft: c && !c.untitled ? c.name : '', swipedName: '' });
    setTimeout(() => { if (rowInputRef) { rowInputRef.focus(); rowInputRef.select(); } }, 60);
  };
  const onSwipeDelete = (e: any) => {
    const name = e.currentTarget.dataset.name;
    const chats = state.chats.filter((c) => c.name !== name);
    const sentByChat = { ...state.sentByChat };
    delete sentByChat[name];
    let activeName = state.activeName;
    if (activeName === name) activeName = chats.length ? chats[0].name : '';
    setState({ chats, sentByChat, activeName, swipedName: '' });
  };
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
  };
  const openNewChat = () => {
    const palette = [
      'linear-gradient(145deg,#5a4e63,#332b3a)', 'linear-gradient(145deg,#4e5d63,#2b343a)',
      'linear-gradient(145deg,#63584e,#3a322b)', 'linear-gradient(145deg,#4e6359,#2b3a33)',
      'linear-gradient(145deg,#46494f,#2a2a2b)',
    ];
    const bg = palette[state.chats.length % palette.length];
    const name = '__new' + cid++;
    const chat: Chat = { initial: '?', name, untitled: true, preview: 'No messages yet', time: 'now', lang: 'NEW', bg };
    setState({ chats: [chat, ...state.chats], activeName: name, screen: 'chat', sentByChat: { ...state.sentByChat, [name]: [] } });
  };

  // ===== Settings =====
  const addSelf = (v: string) => {
    if (!v) return;
    if (state.selfNames.some((n) => n.trim().toLowerCase() === v.trim().toLowerCase())) { setState({ settingsInput: '' }); return; }
    setState({ selfNames: [...state.selfNames, v], settingsInput: '' });
  };
  const onSettingsInput = (e: any) => setState({ settingsInput: e.target.value });
  const onSearchInput = (e: any) => setState({ searchQuery: e.target.value });
  const onAddSelf = () => addSelf(state.settingsInput.trim());
  const onAddFiller = () => addSelf('ㅤ');
  const onRemoveSelf = (e: any) => {
    const name = e.currentTarget.dataset.name;
    setState({ selfNames: state.selfNames.filter((n) => n !== name) });
  };

  // ===== Undo / Redo =====
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
  onMount(() => {
    document.addEventListener('keydown', onKey);
    if (state.value) reparse(state.value);
    setTimeout(resizeInput, 0);
  });
  onCleanup(() => document.removeEventListener('keydown', onKey));

  // ===== Input parsing (the textarea is the source of truth) =====
  const onInput = (e: any) => {
    record(e.inputType === 'insertFromPaste' ? 'paste' : 'type');
    resizeInput();
    reparse(e.target.value);
  };
  // Enter sends; Shift+Enter inserts a newline. IME composition is guarded so
  // confirming a candidate (Chinese/Japanese input) doesn't fire a send.
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
    const chat = state.activeName;
    const cur = state.sentByChat[chat] || [];
    const chips = state.chips;
    const now = nowTime();
    if (chips.length) {
      const list = cur.slice();
      let prevName: string | null = list.length ? list[list.length - 1].name : null;
      const pending: { id: number; src: string }[] = [];
      for (const c of chips) {
        if (!c.text.trim()) continue;
        const id = cid++;
        list.push({ id, name: c.name, source: c.text, translation: '', self: c.self, showName: c.name !== prevName, time: now, translating: true });
        pending.push({ id, src: c.text });
        prevName = c.name;
      }
      setState({ chips: [], value: '', sentByChat: { ...state.sentByChat, [chat]: list } });
      setTimeout(resizeInput, 0);
      scrollSoon();
      const started = Date.now();
      pending.forEach((p) => revealTranslation(p.id, p.src, started, chat));
      return;
    }
    const text = state.value.trim();
    if (!text) return;
    const id = cid++;
    const prevName = cur.length ? cur[cur.length - 1].name : null;
    const msg: Msg = { id, name: chat, source: text, translation: '', self: false, showName: chat !== prevName, time: now, translating: true };
    setState({ value: '', sentByChat: { ...state.sentByChat, [chat]: [...cur, msg] } });
    if (inputRef) { inputRef.style.height = '36px'; inputRef.value = ''; }
    scrollSoon();
    revealTranslation(id, text, Date.now(), chat);
  };

  // ===== Derived view values =====
  const activeConv = () => state.chats.find((c) => c.name === state.activeName) || state.chats[0];
  const activeDisplay = () => { const a = activeConv(); return a ? (a.untitled ? 'New chat' : a.name) : ''; };
  const isDefaultChat = () => state.activeName === 'alkaafi';
  const rawSent = () => state.sentByChat[state.activeName] || [];
  const sentMessages = () => rawSent().map((m) => ({ ...m, incoming: !m.self, done: !m.translating }));
  const showEmpty = () => !isDefaultChat() && sentMessages().length === 0;
  const detecting = () => !!(activeConv() && activeConv().detecting);
  const routeSource = () => { const a = activeConv(); return a ? LANGS[a.lang] || 'Auto-detect' : 'Auto-detect'; };
  const isAuto = () => !detecting() && routeSource() === 'Auto-detect';
  const hasLang = () => !detecting() && routeSource() !== 'Auto-detect';

  const conversations = () => {
    const q = state.searchQuery.trim().toLowerCase();
    const filtered = q
      ? state.chats.filter((c) => (c.name + ' ' + c.preview + ' ' + c.lang).toLowerCase().includes(q))
      : state.chats;
    return filtered.map((c) => ({
      ...c,
      display: c.untitled ? 'New chat' : c.name,
      swiped: c.name === state.swipedName,
      rowTransform: c.name === state.swipedName ? 'translateX(-132px)' : 'translateX(0)',
      actionsTransform: c.name === state.swipedName ? 'translateX(0)' : 'translateX(132px)',
      editing: c.name === state.editingRow,
      notEditing: c.name !== state.editingRow,
    }));
  };
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
    <div style="position:fixed; inset:0; display:flex; flex-direction:column; background:#0d0d0e; font-family:'JetBrains Mono', monospace; color:#e4e2e3; overflow:hidden;">
      {/* ambient glow */}
          <div style="position:absolute; inset:0; pointer-events:none; overflow:hidden; z-index:0;">
            <div style="position:absolute; top:-12%; right:-18%; width:380px; height:380px; border-radius:9999px; background:rgba(189,199,215,0.14); filter:blur(90px);"></div>
            <div style="position:absolute; bottom:4%; left:-22%; width:420px; height:420px; border-radius:9999px; background:rgba(70,73,79,0.5); filter:blur(110px);"></div>
          </div>

          {/* ===== CHAT SCREEN ===== */}
          <Show when={state.screen === 'chat'}>
            <div class="ls-screen" style="position:absolute; inset:0; display:flex; flex-direction:column;">
              {/* top bar: back + stacked */}
              <div style="position:absolute; top:50px; left:0; right:0; z-index:45; display:flex; align-items:flex-start; gap:10px; padding:0 16px;">
                <button aria-label="Back to conversations" onClick={goToList} class="ls-press" style="flex-shrink:0; width:40px; height:40px; border-radius:9999px; display:flex; align-items:center; justify-content:center; cursor:pointer; background:rgba(42,42,43,0.72); backdrop-filter:blur(16px) saturate(160%); -webkit-backdrop-filter:blur(16px) saturate(160%); border:1px solid rgba(143,145,150,0.28); color:#c5c6cc; box-shadow:0 2px 10px rgba(0,0,0,0.35); transition:transform 0.08s;">
                  <span style={ms + 'font-size:21px;'}>arrow_back</span>
                </button>
                <div style="flex:1; min-width:0; display:flex; flex-direction:column; align-items:center; gap:6px;">
                  <div style="max-width:100%; height:40px; display:flex; align-items:center; gap:8px; padding:0 13px 0 6px; border-radius:9999px; background:rgba(42,42,43,0.72); backdrop-filter:blur(16px) saturate(160%); -webkit-backdrop-filter:blur(16px) saturate(160%); border:1px solid rgba(143,145,150,0.28); box-shadow:0 2px 10px rgba(0,0,0,0.35);">
                    <div style={`flex-shrink:0; width:24px; height:24px; border-radius:9999px; display:flex; align-items:center; justify-content:center; background:${activeConv() ? activeConv().bg : ''}; border:1px solid rgba(143,145,150,0.3); font-size:11px; font-weight:700; color:#e6e4e5;`}>{activeConv() ? activeConv().initial : ''}</div>
                    <span style="font-size:13px; font-weight:700; color:#e4e2e3; letter-spacing:-0.2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{activeDisplay()}</span>
                  </div>
                  <div style="display:flex; align-items:center; gap:6px; padding:5px 12px; border-radius:9999px; background:rgba(42,42,43,0.72); backdrop-filter:blur(16px) saturate(160%); -webkit-backdrop-filter:blur(16px) saturate(160%); border:1px solid rgba(143,145,150,0.28); box-shadow:0 2px 10px rgba(0,0,0,0.35);">
                    <Show when={detecting()}>
                      <span style="display:flex; align-items:center; gap:4px; color:#bdc7d7;">
                        <span style={ms + 'font-size:13px; animation:ls-spin 1s linear infinite;'}>autorenew</span>
                        <span style="font-size:11px; font-weight:600; white-space:nowrap;">Detecting…</span>
                      </span>
                    </Show>
                    <Show when={isAuto()}>
                      <span style="font-size:11px; font-weight:700; white-space:nowrap; background:linear-gradient(90deg,#7e7f85,#bdc7d7,#eef2f8,#bdc7d7,#7e7f85); background-size:200% 100%; -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; color:transparent; animation:ls-shimmer 2.4s linear infinite;">Auto-detect</span>
                    </Show>
                    <Show when={hasLang()}>
                      <span style="font-size:11px; font-weight:600; color:#c5c6cc; white-space:nowrap;">{routeSource()}</span>
                    </Show>
                    <span style={ms + 'font-size:14px; color:#bdc7d7; flex-shrink:0;'}>arrow_right_alt</span>
                    <span style="font-size:11px; font-weight:600; color:#bdc7d7; white-space:nowrap;">{state.targetLang}</span>
                  </div>
                </div>
                <div style="flex-shrink:0; width:40px;"></div>
              </div>

              {/* Chat scroll */}
              <main class="ls-x" ref={(el) => (mainRef = el)} style="position:relative; z-index:10; flex:1; overflow-y:auto; padding:128px 18px 150px; display:flex; flex-direction:column; gap:18px;">
                {/* Demo messages (default chat only) */}
                <Show when={isDefaultChat()}>
                  <div class="ls-msg" style="display:flex; flex-direction:column; align-items:flex-start; max-width:88%; align-self:flex-start; gap:6px;">
                    <div style="display:flex; align-items:center; gap:8px; padding-left:2px;">
                      <span style="font-size:11px; font-weight:600; color:#bdc7d7;">alkaafi</span>
                      <span style="font-size:10px; color:#76777c;">14:32</span>
                    </div>
                    <div style="width:100%; border-radius:18px; border-top-left-radius:5px; background:rgba(31,31,32,0.82); backdrop-filter:blur(20px) saturate(150%); -webkit-backdrop-filter:blur(20px) saturate(150%); border:1px solid rgba(68,71,75,0.45); box-shadow:0 4px 18px rgba(0,0,0,0.35); overflow:hidden;">
                      <div style="padding:11px 14px 9px; font-size:13.5px; line-height:1.55; color:#9a9ba0;">你好，抱歉没回复，我刚参加完爷爷的葬礼……</div>
                      <div style="height:1px; background:rgba(68,71,75,0.45);"></div>
                      <div style="position:relative; padding:10px 14px 11px 16px;">
                        <div style="position:absolute; left:0; top:9px; bottom:9px; width:3px; border-radius:3px; background:#bdc7d7;"></div>
                        <p style="margin:0; font-size:14px; line-height:1.55; color:#e9e7e8; font-weight:500;">Hi, sorry for the late reply — I just got back from my grandfather's funeral…</p>
                        <div style="display:flex; align-items:center; gap:6px; margin-top:8px;">
                          <span style="font-size:9px; font-weight:700; letter-spacing:0.6px; color:#8a98ac; background:rgba(189,199,215,0.12); border:1px solid rgba(189,199,215,0.22); padding:2px 6px; border-radius:6px;">EN</span>
                          <span style={ms + 'font-size:16px; color:#76777c; cursor:pointer;'}>volume_up</span>
                          <span style={ms + 'font-size:15px; color:#76777c; cursor:pointer;'}>content_copy</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="ls-msg" style="display:flex; flex-direction:column; align-items:flex-end; max-width:88%; align-self:flex-end; gap:6px;">
                    <div style="display:flex; align-items:center; gap:8px; padding-right:2px;">
                      <span style="font-size:10px; color:#76777c;">14:33</span>
                      <span style="font-size:11px; font-weight:600; color:#bdc7d7;">You</span>
                    </div>
                    <div style="width:100%; border-radius:18px; border-top-right-radius:5px; background:rgba(189,199,215,0.13); backdrop-filter:blur(20px) saturate(150%); -webkit-backdrop-filter:blur(20px) saturate(150%); border:1px solid rgba(189,199,215,0.32); box-shadow:0 4px 18px rgba(0,0,0,0.35); overflow:hidden;">
                      <div style="position:relative; padding:11px 14px 10px 14px;">
                        <div style="position:absolute; right:0; top:9px; bottom:9px; width:3px; border-radius:3px; background:#bdc7d7;"></div>
                        <p style="margin:0; font-size:14px; line-height:1.55; color:#e9e7e8; font-weight:500;">It's okay, dear — my deepest condolences.</p>
                      </div>
                      <div style="height:1px; background:rgba(189,199,215,0.2);"></div>
                      <div style="padding:10px 14px 11px;">
                        <div style="font-size:13.5px; line-height:1.55; color:#9a9ba0;">没事的宝子，节哀顺变</div>
                        <div style="display:flex; align-items:center; justify-content:flex-end; gap:6px; margin-top:8px;">
                          <span style={ms + 'font-size:15px; color:#76777c; cursor:pointer;'}>content_copy</span>
                          <span style={ms + 'font-size:16px; color:#76777c; cursor:pointer;'}>volume_up</span>
                          <span style="font-size:9px; font-weight:700; letter-spacing:0.6px; color:#8a98ac; background:rgba(189,199,215,0.12); border:1px solid rgba(189,199,215,0.22); padding:2px 6px; border-radius:6px;">中文</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </Show>

                {/* empty state */}
                <Show when={showEmpty()}>
                  <div style="min-height:50vh; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; color:#76777c; text-align:center;">
                    <span style={ms + 'font-size:38px; color:#5a5a5b;'}>forum</span>
                    <div style="font-size:13px; letter-spacing:0.2px;">Сообщений пока нет</div>
                  </div>
                </Show>

                {/* Sent messages */}
                <For each={sentMessages()}>
                  {(m) => (
                    <Show
                      when={m.incoming}
                      fallback={
                        <div class="ls-msg" style="display:flex; flex-direction:column; align-items:flex-end; max-width:88%; align-self:flex-end; gap:6px;">
                          <Show when={m.showName}>
                            <div style="display:flex; align-items:center; gap:8px; padding-right:2px;">
                              <span style="font-size:10px; color:#76777c;">{m.time}</span>
                              <span style="font-size:11px; font-weight:600; color:#bdc7d7;">{m.name}</span>
                            </div>
                          </Show>
                          <div style="width:100%; border-radius:18px; border-top-right-radius:5px; background:rgba(189,199,215,0.13); backdrop-filter:blur(20px) saturate(150%); -webkit-backdrop-filter:blur(20px) saturate(150%); border:1px solid rgba(189,199,215,0.32); box-shadow:0 4px 18px rgba(0,0,0,0.35); overflow:hidden;">
                            <div style="padding:11px 14px 9px; font-size:13.5px; line-height:1.55; color:#9a9ba0; white-space:pre-wrap;">{m.source}</div>
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
                                  <div style="height:9px; border-radius:5px; width:92%; background:linear-gradient(90deg, rgba(143,145,150,0.12) 25%, rgba(189,199,215,0.3) 50%, rgba(143,145,150,0.12) 75%); background-size:200% 100%; animation:ls-shimmer 1.5s linear infinite;"></div>
                                  <div style="height:9px; border-radius:5px; width:60%; background:linear-gradient(90deg, rgba(143,145,150,0.12) 25%, rgba(189,199,215,0.3) 50%, rgba(143,145,150,0.12) 75%); background-size:200% 100%; animation:ls-shimmer 1.5s linear infinite;"></div>
                                </div>
                              </Show>
                              <Show when={m.done}>
                                <p style="margin:0; font-size:14px; line-height:1.55; color:#e9e7e8; font-weight:500; animation:ls-rise 0.45s ease; white-space:pre-wrap;">{m.translation}</p>
                                <div style="display:flex; align-items:center; justify-content:flex-end; gap:6px; margin-top:8px;">
                                  <span style={ms + 'font-size:15px; color:#76777c; cursor:pointer;'}>content_copy</span>
                                  <span style={ms + 'font-size:16px; color:#76777c; cursor:pointer;'}>volume_up</span>
                                  <span style="font-size:9px; font-weight:700; letter-spacing:0.6px; color:#8a98ac; background:rgba(189,199,215,0.12); border:1px solid rgba(189,199,215,0.22); padding:2px 6px; border-radius:6px;">EN</span>
                                </div>
                              </Show>
                            </div>
                          </div>
                        </div>
                      }
                    >
                      <div class="ls-msg" style="display:flex; flex-direction:column; align-items:flex-start; max-width:88%; align-self:flex-start; gap:6px;">
                        <Show when={m.showName}>
                          <div style="display:flex; align-items:center; gap:8px; padding-left:2px;">
                            <span style="font-size:11px; font-weight:600; color:#bdc7d7;">{m.name}</span>
                            <span style="font-size:10px; color:#76777c;">{m.time}</span>
                          </div>
                        </Show>
                        <div style="width:100%; border-radius:18px; border-top-left-radius:5px; background:rgba(31,31,32,0.82); backdrop-filter:blur(20px) saturate(150%); -webkit-backdrop-filter:blur(20px) saturate(150%); border:1px solid rgba(68,71,75,0.45); box-shadow:0 4px 18px rgba(0,0,0,0.35); overflow:hidden;">
                          <div style="padding:11px 14px 9px; font-size:13.5px; line-height:1.55; color:#9a9ba0; white-space:pre-wrap;">{m.source}</div>
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
                                <div style="height:9px; border-radius:5px; width:92%; background:linear-gradient(90deg, rgba(143,145,150,0.12) 25%, rgba(189,199,215,0.3) 50%, rgba(143,145,150,0.12) 75%); background-size:200% 100%; animation:ls-shimmer 1.5s linear infinite;"></div>
                                <div style="height:9px; border-radius:5px; width:60%; background:linear-gradient(90deg, rgba(143,145,150,0.12) 25%, rgba(189,199,215,0.3) 50%, rgba(143,145,150,0.12) 75%); background-size:200% 100%; animation:ls-shimmer 1.5s linear infinite;"></div>
                              </div>
                            </Show>
                            <Show when={m.done}>
                              <p style="margin:0; font-size:14px; line-height:1.55; color:#e9e7e8; font-weight:500; animation:ls-rise 0.45s ease; white-space:pre-wrap;">{m.translation}</p>
                              <div style="display:flex; align-items:center; gap:6px; margin-top:8px;">
                                <span style="font-size:9px; font-weight:700; letter-spacing:0.6px; color:#8a98ac; background:rgba(189,199,215,0.12); border:1px solid rgba(189,199,215,0.22); padding:2px 6px; border-radius:6px;">EN</span>
                                <span style={ms + 'font-size:16px; color:#76777c; cursor:pointer;'}>volume_up</span>
                                <span style={ms + 'font-size:15px; color:#76777c; cursor:pointer;'}>content_copy</span>
                              </div>
                            </Show>
                          </div>
                        </div>
                      </div>
                    </Show>
                  )}
                </For>
              </main>

              {/* progressive blur scrim */}
              <div style="position:absolute; left:0; right:0; bottom:0; height:235px; z-index:35; pointer-events:none; backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px); -webkit-mask-image:linear-gradient(to top, #000 38%, rgba(0,0,0,0.6) 62%, transparent 100%); mask-image:linear-gradient(to top, #000 38%, rgba(0,0,0,0.6) 62%, transparent 100%); background:linear-gradient(to top, rgba(13,13,14,0.92) 6%, rgba(13,13,14,0) 100%);"></div>

              {/* Floating bottom stack */}
              <div style="position:absolute; left:0; right:0; bottom:30px; z-index:40; padding:0 18px; display:flex; flex-direction:column; gap:10px; pointer-events:none;">
                {/* suggestion pills */}
                <Show when={!hasChips()}>
                  <div class="ls-x" style="overflow-x:auto; pointer-events:auto; padding-bottom:2px;">
                    <div style="display:flex; gap:8px; width:max-content;">
                      <button class="ls-chip1" style="display:inline-flex; align-items:center; gap:6px; background:rgba(53,53,54,0.85); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); border:1px solid rgba(189,199,215,0.35); color:#bdc7d7; padding:8px 14px; border-radius:9999px; font-family:'JetBrains Mono', monospace; font-size:12.5px; white-space:nowrap; cursor:pointer; box-shadow:0 2px 10px rgba(0,0,0,0.3); transition:background 0.15s;">
                        <span style={ms + 'font-size:14px;'}>auto_awesome</span>I'm so sorry to hear that
                      </button>
                      <button class="ls-chip2" style="background:rgba(53,53,54,0.85); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); border:1px solid rgba(68,71,75,0.45); color:#c5c6cc; padding:8px 14px; border-radius:9999px; font-family:'JetBrains Mono', monospace; font-size:12.5px; white-space:nowrap; cursor:pointer; box-shadow:0 2px 10px rgba(0,0,0,0.3); transition:border-color 0.15s;">Take your time</button>
                      <button class="ls-chip2" style="background:rgba(53,53,54,0.85); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); border:1px solid rgba(68,71,75,0.45); color:#c5c6cc; padding:8px 14px; border-radius:9999px; font-family:'JetBrains Mono', monospace; font-size:12.5px; white-space:nowrap; cursor:pointer; box-shadow:0 2px 10px rgba(0,0,0,0.3); transition:border-color 0.15s;">Do you need anything?</button>
                    </div>
                  </div>
                </Show>

                {/* parsed chips */}
                <Show when={hasChips()}>
                  <div style="pointer-events:auto; background:rgba(31,31,32,0.92); backdrop-filter:blur(26px) saturate(160%); -webkit-backdrop-filter:blur(26px) saturate(160%); border:1px solid rgba(143,145,150,0.25); border-radius:20px; box-shadow:0 10px 32px rgba(0,0,0,0.55); padding:10px; display:flex; flex-direction:column; gap:8px;">
                    <div style="display:flex; align-items:center; justify-content:space-between; padding:0 4px;">
                      <div style="display:flex; align-items:center; gap:6px; color:#bdc7d7;">
                        <span style={ms + 'font-size:15px;'}>auto_awesome</span>
                        <span style="font-size:11px; font-weight:600; letter-spacing:0.2px;">Parsed {state.chips.length} messages</span>
                      </div>
                      <button onClick={onClearChips} class="ls-clear" style="display:flex; align-items:center; gap:3px; background:none; border:none; cursor:pointer; color:#76777c; font-family:'JetBrains Mono', monospace; font-size:10.5px; transition:color 0.15s;">
                        <span style={ms + 'font-size:14px;'}>clear_all</span>Clear
                      </button>
                    </div>
                    <div class="ls-x" style="display:flex; flex-direction:column; gap:6px; max-height:174px; overflow-y:auto;">
                      <For each={state.chips}>
                        {(chip) => (
                          <div style="display:flex; align-items:flex-start; gap:8px; padding:8px 9px; border-radius:12px; background:rgba(53,53,54,0.55); border:1px solid rgba(68,71,75,0.4);">
                            <span style="flex-shrink:0; margin-top:1px; font-size:9px; font-weight:700; letter-spacing:0.3px; color:#bdc7d7; background:rgba(189,199,215,0.12); border:1px solid rgba(189,199,215,0.22); padding:2px 6px; border-radius:6px; max-width:88px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{chip.name}</span>
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
                <div style="pointer-events:auto; position:relative; background:rgba(53,53,54,0.82); backdrop-filter:blur(30px) saturate(160%); -webkit-backdrop-filter:blur(30px) saturate(160%); border:1px solid rgba(143,145,150,0.28); border-radius:24px; box-shadow:0 8px 28px rgba(0,0,0,0.5); padding:7px 7px 7px 12px; display:flex; align-items:center; gap:8px;">
                  <div style={`position:absolute; top:-26px; right:6px; display:flex; align-items:center; gap:4px; padding:3px 9px; border-radius:9999px; background:rgba(70,73,79,0.6); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); border:1px solid rgba(196,198,205,0.25); color:#c4c6cd; font-size:9.5px; letter-spacing:0.6px; text-transform:uppercase; transition:opacity 0.25s; opacity:${hasChips() ? 1 : 0};`}>
                    <span style={ms + 'font-size:12px;'}>auto_awesome</span>Auto-parsing
                  </div>
                  <button aria-label="AI options" style={`flex-shrink:0; width:32px; height:32px; display:flex; align-items:center; justify-content:center; background:none; border:none; cursor:pointer; transition:color 0.2s; color:${hot() ? '#bdc7d7' : '#5a5a5b'};`}>
                    <span style={ms + 'font-size:21px; display:inline-block; transition:color 0.2s;'}>auto_awesome</span>
                  </button>
                  <div style="position:relative; flex:1; min-width:0;">
                    <div ref={(el) => (hlRef = el)} aria-hidden="true" class="ls-x" innerHTML={highlightHtml()} style="position:absolute; inset:0; overflow:auto; pointer-events:none; box-sizing:border-box; font-family:'JetBrains Mono', monospace; font-size:14px; line-height:20px; padding:8px 0; color:transparent; white-space:pre-wrap; overflow-wrap:break-word; word-break:break-word;"></div>
                    <textarea rows="1" placeholder="Paste a chat or type a reply…" value={state.value} onInput={onInput} onKeyDown={onInputKey} onScroll={onInputScroll} ref={(el) => (inputRef = el)} class="ls-x" style="position:relative; width:100%; box-sizing:border-box; background:transparent; border:none; outline:none; resize:none; font-family:'JetBrains Mono', monospace; font-size:14px; line-height:20px; color:#e4e2e3; caret-color:#e4e2e3; padding:8px 0; height:36px; max-height:96px; display:block;"></textarea>
                  </div>
                  <button aria-label="Send" onClick={onSend} class="ls-press" style={`flex-shrink:0; width:40px; height:40px; border-radius:14px; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:background 0.2s, box-shadow 0.2s, transform 0.08s, border-color 0.2s; background:${sendBg()}; color:${sendColor()}; border:1px solid ${sendBorder()}; box-shadow:${sendShadow()};`}>
                    <span style={ms + "font-size:21px; font-variation-settings:'FILL' 1, 'wght' 600;"}>arrow_upward</span>
                  </button>
                </div>
              </div>
            </div>
          </Show>

          {/* ===== DIALOGS / CONVERSATIONS SCREEN ===== */}
          <Show when={state.screen === 'list'}>
            <div class="ls-screen" style="position:absolute; inset:0; display:flex; flex-direction:column;">
              {/* list header */}
              <div style="flex-shrink:0; padding:58px 20px 14px; display:flex; flex-direction:column; gap:14px; background:rgba(20,20,21,0.6); backdrop-filter:blur(22px) saturate(160%); -webkit-backdrop-filter:blur(22px) saturate(160%); border-bottom:1px solid rgba(68,71,75,0.4); z-index:10;">
                <div style="display:flex; align-items:flex-end; justify-content:space-between;">
                  <div>
                    <div style="font-size:22px; font-weight:700; letter-spacing:-0.5px; color:#e4e2e3;">Messages</div>
                    <div style="display:flex; align-items:center; gap:5px; margin-top:4px;">
                      <span style={ms + 'font-size:13px; color:#bdc7d7;'}>translate</span>
                      <span style="font-size:10.5px; letter-spacing:0.2px; color:#9a9ba0;">Auto-translated · {state.chats.length} chats</span>
                    </div>
                  </div>
                  <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                    <button aria-label="Settings" onClick={goToSettings} class="ls-press" style="width:40px; height:40px; border-radius:13px; display:flex; align-items:center; justify-content:center; cursor:pointer; background:rgba(53,53,54,0.6); color:#c5c6cc; border:1px solid rgba(143,145,150,0.28); box-shadow:0 2px 10px rgba(0,0,0,0.3); transition:transform 0.08s;">
                      <span style={ms + 'font-size:21px;'}>settings</span>
                    </button>
                    <button aria-label="New chat" onClick={openNewChat} class="ls-press" style="width:40px; height:40px; border-radius:13px; display:flex; align-items:center; justify-content:center; cursor:pointer; background:linear-gradient(155deg,#dbe4f4,#b4bfd1); color:#1c2531; border:1px solid rgba(219,228,244,0.6); box-shadow:0 4px 14px rgba(189,199,215,0.28), inset 0 1px 0 rgba(255,255,255,0.45); transition:transform 0.08s;">
                      <span style={ms + 'font-size:21px;'}>edit_square</span>
                    </button>
                  </div>
                </div>
                <div style="display:flex; align-items:center; gap:8px; padding:9px 12px; border-radius:13px; background:rgba(53,53,54,0.55); border:1px solid rgba(68,71,75,0.45);">
                  <span style={ms + 'font-size:18px; color:#76777c;'}>search</span>
                  <input value={state.searchQuery} onInput={onSearchInput} placeholder="Search conversations" style="flex:1; min-width:0; box-sizing:border-box; background:transparent; border:none; outline:none; font-family:'JetBrains Mono', monospace; font-size:13px; color:#e4e2e3; padding:0;" />
                </div>
              </div>

              {/* conversation list */}
              <div class="ls-x" style="flex:1; overflow-y:auto; padding:8px 10px 36px; display:flex; flex-direction:column; gap:4px;">
                <For each={conversations()}>
                  {(c) => (
                    <div style="position:relative; border-radius:16px; overflow:hidden;">
                      <div
                        data-name={c.name}
                        onPointerDown={onSlideDown}
                        onPointerMove={onSlideMove}
                        onPointerUp={onSlideUp}
                        class="ls-mrow"
                        style={`position:relative; z-index:1; display:flex; align-items:center; gap:13px; padding:11px 12px; cursor:pointer; touch-action:pan-y; transform:${c.rowTransform}; transition:transform 0.3s cubic-bezier(0.22,1,0.36,1);`}
                      >
                        <div style={`flex-shrink:0; width:48px; height:48px; border-radius:9999px; display:flex; align-items:center; justify-content:center; background:${c.bg}; border:1px solid rgba(143,145,150,0.25); font-size:17px; font-weight:700; color:#e6e4e5; font-family:'JetBrains Mono', monospace;`}>{c.initial}</div>
                        <div style="flex:1; min-width:0;">
                          <div style="display:flex; align-items:center; gap:8px;">
                            <Show when={c.editing}>
                              <input value={state.rowDraft} onInput={onRowDraftInput} onKeyDown={onRowKey} onBlur={commitRow} onClick={stopProp} onPointerDown={stopProp} ref={(el) => (rowInputRef = el)} style="width:160px; box-sizing:border-box; font-family:'JetBrains Mono', monospace; font-size:14px; font-weight:700; color:#e4e2e3; background:rgba(13,13,14,0.7); border:1px solid rgba(189,199,215,0.45); border-radius:7px; outline:none; padding:3px 8px;" />
                            </Show>
                            <Show when={c.notEditing}>
                              <span style="font-size:14px; font-weight:700; color:#e4e2e3; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{c.display}</span>
                            </Show>
                            <span style="font-size:8.5px; font-weight:700; letter-spacing:0.5px; color:#8a98ac; background:rgba(189,199,215,0.12); border:1px solid rgba(189,199,215,0.2); padding:1px 5px; border-radius:5px; flex-shrink:0;">{c.lang}</span>
                          </div>
                          <div style="font-size:12.5px; color:#9a9ba0; margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{c.preview}</div>
                        </div>
                        <div style="flex-shrink:0; display:flex; flex-direction:column; align-items:flex-end; gap:6px; padding-left:4px;">
                          <span style="font-size:10px; color:#76777c;">{c.time}</span>
                        </div>
                      </div>
                      <div data-actions="1" style={`position:absolute; top:0; right:0; bottom:0; z-index:2; display:flex; align-items:stretch; transform:${c.actionsTransform}; transition:transform 0.3s cubic-bezier(0.22,1,0.36,1);`}>
                        <button data-name={c.name} onClick={onSwipeEdit} aria-label="Rename" style="width:66px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; border:none; cursor:pointer; background:rgba(70,73,79,0.95); color:#e4e2e3; font-family:'JetBrains Mono', monospace; font-size:9px;">
                          <span style={ms + 'font-size:19px;'}>edit</span>Edit
                        </button>
                        <button data-name={c.name} onClick={onSwipeDelete} aria-label="Delete" style="width:66px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; border:none; cursor:pointer; background:#7a1f1f; color:#ffd9d4; font-family:'JetBrains Mono', monospace; font-size:9px;">
                          <span style={ms + 'font-size:19px;'}>delete</span>Delete
                        </button>
                      </div>
                    </div>
                  )}
                </For>
                <Show when={noResults()}>
                  <div style="padding:30px 16px 16px; text-align:center; font-size:12.5px; line-height:1.5; color:#76777c;">No conversations match “{state.searchQuery}”.</div>
                </Show>
              </div>
            </div>
          </Show>

          {/* ===== SETTINGS SCREEN ===== */}
          <Show when={state.screen === 'settings'}>
            <div class="ls-screen" style="position:absolute; inset:0; display:flex; flex-direction:column;">
              <div style="flex-shrink:0; padding:58px 18px 14px; display:flex; align-items:center; gap:12px; background:rgba(20,20,21,0.6); backdrop-filter:blur(22px) saturate(160%); -webkit-backdrop-filter:blur(22px) saturate(160%); border-bottom:1px solid rgba(68,71,75,0.4); z-index:10;">
                <button aria-label="Back" onClick={goToList} class="ls-press" style="flex-shrink:0; width:38px; height:38px; border-radius:12px; display:flex; align-items:center; justify-content:center; cursor:pointer; background:rgba(53,53,54,0.6); color:#c5c6cc; border:1px solid rgba(143,145,150,0.28); transition:transform 0.08s;">
                  <span style={ms + 'font-size:21px;'}>arrow_back</span>
                </button>
                <div style="font-size:18px; font-weight:700; letter-spacing:-0.3px; color:#e4e2e3;">Settings</div>
              </div>
              <div class="ls-x" style="flex:1; overflow-y:auto; padding:20px 18px 40px; display:flex; flex-direction:column; gap:14px;">
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
                  <button onClick={onAddSelf} class="ls-press-96" style="flex-shrink:0; padding:0 16px; border-radius:12px; display:flex; align-items:center; justify-content:center; cursor:pointer; background:linear-gradient(155deg,#dbe4f4,#b4bfd1); color:#1c2531; border:1px solid rgba(219,228,244,0.6); font-family:'JetBrains Mono', monospace; font-size:13px; font-weight:700; transition:transform 0.08s;">Add</button>
                </div>
                <button onClick={onAddFiller} class="ls-filler" style="align-self:flex-start; display:flex; align-items:center; gap:5px; background:none; border:none; cursor:pointer; color:#76777c; font-family:'JetBrains Mono', monospace; font-size:11px; transition:color 0.15s;">
                  <span style={ms + 'font-size:15px;'}>add</span>Add empty placeholder (ㅤ)
                </button>
                <div style="display:flex; flex-direction:column; gap:8px; margin-top:2px;">
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
          </Show>
    </div>
  );
}
