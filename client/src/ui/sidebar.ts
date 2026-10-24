// Sidebar (P2-10): rooms → agents, with search and a provider filter. Clicking an agent or a room selects it and
// moves the camera there.
import { t } from '../../../shared/i18n';
import type { OfficeSnapshot, ProviderId } from '../../../shared/protocol';
import type { OfficeStore } from '../net/store';
import type { WorldApi } from '../render3d/world';
import { button, el } from './dom';
import { providerMeta, sidebarTree, STATUS_COLORS, statusLabel } from './model';

export interface Sidebar {
  el: HTMLElement;
  focusSearch(): void;
  /** Width covered on screen (for the camera's free area). */
  width(): number;
}

export function createSidebar(store: OfficeStore, world: WorldApi): Sidebar {
  const root = el('aside', 'ui-sidebar');
  root.setAttribute('aria-label', t('Rooms and agents'));
  const head = el('div', 'ui-side-head');
  const search = el('input', 'ui-input');
  search.type = 'search';
  search.placeholder = t('Search agents, rooms… ( / )');
  search.setAttribute('aria-label', t('Search agents and rooms'));
  let collapsed = false;
  const toggle = button('▾', t('Collapse the list'), () => {
    collapsed = !collapsed;
    root.classList.toggle('collapsed', collapsed);
    toggle.textContent = collapsed ? '▸' : '▾';
  });
  head.append(search, toggle);
  const chips = el('div', 'ui-chips');
  const body = el('div', 'ui-side-body');
  root.append(head, chips, body);

  const hidden = new Set<ProviderId>();
  let chipsKey = '';

  const renderChips = (snap: OfficeSnapshot) => {
    const providers = [...new Set(snap.agents.filter((a) => a.status !== 'offline').map((a) => a.provider))];
    const key = providers.join() + [...hidden].join();
    if (key === chipsKey) return;
    chipsKey = key;
    chips.replaceChildren();
    chips.hidden = providers.length < 2;
    for (const id of providers) {
      const meta = providerMeta(snap, id);
      const chip = el('button', `ui-chip${hidden.has(id) ? ' off' : ''}`);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(!hidden.has(id)));
      chip.title = t('Show or hide {0} agents', [meta.label]);
      const dot = el('i');
      dot.style.background = meta.color;
      chip.append(dot, meta.label);
      chip.addEventListener('click', () => {
        if (hidden.has(id)) hidden.delete(id);
        else hidden.add(id);
        render();
      });
      chips.append(chip);
    }
  };

  // rows are keyed and reused: a snapshot only updates their text, so hover, focus and clicks survive updates
  interface Row {
    el: HTMLDivElement;
    dot: HTMLElement;
    name: HTMLElement;
    line: HTMLElement;
    badge: HTMLElement;
    key: string;
  }
  interface RoomBox {
    el: HTMLDivElement;
    title: HTMLElement;
    sub: HTMLElement;
  }
  const rows = new Map<string, Row>();
  const boxes = new Map<string, RoomBox>();
  const empty = el('div', 'ui-empty');

  const rowFor = (id: string): Row => {
    let r = rows.get(id);
    if (r) return r;
    const row = el('div', 'ui-agent');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const dot = el('i', 'dot');
    const who = el('div', 'who');
    const name = el('b');
    const line = el('span');
    who.append(name, line);
    const badge = el('span', 'ui-badge');
    row.append(dot, who, badge);
    const go = () => world.select({ type: 'agent', id }, { focus: true });
    row.addEventListener('click', go);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
    r = { el: row, dot, name, line, badge, key: '' };
    rows.set(id, r);
    return r;
  };

  const boxFor = (id: string): RoomBox => {
    let b = boxes.get(id);
    if (b) return b;
    const box = el('div', 'ui-room');
    const h = el('div', 'ui-room-head');
    const title = el('span');
    const sub = el('small');
    h.append(title, sub);
    h.addEventListener('click', () => world.select({ type: 'room', id }, { focus: true }));
    box.append(h);
    b = { el: box, title, sub };
    boxes.set(id, b);
    return b;
  };

  const render = () => {
    const snap = store.snapshot;
    if (!snap) {
      empty.textContent = t('Connecting…');
      body.replaceChildren(empty);
      return;
    }
    renderChips(snap);
    const shown = new Set(snap.agents.map((a) => a.provider).filter((p) => !hidden.has(p)));
    const tree = sidebarTree(snap, { query: search.value, providers: hidden.size ? shown : new Set() });
    const sel = world.getSelection();
    const usedRows = new Set<string>();
    const usedBoxes = new Set<string>();
    const order: HTMLElement[] = [];
    if (!tree.length) {
      empty.textContent = search.value ? t('Nothing matches “{0}”.', [search.value]) : t('No open sessions yet. Start an agent and it appears here.');
      order.push(empty);
    }
    for (const r of tree) {
      const box = boxFor(r.room.id);
      usedBoxes.add(r.room.id);
      box.title.textContent = r.room.name;
      box.sub.textContent = r.waiting ? t('{0} need you', [r.waiting]) : r.room.path;
      box.el.title = r.room.path;
      const kids: HTMLElement[] = [box.el.firstElementChild as HTMLElement];
      for (const { agent: a, depth } of r.agents) {
        const row = rowFor(a.id);
        usedRows.add(a.id);
        const meta = providerMeta(snap, a.provider);
        const line = a.status === 'waiting' ? `✋ ${a.waitingFor ?? t('needs you')}` : a.activity ? `${a.activity.icon} ${a.activity.text}` : statusLabel(a.status);
        const selected = sel?.type === 'agent' && sel.id === a.id;
        const key = `${a.name}|${a.status}|${line}|${meta.label}|${meta.color}|${depth}|${selected}`;
        if (key !== row.key) {
          row.key = key;
          row.el.classList.toggle('selected', selected);
          row.el.style.paddingLeft = `${6 + depth * 14}px`;
          row.dot.style.background = STATUS_COLORS[a.status];
          row.dot.title = statusLabel(a.status);
          row.name.textContent = a.name;
          row.line.textContent = line;
          row.badge.textContent = meta.label;
          row.badge.style.background = meta.color;
        }
        kids.push(row.el);
      }
      // reorder only when the order changed (moving a node would drop hover)
      const cur = [...box.el.children];
      if (cur.length !== kids.length || cur.some((c, i) => c !== kids[i])) box.el.replaceChildren(...kids);
      order.push(box.el);
    }
    const cur = [...body.children];
    if (cur.length !== order.length || cur.some((c, i) => c !== order[i])) body.replaceChildren(...order);
    for (const id of rows.keys()) if (!usedRows.has(id)) rows.delete(id);
    for (const id of boxes.keys()) if (!usedBoxes.has(id)) boxes.delete(id);
  };

  let timer = 0;
  const schedule = () => {
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      render();
    }, 150);
  };
  store.on('snapshot', schedule);
  world.onSelect(render);
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = '';
      render();
      search.blur();
    }
  });
  render();
  return {
    el: root,
    focusSearch: () => search.focus(),
    width: () => (root.offsetParent ? root.getBoundingClientRect().right + 8 : 0),
  };
}
