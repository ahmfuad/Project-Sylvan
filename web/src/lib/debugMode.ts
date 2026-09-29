import { useSyncExternalStore } from 'react';

/**
 * Hidden debug mode: shows the real sample status (failed sensors, failure reasons, estimated
 * values) that production pages hide. Turn it on with `?debug=1` on any page (or the switch on
 * /debug) and off with `?debug=0`. Remembered per browser.
 */
const KEY = 'sylvan-debug';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setDebugMode(on: boolean) {
  try {
    if (on) window.localStorage.setItem(KEY, '1');
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the setting just won't persist.
  }
  for (const listener of listeners) listener();
}

/** Applies `?debug=1` / `?debug=0` from a URL query string. */
export function applyDebugParam(search: string) {
  const value = new URLSearchParams(search).get('debug');
  if (value === '1') setDebugMode(true);
  else if (value === '0') setDebugMode(false);
}

export function useDebugMode(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    () => false,
  );
}
