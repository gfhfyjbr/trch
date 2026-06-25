// Shared translation + language helpers for the desktop and mobile LinguaSync UIs.

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './settings';

// The active translation target. Kept here (not threaded through translateAsync)
// so the public contract `translateAsync(src) -> Promise<string>` stays intact.
// App.tsx calls setTargetLang() on load and whenever the user changes it.
let currentTargetLang = 'English';
export function setTargetLang(lang: string) {
  if (lang) currentTargetLang = lang;
}

// One prior chat message, sent to the engine as context so translations and reply
// suggestions track tone, references and pronouns across the conversation. The
// backend caps how much of this it actually uses (see render_history in codex.rs),
// so the model's context never overloads.
export type HistEntry = { speaker: string; text: string };

// Render a short history block for the browser (window.claude) fallback, which
// has no Rust-side cap — so we bound it here to the last few messages.
function historyBlock(history: HistEntry[]): string {
  const lines = history
    .filter((h) => h && h.text && h.text.trim())
    .slice(-12)
    .map((h) => `${(h.speaker || '?').trim()}: ${h.text.trim()}`);
  if (!lines.length) return '';
  return 'Conversation so far (context only — do NOT translate these lines):\n' + lines.join('\n') + '\n\n';
}

export const TRANS: Record<string, string> = {
  '你好，抱歉没回复，我刚参加完爷爷的葬礼':
    "Hi, sorry for the late reply — I just got back from my grandfather's funeral…",
  '没事的宝子，节哀顺变': "It's okay, dear — my deepest condolences.",
  '那你肯定累坏了吧': 'You must be exhausted, then.',
  '没事的 不用着急回我信息 你好好休息，调整调整状态，好了再来跟我聊天吧':
    "It's fine — no rush to reply. Get some good rest, take care of yourself, and come chat with me again when you're ready.",
};

export const LANGS: Record<string, string> = {
  ZH: 'Chinese', JA: 'Japanese', KO: 'Korean', RU: 'Russian',
  ES: 'Spanish', FR: 'French', DE: 'German', EN: 'English',
};

function norm(s: string) {
  return (s || '').replace(/[…\.。！!？?、，,\s]+$/g, '').trim();
}

export function dictLookup(src: string): string | null {
  if (TRANS[src.trim()]) return TRANS[src.trim()];
  const key = norm(src);
  for (const k in TRANS) if (norm(k) === key) return TRANS[k];
  return null;
}

// Resolution order, always echoing the source on failure:
//   1. local dictionary (dictLookup),
//   2. Codex app-server via the Tauri `translate` command,
//   3. window.claude.complete (Claude Design runtime, if present),
//   4. the original text.
// `toLang` defaults to the active target language; callers pass the interlocutor's
// language when translating the user's own (target-language) messages. `history`
// is recent chat context (capped backend-side) used only for tone/references.
export async function translateAsync(src: string, toLang: string = currentTargetLang, history: HistEntry[] = [], chatId = ''): Promise<string> {
  const hit = dictLookup(src);
  if (hit) return hit;

  if (isTauri()) {
    try {
      const out = await invoke<string>('translate', { chatId, text: src, targetLang: toLang, history });
      const t = (out || '').trim();
      if (t) return t;
    } catch (e) {
      return src;
    }
    return src;
  }

  const w = window as any;
  if (w.claude && typeof w.claude.complete === 'function') {
    try {
      const out = await w.claude.complete({
        messages: [
          {
            role: 'user',
            content:
              historyBlock(history) +
              'Translate the chat message below into natural, conversational ' +
              toLang +
              '. Use the conversation above only for context — translate ONLY the message below. ' +
              'Reply with ONLY the translation — no quotes, no explanations, no notes.\n\nMessage:\n' +
              src,
          },
        ],
      });
      const t = (out || '').trim();
      return t || src;
    } catch (e) {
      return src;
    }
  }
  return src;
}

// Batch variant: translate several messages in a single Codex turn (one round-trip
// instead of one request per message). Local dictionary hits are filled in place;
// the remaining messages go out together. Order is preserved, and any item the
// engine drops falls back to its own source text.
export async function translateBatch(srcs: string[], toLang: string = currentTargetLang, history: HistEntry[] = [], chatId = ''): Promise<string[]> {
  const out: (string | null)[] = srcs.map((s) => dictLookup(s));
  const idx: number[] = [];
  const texts: string[] = [];
  out.forEach((hit, i) => { if (hit == null) { idx.push(i); texts.push(srcs[i]); } });
  const finish = () => out.map((v, i) => (v == null ? srcs[i] : v));
  if (texts.length === 0) return finish();

  if (isTauri()) {
    try {
      const res = await invoke<string[]>('translate_batch', { chatId, texts, targetLang: toLang, history });
      if (Array.isArray(res)) {
        idx.forEach((target, k) => { const t = (res[k] || '').trim(); out[target] = t || srcs[target]; });
      }
    } catch (e) {
      /* leave the unfilled slots — finish() falls back to the source text */
    }
    return finish();
  }

  // Non-Tauri (browser dev): fall back to translating each one individually.
  const filled = await Promise.all(texts.map((t) => translateAsync(t, toLang, history, chatId)));
  idx.forEach((target, k) => { out[target] = filled[k]; });
  return finish();
}

// Suggest up to 3 short replies (in the active target language) to an incoming
// message. Returns [] outside Tauri or on any error.
export async function suggestReplies(message: string, lang: string = currentTargetLang, history: HistEntry[] = [], chatId = ''): Promise<string[]> {
  if (!message.trim() || !isTauri()) return [];
  try {
    const out = await invoke<string[]>('suggest_replies', { chatId, message, targetLang: lang, history });
    return Array.isArray(out) ? out.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : [];
  } catch {
    return [];
  }
}

export function detectCode(text: string) {
  const t = text || '';
  if (/[぀-ヿ]/.test(t)) return 'JA';
  if (/[가-힯]/.test(t)) return 'KO';
  if (/[一-鿿]/.test(t)) return 'ZH';
  if (/[Ѐ-ӿ]/.test(t)) return 'RU';
  if (/[áéíóúñ¿¡]/i.test(t)) return 'ES';
  if (/[àâçéèêëîïôûùœ]/i.test(t)) return 'FR';
  if (/[äöüß]/i.test(t)) return 'DE';
  return 'EN';
}

export function nowTime() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
