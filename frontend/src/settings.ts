// Settings persistence bridge.
//
// In the Tauri desktop app, targetLang + selfNames are persisted by the Rust
// backend (a JSON file in the app config dir) via invoke commands, so they
// survive restarts. In a plain browser (e.g. `vite dev` without Tauri) it
// transparently falls back to localStorage so the UI still works standalone.

import { invoke } from '@tauri-apps/api/core';

export type Settings = { targetLang: string; selfNames: string[] };

const DEFAULTS: Settings = { targetLang: 'English', selfNames: [] };
const LS_KEY = 'linguasync.settings';
const CHATS_KEY = 'linguasync.chats';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function normalize(s: Partial<Settings> | null | undefined): Settings {
  return {
    targetLang: s && typeof s.targetLang === 'string' && s.targetLang ? s.targetLang : DEFAULTS.targetLang,
    selfNames: s && Array.isArray(s.selfNames) ? s.selfNames : [],
  };
}

export async function loadSettings(): Promise<Settings> {
  if (isTauri()) {
    try {
      return normalize(await invoke<Settings>('load_settings'));
    } catch {
      return { ...DEFAULTS };
    }
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const payload = normalize(settings);
  if (isTauri()) {
    try {
      await invoke('save_settings', { settings: payload });
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

// Persisted conversations + messages. Opaque blob (chats, sentByChat, activeName)
// owned by the UI; stored as chats.json by the Rust backend (localStorage fallback
// outside Tauri). Returns null when nothing has been saved yet (first launch).
export async function loadChats(): Promise<any | null> {
  if (isTauri()) {
    try {
      const data = await invoke<any>('load_chats');
      return data ?? null;
    } catch {
      return null;
    }
  }
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function saveChats(data: any): Promise<void> {
  if (isTauri()) {
    try {
      await invoke('save_chats', { data });
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

// Whether a `codex` binary was detected by the Rust backend. Returns null when
// running outside Tauri (the browser can't probe the machine).
export async function codexAvailable(): Promise<boolean | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<boolean>('codex_available');
  } catch {
    return false;
  }
}
