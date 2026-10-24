// Debug page (P1-12, temporary: deleted in P2-10). Rooms → agents with a provider badge, status and activity, live
// over SSE (/api/stream), or from the in-browser demo office with ?mock=1.
import { createMockOffice } from '../../../shared/demo/mock';
import { t } from '../../../shared/i18n';
import type { OfficeSnapshot } from '../../../shared/protocol';
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
  :root { color-scheme: light dark; font: 14px/1.4 system-ui, sans-serif; }
  body { margin: 0; padding: 16px; }
  header { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; margin-bottom: 12px; }
  h1 { font-size: 18px; margin: 0; }
  .muted { opacity: 0.65; }
  section { border: 1px solid #8884; border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; }
  h2 { font-size: 15px; margin: 0 0 6px; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  td:nth-child(1) { width: 18%; } td:nth-child(2) { width: 14%; } td:nth-child(3) { width: 12%; } td:nth-child(4) { width: 14%; }
  td { padding: 3px 8px 3px 0; vertical-align: top; }
  .badge { display: inline-block; padding: 0 6px; border-radius: 4px; color: #fff; font-size: 12px; white-space: nowrap; }
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

export function startDebugPage(app: HTMLElement): void {
  const style = el('style', CSS);
  document.head.append(style);
  const mock = new URLSearchParams(location.search).has('mock');
  const header = el('header');
  const conn = el('span', t('connecting…'), 'muted');
  const status = el('span', '', 'muted');
  header.append(el('h1', t('Agent Office: debug')), conn, status);
  const rooms = el('main');
  app.replaceChildren(header, rooms);

  if (mock) {
    conn.textContent = t('mock mode (simulated in this browser)');
    const office = createMockOffice({}, Date.now());
    const tick = () => render(rooms, status, office.step(Date.now()).snapshot);
    tick();
    setInterval(tick, 250);
    return;
  }

  // EventSource reconnects by itself (the server sends retry: 2000) and gets a full snapshot on every connect.
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => (conn.textContent = t('live')));
  es.addEventListener('error', () => (conn.textContent = t('reconnecting…')));
  es.addEventListener('snapshot', (ev) => {
    try {
      render(rooms, status, JSON.parse((ev as MessageEvent<string>).data) as OfficeSnapshot);
    } catch {
      conn.textContent = t('bad snapshot');
    }
  });
}
