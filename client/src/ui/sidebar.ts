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

  const render = () => {
    const snap = store.snapshot;
    if (!snap) {
      body.replaceChildren(el('div', 'ui-empty', t('Connecting…')));
      return;
    }
    renderChips(snap);
    const shown = new Set(snap.agents.map((a) => a.provider).filter((p) => !hidden.has(p)));
    const tree = sidebarTree(snap, { query: search.value, providers: hidden.size ? shown : new Set() });
    const sel = world.getSelection();
    const out: HTMLElement[] = [];
    if (!tree.length) out.push(el('div', 'ui-empty', search.value ? t('Nothing matches “{0}”.', [search.value]) : t('No open sessions yet. Start an agent and it appears here.')));
    for (const r of tree) {
      const box = el('div', 'ui-room');
      const h = el('div', 'ui-room-head');
      h.append(el('span', '', r.room.name), el('small', '', r.waiting ? t('{0} need you', [r.waiting]) : r.room.path));
      h.title = r.room.path;
      h.addEventListener('click', () => world.select({ type: 'room', id: r.room.id }, { focus: true }));
      box.append(h);
      for (const { agent: a, depth } of r.agents) {
        const row = el('div', `ui-agent${sel?.type === 'agent' && sel.id === a.id ? ' selected' : ''}`);
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.style.paddingLeft = `${6 + depth * 14}px`;
        const dot = el('i', 'dot');
        dot.style.background = STATUS_COLORS[a.status];
        dot.title = statusLabel(a.status);
        const who = el('div', 'who');
        const name = el('b', '', a.name);
        const line = a.status === 'waiting' ? `✋ ${a.waitingFor ?? t('needs you')}` : a.activity ? `${a.activity.icon} ${a.activity.text}` : statusLabel(a.status);
        who.append(name, el('span', '', line));
        const meta = providerMeta(snap, a.provider);
        const b = el('span', 'ui-badge', meta.label);
        b.style.background = meta.color;
        row.append(dot, who, b);
        const go = () => world.select({ type: 'agent', id: a.id }, { focus: true });
        row.addEventListener('click', go);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            go();
          }
        });
        box.append(row);
      }
      out.push(box);
    }
    body.replaceChildren(...out);
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
