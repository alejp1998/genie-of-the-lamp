import { useCallback, useEffect, useState } from 'react';
import { IconSpark } from '../components/Icons';
import { type EditorContext, gateway, type GatewayConfig } from './api';
import { PROMPT_EVENT, type AssistantPrompt } from './selectionActions';
import type { Prefill } from './Composer';
import AssistantPanel from './AssistantPanel';
import { isPlacement, type Placement } from './placement';

export { PLACEMENTS, type Placement } from './placement';

const MIN_W = 300;
const DEFAULT_W = 380;
const openKey = (userId: string, projectId: string) => `aldine.assistant.open.${userId}.${projectId}`;
const WIDTH_KEY = 'aldine.assistant.width';
const PLACEMENT_KEY = 'aldine.assistant.placement';
const SIDEBAR_KEY = 'aldine.sidebar.width';
const BELOW_KEY = 'aldine.assistant.belowFraction';
/** Aldine's own sidebar width; the extra a wider sidebar takes is room the preview gives up. */
const BASE_SIDEBAR_W = 230;
const DEFAULT_SIDEBAR_W = 340;
/** Share of the sidebar's height the assistant takes below the tabs; the tabs keep the top quarter. */
const DEFAULT_BELOW = 0.75;
const clampBelow = (f: number) => Math.min(Math.max(0.2, f), 0.92);


const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* unavailable */ } };

export const clampAssistantWidth = (w: number) => Math.min(Math.max(MIN_W, w), Math.max(MIN_W, Math.round(window.innerWidth * 0.45)));
export const clampSidebarWidth = (w: number) => Math.min(Math.max(BASE_SIDEBAR_W, w), Math.max(BASE_SIDEBAR_W, Math.round(window.innerWidth * 0.45)));

export interface Dock {
  config: GatewayConfig | null;
  open: boolean;
  width: number;
  setOpen(v: boolean): void;
  setWidth(w: number): void;
  placement: Placement;
  setPlacement(p: Placement): void;
  /** Sidebar width while the assistant lives in it. */
  sidebarWidth: number;
  setSidebarWidth(w: number): void;
  /** Share of the sidebar's height the panel takes in the "below" placement. */
  belowFraction: number;
  setBelowFraction(f: number): void;
  /** Latest prompt from an editor selection action. */
  prefill: Prefill | null;
  /** Width the assistant takes from the row right now, beyond Aldine's own layout (0 when absent). */
  reserved: number;
}

/**
 * The assistant exists only where a gateway answers next to this Aldine, so
 * a plain Aldine deployment shows nothing new. Open state is remembered per
 * user and project, width per browser.
 */
export function useAssistantDock(projectId: string): Dock {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [open, setOpenState] = useState(false);
  const [width, setWidthState] = useState(() => clampAssistantWidth(Number(read(WIDTH_KEY)) || DEFAULT_W));
  const [placement, setPlacementState] = useState<Placement>(() => { const v = read(PLACEMENT_KEY); return isPlacement(v) ? v : 'below'; });
  const [sidebarWidth, setSidebarState] = useState(() => clampSidebarWidth(Number(read(SIDEBAR_KEY)) || DEFAULT_SIDEBAR_W));
  const [belowFraction, setBelowState] = useState(() => clampBelow(Number(read(BELOW_KEY)) || DEFAULT_BELOW));
  const [prefill, setPrefill] = useState<Prefill | null>(null);

  useEffect(() => {
    let cancelled = false;
    gateway.probe().then((c) => {
      if (cancelled || !c) return;
      setConfig(c);
      setOpenState(read(openKey(c.user.id, projectId)) === '1');
      // The editor's selection actions show only where an assistant answers.
      document.documentElement.dataset.assistant = '1';
      if (c.research?.literature) document.documentElement.dataset.assistantResearch = '1';
    });
    return () => { cancelled = true; delete document.documentElement.dataset.assistant; delete document.documentElement.dataset.assistantResearch; };
  }, [projectId]);

  useEffect(() => {
    const fit = () => { setWidthState((w) => clampAssistantWidth(w)); setSidebarState((w) => clampSidebarWidth(w)); };
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  const setOpen = useCallback((v: boolean) => {
    setOpenState(v);
    if (config) write(openKey(config.user.id, projectId), v ? '1' : '0');
  }, [config, projectId]);

  const setWidth = useCallback((w: number) => {
    const c = clampAssistantWidth(w);
    setWidthState(c);
    write(WIDTH_KEY, String(c));
  }, []);

  const setPlacement = useCallback((p: Placement) => { setPlacementState(p); write(PLACEMENT_KEY, p); }, []);
  const setSidebarWidth = useCallback((w: number) => { const c = clampSidebarWidth(w); setSidebarState(c); write(SIDEBAR_KEY, String(c)); }, []);
  const setBelowFraction = useCallback((f: number) => { const c = clampBelow(f); setBelowState(c); write(BELOW_KEY, String(c)); }, []);

  // Selection actions (Ask, Explain, …) open the panel wherever it lives.
  useEffect(() => {
    const onPrompt = (e: Event) => {
      const p = (e as CustomEvent<AssistantPrompt>).detail;
      setOpen(true);
      setPrefill((cur) => ({ text: p.text, withSelection: p.withSelection, selection: p.selection, seq: (cur?.seq ?? 0) + 1 }));
    };
    window.addEventListener(PROMPT_EVENT, onPrompt);
    return () => window.removeEventListener(PROMPT_EVENT, onPrompt);
  }, [setOpen]);

  const reserved = !config ? 0 : placement === 'right' ? (open ? width : 0) : sidebarWidth - BASE_SIDEBAR_W;
  return { config, open: !!config && open, width, setOpen, setWidth, placement, setPlacement, sidebarWidth, setSidebarWidth, belowFraction, setBelowFraction, prefill, reserved };
}

export function AssistantToggle({ dock }: { dock: Dock }) {
  if (!dock.config) return null;
  return (
    <button
      className="btn btn--ghost assistant-toggle"
      onClick={() => dock.setOpen(!dock.open)}
      aria-pressed={dock.open}
      title={dock.open ? 'Hide the assistant' : `Ask ${dock.config.agentLabel} about this project`}
      data-testid="assistant-toggle"
    >
      <IconSpark /> Assistant
    </button>
  );
}

interface DockProps {
  dock: Dock;
  projectId: string;
  getContext(): EditorContext;
  /** Lets the workspace switch off pointer events on the panes while dragging, as for the PDF divider. */
  onResizing(v: boolean): void;
  onShowHistory?(): void;
  getFiles(): string[];
}

export function AssistantDock({ dock, projectId, getContext, onResizing, onShowHistory, getFiles }: DockProps) {
  const [dragging, setDragging] = useState(false);
  if (!dock.config || !dock.open || dock.placement !== 'right') return null;
  return (
    <>
      <div
        className={`resizer${dragging ? ' resizer--drag' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize assistant"
        aria-valuenow={Math.round(dock.width)}
        aria-valuemin={MIN_W}
        tabIndex={0}
        data-testid="assistant-resizer"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          const startX = e.clientX;
          const start = dock.width;
          setDragging(true);
          onResizing(true);
          const move = (ev: PointerEvent) => dock.setWidth(start + (startX - ev.clientX));
          const up = () => {
            setDragging(false);
            onResizing(false);
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
            el.removeEventListener('pointercancel', up);
          };
          el.addEventListener('pointermove', move);
          el.addEventListener('pointerup', up);
          el.addEventListener('pointercancel', up);
        }}
        onDoubleClick={() => dock.setWidth(DEFAULT_W)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 80 : 16;
          if (e.key === 'ArrowLeft') { e.preventDefault(); dock.setWidth(dock.width + step); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); dock.setWidth(dock.width - step); }
        }}
      />
      <div style={{ width: dock.width, flex: 'none', display: 'flex', minHeight: 0 }} className="assistant-dock">
        <AssistantPanel projectId={projectId} config={dock.config} getContext={getContext} onClose={() => dock.setOpen(false)} onShowHistory={onShowHistory} getFiles={getFiles} prefill={dock.prefill} placement={dock.placement} onPlace={dock.setPlacement} />
      </div>
    </>
  );
}

type PanelProps = Omit<DockProps, 'onResizing'>;

/** The panel inside the sidebar ("tab" and "below" placements). */
export function SidebarAssistant({ dock, projectId, getContext, onShowHistory, getFiles }: PanelProps) {
  if (!dock.config) return null;
  return <AssistantPanel projectId={projectId} config={dock.config} getContext={getContext} onClose={() => dock.setOpen(false)} onShowHistory={onShowHistory} getFiles={getFiles} prefill={dock.prefill} placement={dock.placement} onPlace={dock.setPlacement} />;
}

/** Drag handle for a pane edge: horizontal (`dx`) or vertical (`dy`) deltas from the press point. */
export function EdgeResizer({ orientation, label, value, onChange, onReset, onResizing, testId, className = '' }: {
  orientation: 'vertical' | 'horizontal';
  label: string;
  value: number;
  /** Receives the size implied by the drag: start value plus the pointer's travel. */
  onChange(v: number): void;
  onReset(): void;
  onResizing(v: boolean): void;
  testId: string;
  className?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const vertical = orientation === 'vertical';
  return (
    <div
      className={`resizer${vertical ? '' : ' resizer--h'}${dragging ? ' resizer--drag' : ''} ${className}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      data-testid={testId}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const start = vertical ? e.clientX : e.clientY;
        const startValue = value;
        setDragging(true);
        onResizing(true);
        // A vertical bar on a pane's right edge grows rightwards; a horizontal one above a pane grows upwards.
        const move = (ev: PointerEvent) => onChange(vertical ? startValue + (ev.clientX - start) : startValue + (start - ev.clientY));
        const up = () => {
          setDragging(false);
          onResizing(false);
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 80 : 16;
        const grow = vertical ? 'ArrowRight' : 'ArrowUp';
        const shrink = vertical ? 'ArrowLeft' : 'ArrowDown';
        if (e.key === grow) { e.preventDefault(); onChange(value + step); }
        else if (e.key === shrink) { e.preventDefault(); onChange(value - step); }
      }}
    />
  );
}

export const SIDEBAR_DEFAULTS = { width: DEFAULT_SIDEBAR_W, below: DEFAULT_BELOW };
