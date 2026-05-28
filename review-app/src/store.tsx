/**
 * Global UI state: register (vibe / technical) + collapsible layout.
 *
 * Data and approvals stay in App.tsx (they already do) — this store only owns
 * the cross-cutting view state that any panel might want to read.
 *
 * Persisted to localStorage under `reframe.ui.v1`. The store reads on mount
 * and writes on every change. Failure to read/write is silent — the default
 * state is the safe fallback.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import type { Register } from './types';

export type PanelKey = 'findings' | 'preview' | 'brand' | 'contract';

export interface UiState {
  register: Register;
  /** Sidebar visible? */
  sidebar: boolean;
  /** Px widths of the two resizable splits (left = findings col, right = side col). */
  leftWidth: number;
  rightWidth: number;
  /** Per-panel collapse map for stacked / mobile mode. */
  collapsed: Record<PanelKey, boolean>;
  /** Engine internals drawer. */
  engineDrawer: boolean;
}

const DEFAULT: UiState = {
  register: 'vibe',
  sidebar: true,
  leftWidth: 540,
  rightWidth: 420,
  collapsed: { findings: false, preview: false, brand: false, contract: false },
  engineDrawer: false,
};

const LS_KEY = 'reframe.ui.v1';

type Action =
  | { type: 'setRegister'; value: Register }
  | { type: 'toggleSidebar' }
  | { type: 'setLeftWidth'; value: number }
  | { type: 'setRightWidth'; value: number }
  | { type: 'togglePanel'; key: PanelKey }
  | { type: 'setEngineDrawer'; open: boolean }
  | { type: 'hydrate'; value: Partial<UiState> };

function reducer(s: UiState, a: Action): UiState {
  switch (a.type) {
    case 'setRegister':    return { ...s, register: a.value };
    case 'toggleSidebar':  return { ...s, sidebar: !s.sidebar };
    case 'setLeftWidth':   return { ...s, leftWidth: clamp(a.value, 320, 900) };
    case 'setRightWidth':  return { ...s, rightWidth: clamp(a.value, 280, 700) };
    case 'togglePanel':    return { ...s, collapsed: { ...s.collapsed, [a.key]: !s.collapsed[a.key] } };
    case 'setEngineDrawer':return { ...s, engineDrawer: a.open };
    case 'hydrate':        return { ...s, ...a.value, collapsed: { ...s.collapsed, ...(a.value.collapsed || {}) } };
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

interface Ctx {
  ui: UiState;
  dispatch: React.Dispatch<Action>;
}

const UiContext = createContext<Ctx | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [ui, dispatch] = useReducer(reducer, DEFAULT);

  // Hydrate once on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        dispatch({ type: 'hydrate', value: parsed });
      }
    } catch { /* swallow — defaults win */ }
  }, []);

  // Persist on every change.
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(ui)); } catch { /* quota / SSR */ }
  }, [ui]);

  const value = useMemo(() => ({ ui, dispatch }), [ui]);
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): Ctx {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi() outside <UiProvider>');
  return ctx;
}
