// Debug page (P1-12, temporary: deleted in P2-10). Rooms → agents with a provider badge, status and activity, live
// from the store (SSE, or the in-browser demo office with ?mock=1).
import { t } from '../../../shared/i18n';
import type { OfficeSnapshot } from '../../../shared/protocol';
import type { ConnectionState, OfficeStore } from '../net/store';
import { debugRooms } from './model';

const STATUS_COLORS: Record<string, string> = {
  working: '#2e9d4f',
  waiting: '#d9822b',
  idle: '#5b7fa6',
  shell: '#8a63c9',
  done: '#3aa6a0',
  offline: '#8a8a8a',
};

const CSS = `
  .debug { position: absolute; top: 0; right: 0; bottom: 0; width: min(480px, 100%); overflow: auto; padding: 12px 16px;
    box-sizing: border-box; background: var(--panel); color: var(--text); pointer-events: auto; }
  .debug header { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; margin-bottom: 12px; }
  .debug h1 { font-size: 16px; margin: 0; }
  .debug .muted { opacity: 0.65; }
  .debug section { border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; }
  .debug h2 { font-size: 14px; margin: 0 0 6px; overflow-wrap: anywhere; }
  .debug table { border-collapse: collapse; width: 100%; table-layout: fixed; font-size: 13px; }
  .debug td { padding: 3px 6px 3px 0; vertical-align: top; overflow-wrap: anywhere; }
  .debug td:nth-child(1) { width: 22%; } .debug td:nth-child(2) { display: none; } .debug td:nth-child(3) { width: 24%; }
  .debug td:nth-child(4) { width: 20%; }
  .debug .badge { display: inline-block; padding: 0 6px; border-radius: 4px; color: #fff; font-size: 12px; white-space: nowrap; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function badge(text: string, color: string): HTMLSpanElement {
  const b = el('span', text, 'badge');
  b.style.background = color;
  return b;
}

function render(root: HTMLElement, status: HTMLElement, snap: OfficeSnapshot): void {
  status.textContent = t('rev {0} · {1} agents · {2}', [snap.rev, snap.agents.length, new Date(snap.serverTime).toLocaleTimeString()]);
  const rooms = debugRooms(snap);
  const out: HTMLElement[] = [];
  if (rooms.length === 0) out.push(el('p', t('No open sessions.'), 'muted'));
  for (const room of rooms) {
    const s = el('section');
    const h = el('h2', room.name);
    h.append(' ', el('span', room.path, 'muted'));
    s.append(h);
    const table = el('table');
    for (const a of room.agents) {
      const tr = el('tr');
      const name = el('td', `${'↳ '.repeat(a.depth)}${a.name}`);
      name.style.paddingLeft = `${a.depth * 16}px`;
      const role = el('td', a.role, 'muted');
      const prov = el('td');
      prov.append(badge(a.providerLabel, a.providerColor));
      const st = el('td');
      st.append(badge(t(a.status), STATUS_COLORS[a.status] ?? '#888'));
      if (a.jobs) st.append(' ', el('span', a.jobs === 1 ? t('1 job') : t('{0} jobs', [a.jobs]), 'muted'));
      tr.append(name, role, prov, st, el('td', a.activity));
      table.append(tr);
    }
    s.append(table);
    out.push(s);
  }
  root.replaceChildren(...out);
}

export function startDebugPage(app: HTMLElement, store: OfficeStore): void {
  const style = el('style', CSS);
  document.head.append(style);
  const header = el('header');
  const conn = el('span', '', 'muted');
  const status = el('span', '', 'muted');
  header.append(el('h1', t('Agent Office: debug')), conn, status);
  const rooms = el('main');
  app.classList.add('debug');
  app.replaceChildren(header, rooms);

  const LABELS: Record<ConnectionState, string> = {
    connecting: t('connecting…'),
    open: t('live'),
    closed: t('disconnected, retrying…'),
    mock: t('mock mode (simulated in this browser)'),
  };
  const showConnection = (c: ConnectionState) => (conn.textContent = LABELS[c]);
  showConnection(store.connection);
  store.on('connection', showConnection);
  store.on('snapshot', (snap) => render(rooms, status, snap));
  if (store.snapshot) render(rooms, status, store.snapshot);
}
