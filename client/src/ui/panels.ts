// Top bar counters, activity feed, toasts and the hover tooltip (P2-09/P2-10).
import { t } from '../../../shared/i18n';
import type { AgentStatus, NoticeLevel } from '../../../shared/protocol';
import type { ConnectionState, OfficeStore } from '../net/store';
import type { WorldApi } from '../render3d/world';
import { button, el } from './dom';
import { ago, countByStatus, STATUS_COLORS, statusLabel } from './model';

export function createTopbar(store: OfficeStore, world: WorldApi, actions: { settings(): void; help(): void }): HTMLElement {
  const root = el('header', 'ui-topbar');
  const brand = el('div', 'ui-brand', t('Agent Office'));
  const counters = el('div', 'ui-counters');
  counters.setAttribute('aria-live', 'polite');
  const conn = el('div', 'ui-conn');
  const shown: AgentStatus[] = ['waiting', 'working', 'shell', 'idle'];
  root.append(
    brand,
    counters,
    el('div', 'ui-spacer'),
    conn,
    button('⤢', t('Frame the office (F)'), () => world.overview()),
    button('⟲', t('Turn left (Q)'), () => world.rotate(1)),
    button('⟳', t('Turn right (E)'), () => world.rotate(-1)),
    button('⚙', t('Settings (,)'), actions.settings),
    button('?', t('Help (?)'), actions.help),
  );
  const renderCounts = () => {
    const c = countByStatus(store.snapshot?.agents ?? []);
    counters.replaceChildren(
      ...shown
        .filter((s) => s !== 'waiting' || c.waiting)
        .map((s) => {
          const chip = el('span', `ui-count${s === 'waiting' ? ' alert' : ''}`);
          chip.style.setProperty('--c', STATUS_COLORS[s]);
          chip.title = statusLabel(s);
          chip.append(el('i'), `${c[s]} `, el('span', '', statusLabel(s)));
          return chip;
        }),
    );
  };
  const LABELS: Record<ConnectionState, string> = {
    connecting: t('connecting…'),
    open: t('live'),
    closed: t('disconnected, retrying…'),
    mock: t('demo in this browser'),
  };
  const renderConn = (s: ConnectionState) => {
    conn.className = `ui-conn ${s}`;
    conn.replaceChildren(el('b'), LABELS[s]);
    if (s === 'closed') {
      conn.append(' ', button(t('Retry now'), t('Reconnect now'), () => store.reconnectNow()));
    }
  };
  store.on('snapshot', renderCounts);
  store.on('connection', renderConn);
  renderCounts();
  renderConn(store.connection);
  // ?stats=1: frame rate and draw calls, to check the performance budget on a real GPU
  if (new URLSearchParams(location.search).has('stats')) {
    const perf = el('span', 'ui-conn');
    conn.after(perf);
    setInterval(() => {
      const st = world.stats();
      perf.textContent = t('{0} fps · {1} ms CPU · {2} draw calls · {3} agents', [st.fps, st.cpuMs, st.calls, st.agents]);
    }, 1000);
  }
  return root;
}

export function createFeed(store: OfficeStore, world: WorldApi): HTMLElement {
  const root = el('section', 'ui-feed');
  root.setAttribute('aria-label', t('Activity feed'));
  const head = el('div', 'ui-feed-head', t('Activity'));
  const body = el('div', 'ui-feed-body');
  root.append(head, body);
  let collapsed = innerWidth < 760;
  root.classList.toggle('collapsed', collapsed);
  head.addEventListener('click', () => {
    collapsed = !collapsed;
    root.classList.toggle('collapsed', collapsed);
  });
  const render = () => {
    const now = Date.now();
    const items = store.feed.slice(-40).reverse();
    body.replaceChildren(
      ...(items.length
        ? items.map((f) => {
            const row = el('div', 'ui-feed-item');
            row.title = `${f.agentName} · ${f.roomName}\n${f.activity.detail ?? f.activity.text}`;
            row.append(el('span', '', f.activity.icon), el('span', '', `${f.agentName}: ${f.activity.text}`), el('time', '', ago(now - f.activity.at)));
            row.addEventListener('click', () => world.select({ type: 'agent', id: f.agentId }, { focus: true }));
            return row;
          })
        : [el('div', 'ui-empty', t('Nothing yet.'))]),
    );
  };
  store.on('feed', render);
  setInterval(render, 15_000);
  render();
  return root;
}

const LEVEL_COLORS: Record<NoticeLevel, string> = { info: '#3b7bd8', success: '#2e9d4f', warn: '#e0861f', alert: '#d9534f' };

export function createToasts(store: OfficeStore, world: WorldApi): HTMLElement {
  const root = el('div', 'ui-toasts');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  store.on('notice', (n) => {
    const toast = el('div', 'ui-toast', n.text);
    toast.style.setProperty('--c', LEVEL_COLORS[n.level]);
    const close = () => toast.remove();
    toast.addEventListener('click', () => {
      if (n.agentId) world.select({ type: 'agent', id: n.agentId }, { focus: true });
      close();
    });
    root.prepend(toast);
    while (root.children.length > 4) root.lastElementChild?.remove();
    setTimeout(close, n.level === 'alert' ? 15_000 : 7_000);
  });
  store.on('update', () => {
    const toast = el('div', 'ui-toast', t('A newer version of the page is available. Click to reload.'));
    toast.addEventListener('click', () => location.reload());
    root.prepend(toast);
  });
  return root;
}

export function createHoverTip(store: OfficeStore, world: WorldApi): HTMLElement {
  const tip = el('div', 'ui-tip');
  tip.hidden = true;
  world.onHover((hit) => {
    const a = hit ? store.agent(hit.id) : undefined;
    if (!hit || !a) {
      tip.hidden = true;
      return;
    }
    const line = a.status === 'waiting' ? `✋ ${a.waitingFor ?? t('needs you')}` : a.activity ? `${a.activity.icon} ${a.activity.text}` : statusLabel(a.status);
    tip.replaceChildren(el('b', '', `${a.name} · ${statusLabel(a.status)}`), line);
    const r = (document.getElementById('world') as HTMLElement).getBoundingClientRect();
    tip.style.left = `${hit.x + r.left}px`;
    tip.style.top = `${hit.y + r.top}px`;
    tip.hidden = false;
  });
  return tip;
}
