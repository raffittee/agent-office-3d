// The page's side of the desktop app (P9-05, P9-07). Only active inside the app (`?shell=desktop` and the preload's
// window.agentOfficeShell); in a normal browser none of this exists. Widget mode swaps the panels for one slim bar,
// keeps the camera fitted to the office, and the integrations dialog installs the agent hooks.
import { t } from '../../../shared/i18n';
import type { OfficeStore } from '../net/store';
import type { WorldApi } from '../render3d/world';
import { modal } from './dialogs';
import { button, el } from './dom';
import { countByStatus } from './model';

export type ShellMode = 'window' | 'widget';

export interface ShellState {
  mode: ShellMode;
  pinned: boolean;
  clickThrough: boolean;
  version: string;
  platform: string;
}

export interface IntegrationsInfo {
  node: { ok: boolean; message: string };
  items: { id: string; installed: boolean }[];
}

/** What the app's preload exposes (desktop/src/preload.ts). */
export interface ShellBridge {
  getState(): Promise<ShellState | null>;
  setMode(mode: ShellMode): Promise<void>;
  togglePinned(): Promise<void>;
  minimize(): Promise<void>;
  close(): Promise<void>;
  integrations(): Promise<IntegrationsInfo | null>;
  runIntegration(id: string, action: 'install' | 'uninstall'): Promise<{ ok: boolean; output: string } | null>;
  onState(cb: (state: ShellState) => void): () => void;
  onOpenIntegrations(cb: () => void): () => void;
}

declare global {
  interface Window {
    agentOfficeShell?: ShellBridge;
  }
}

/** `?shell=desktop&mode=widget` → 'widget'; null outside the app. */
export function parseShell(search: string): ShellMode | null {
  const p = new URLSearchParams(search);
  if (p.get('shell') !== 'desktop') return null;
  return p.get('mode') === 'widget' ? 'widget' : 'window';
}

export const WIDGET_BAR_HEIGHT = 30;

/** The camera's free area: the widget bar on top, nothing else covers the office. */
export function widgetInsets(): { top: number; left: number; right: number; bottom: number } {
  return { top: WIDGET_BAR_HEIGHT, left: 0, right: 0, bottom: 0 };
}

export const INTEGRATION_ROWS: Record<string, { title: string; hint: string }> = {
  'gemini-cli': { title: 'Gemini CLI', hint: 'Live activity from Gemini CLI 0.65 or newer. Restart open Gemini sessions after changing this.' },
  codex: { title: 'Codex', hint: 'Live tool activity from Codex. Trust the new hooks in Codex with /hooks.' },
  'claude-code': { title: 'Claude Code: answer from the office', hint: 'Approve permission requests from here. Needs interactive mode (AGENT_OFFICE_INTERACTIVE=1, see docs/interactive.md).' },
  usage: { title: 'Claude Code: plan usage', hint: 'Shows your 5-hour and weekly plan usage in the top bar.' },
};

/** Is this the app? Returns its bridge, or null in a browser. */
export function shellBridge(): ShellBridge | null {
  if (typeof window === 'undefined' || !parseShell(location.search)) return null;
  return window.agentOfficeShell ?? null;
}

export interface Shell {
  mode: ShellMode | null;
  /** Buttons for the top bar (window mode). */
  topbarButtons: HTMLElement[];
  /** The camera insets to use instead of the panels', in widget mode. */
  insets: (() => { top: number; left: number; right: number; bottom: number }) | null;
}

const NONE: Shell = { mode: null, topbarButtons: [], insets: null };

export function createShell(root: HTMLElement, store: OfficeStore, world: WorldApi, dialog: (open: () => () => void) => void): Shell {
  const bridge = shellBridge();
  const mode = parseShell(location.search);
  if (!bridge || !mode) return NONE;
  document.documentElement.classList.add('shell-desktop', `shell-${mode}`);
  bridge.onOpenIntegrations(() => dialog(() => openIntegrations(root, bridge)));
  const integrations = button('🔌', t('Hooks and integrations'), () => dialog(() => openIntegrations(root, bridge)));
  if (mode === 'window') {
    const widget = button('▣', t('Switch to the widget'), () => void bridge.setMode('widget'));
    return { mode, topbarButtons: [widget, integrations], insets: null };
  }
  root.append(createWidgetBar(store, world, bridge));
  // the whole office stays in view whatever size the widget is dragged to
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fit = () => {
    clearTimeout(timer);
    timer = setTimeout(() => world.overview(), 150);
  };
  addEventListener('resize', fit);
  let first = true;
  store.on('snapshot', () => {
    if (!first) return;
    first = false;
    fit();
  });
  return { mode, topbarButtons: [], insets: widgetInsets };
}

function createWidgetBar(store: OfficeStore, world: WorldApi, bridge: ShellBridge): HTMLElement {
  const bar = el('header', 'ui-shellbar');
  const title = el('span', 'ui-shellbar-title', t('Agent Office'));
  const counts = el('span', 'ui-shellbar-counts');
  counts.setAttribute('aria-live', 'polite');
  const render = () => {
    const c = countByStatus(store.snapshot?.agents ?? []);
    counts.replaceChildren();
    if (c.waiting) counts.append(el('span', 'ui-shellbar-alert', t('{0} need you', [c.waiting])));
    if (c.working) counts.append(el('span', '', t('{0} working', [c.working])));
    if (!c.waiting && !c.working) counts.append(el('span', '', store.snapshot?.agents.length ? t('all quiet') : t('no agents')));
  };
  store.on('snapshot', render);
  render();
  const pin = button('📌', t('Keep on top'), () => void bridge.togglePinned(), 'ui-btn ui-shell-btn');
  pin.setAttribute('aria-pressed', 'true');
  const frame = button('⤢', t('Frame the office'), () => world.overview(), 'ui-btn ui-shell-btn');
  const expand = button('▢', t('Open the full window'), () => void bridge.setMode('window'), 'ui-btn ui-shell-btn');
  const min = button('–', t('Minimize'), () => void bridge.minimize(), 'ui-btn ui-shell-btn');
  const close = button('✕', t('Close (hides to the tray)'), () => void bridge.close(), 'ui-btn ui-shell-btn');
  bar.append(title, counts, el('span', 'ui-spacer'), pin, frame, expand, min, close);
  const showState = (s: ShellState) => {
    pin.setAttribute('aria-pressed', String(s.pinned));
    pin.classList.toggle('on', s.pinned);
    bar.classList.toggle('click-through', s.clickThrough);
  };
  void bridge.getState().then((s) => s && showState(s));
  bridge.onState(showState);
  return bar;
}

/** The dialog that installs and removes the agent hooks. */
export function openIntegrations(root: HTMLElement, bridge: ShellBridge): () => void {
  const body = el('div', 'ui-integrations');
  const note = el('p', 'ui-int-node', t('Checking…'));
  const list = el('div', 'ui-int-list');
  const output = el('pre', 'ui-int-output');
  output.hidden = true;
  const refresh = async () => {
    const info = await bridge.integrations();
    if (!info) {
      note.textContent = t('The app could not check the hooks.');
      return;
    }
    note.textContent = info.node.message;
    note.classList.toggle('bad', !info.node.ok);
    list.replaceChildren(
      ...info.items.map((item) => {
        const row = el('div', 'ui-int-row');
        const text = el('div', 'ui-int-text');
        const meta = INTEGRATION_ROWS[item.id] ?? { title: item.id, hint: '' };
        text.append(el('b', '', t(meta.title)), el('span', 'ui-int-state', item.installed ? t('installed') : t('not installed')), el('small', '', t(meta.hint)));
        const act = button(item.installed ? t('Remove') : t('Install'), item.installed ? t('Remove the hooks') : t('Install the hooks'), () => {
          void (async () => {
            act.disabled = true;
            const result = await bridge.runIntegration(item.id, item.installed ? 'uninstall' : 'install');
            output.hidden = false;
            output.textContent = result?.output || t('Done.');
            output.classList.toggle('bad', !!result && !result.ok);
            await refresh();
          })();
        });
        // the hook scripts need Node.js on the PATH (Claude Code's plan-usage tap too: it is a Node script)
        if (!item.installed && !info.node.ok && item.id !== 'claude-code') act.title = t('Install Node.js first');
        row.append(text, act);
        return row;
      }),
    );
  };
  body.append(note, list, output);
  const back = modal(t('Hooks and integrations'), [body], () => back.remove());
  root.append(back);
  void refresh();
  return () => back.remove();
}
