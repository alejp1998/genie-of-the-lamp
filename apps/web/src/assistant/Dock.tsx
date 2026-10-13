import { useCallback, useEffect, useState } from 'react';
import { IconSpark } from '../components/Icons';
import { type EditorContext, gateway, type GatewayConfig } from './api';
import { PROMPT_EVENT, type AssistantPrompt } from './selectionActions';
import type { Prefill } from './Composer';
import AssistantPanel from './AssistantPanel';

const MIN_W = 300;
const DEFAULT_W = 380;
const openKey = (userId: string, projectId: string) => `aldine.assistant.open.${userId}.${projectId}`;
const WIDTH_KEY = 'aldine.assistant.width';

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* unavailable */ } };

export const clampAssistantWidth = (w: number) => Math.min(Math.max(MIN_W, w), Math.max(MIN_W, Math.round(window.innerWidth * 0.45)));

export interface Dock {
  config: GatewayConfig | null;
  open: boolean;
  width: number;
  setOpen(v: boolean): void;
  setWidth(w: number): void;
  /** Width the panel takes from the row right now (0 when closed or absent). */
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
    const fit = () => setWidthState((w) => clampAssistantWidth(w));
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

  return { config, open: !!config && open, width, setOpen, setWidth, reserved: config && open ? width : 0 };
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
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const { setOpen } = dock;
  useEffect(() => {
    const onPrompt = (e: Event) => {
      const p = (e as CustomEvent<AssistantPrompt>).detail;
      setOpen(true);
      setPrefill((cur) => ({ text: p.text, withSelection: p.withSelection, selection: p.selection, seq: (cur?.seq ?? 0) + 1 }));
    };
    window.addEventListener(PROMPT_EVENT, onPrompt);
    return () => window.removeEventListener(PROMPT_EVENT, onPrompt);
  }, [setOpen]);
  if (!dock.config || !dock.open) return null;
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
        <AssistantPanel projectId={projectId} config={dock.config} getContext={getContext} onClose={() => dock.setOpen(false)} onShowHistory={onShowHistory} getFiles={getFiles} prefill={prefill} />
      </div>
    </>
  );
}
