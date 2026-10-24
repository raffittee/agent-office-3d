// The details drawer (P2-09): the selected agent's current activity, tasks, subagents, timeline, stats, model and
// provider; or the selected room's agents.
import { t } from '../../../shared/i18n';
import type { Activity, AgentInfo, OfficeSnapshot } from '../../../shared/protocol';
import type { OfficeStore } from '../net/store';
import type { Selection, WorldApi } from '../render3d/world';
import { createCompose } from './compose';
import { openConversation } from './conversation';
import { badge, button, el } from './dom';
import { ago, compact, providerMeta, STATUS_COLORS, statusLabel } from './model';

export interface Drawer {
  el: HTMLElement;
  width(): number;
}

function section(title: string): HTMLElement {
  return el('h3', '', title);
}

function agentRow(a: AgentInfo, onClick: () => void): HTMLLIElement {
  const li = el('li', 'link');
  const dot = el('span', '', '●');
  dot.style.color = STATUS_COLORS[a.status];
  li.append(dot, el('span', '', `${a.name} · ${a.role}`), el('time', '', statusLabel(a.status)));
  li.addEventListener('click', onClick);
  return li;
}

export function createDrawer(store: OfficeStore, world: WorldApi, dialog: (open: () => () => void) => void = (open) => void open()): Drawer {
  const root = el('aside', 'ui-drawer');
  root.hidden = true;
  root.setAttribute('aria-label', t('Details'));
  // the re-rendered part, and the message box under it (kept, so a draft survives new snapshots)
  const content = el('div', 'ui-drawer-content');
  const compose = createCompose();
  root.append(content, compose.el);
  let history: { id: string; items: Activity[]; key: number } | null = null;
  let fetchedAt = 0;

  const renderAgent = (snap: OfficeSnapshot, a: AgentInfo) => {
    const meta = providerMeta(snap, a.provider);
    const now = snap.serverTime + (Date.now() - receivedAt);
    const parts: HTMLElement[] = [];
    parts.push(el('h2', '', a.name));
    const m = el('div', 'meta');
    const st = badge(statusLabel(a.status), STATUS_COLORS[a.status]);
    m.append(badge(meta.label, meta.color), st, el('span', '', a.role));
    if (a.model) m.append(el('span', '', a.model));
    parts.push(m);
    if (a.title) parts.push(el('div', 'meta', a.title));
    // the read-only conversation (P7-05), live while open
    if (snap.meta.interactive && meta.capabilities?.transcript) {
      const host = root.parentElement ?? document.body;
      parts.push(button(t('💬 Conversation'), t('Read this agent’s conversation (read-only)'), () => dialog(() => openConversation(host, `${a.name} · ${meta.label}`, `/api/conversation/${encodeURIComponent(a.id)}`, true)), 'ui-btn ui-conv-btn'));
    }
    const room = store.room(a.roomId);
    if (room) {
      const r = el('div', 'meta');
      const link = el('a', '', `📁 ${room.name}`);
      link.href = '#';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        world.select({ type: 'room', id: room.id }, { focus: true });
      });
      r.append(link);
      if (a.gitBranch) r.append(el('span', '', `⎇ ${a.gitBranch}`));
      parts.push(r);
    }

    parts.push(section(t('Now')));
    const now$ = el('div', `now${a.status === 'waiting' ? ' alert' : ''}`);
    now$.textContent = a.status === 'waiting' ? `✋ ${a.waitingFor ?? t('needs you')}` : a.activity ? `${a.activity.icon} ${a.activity.text}` : statusLabel(a.status);
    if (a.activity?.detail && a.status !== 'waiting') now$.title = a.activity.detail;
    parts.push(now$);
    if (a.jobs?.length) {
      const ul = el('ul');
      for (const j of a.jobs) {
        const li = el('li');
        li.append(el('span', '', `⏳ ${j.label}`), el('time', '', ago(now - j.startedAt)));
        ul.append(li);
      }
      parts.push(ul);
    }

    if (a.tasks.length) {
      parts.push(section(t('Tasks')));
      const ul = el('ul');
      for (const task of a.tasks) {
        const icon = task.status === 'completed' ? '☑' : task.status === 'in_progress' ? '▶' : '☐';
        ul.append(el('li', '', `${icon} ${task.status === 'in_progress' && task.activeForm ? task.activeForm : task.title}`));
      }
      parts.push(ul);
    }

    const subs = snap.agents.filter((x) => x.parentId === a.id && x.status !== 'offline');
    const parent = a.parentId ? snap.agents.find((x) => x.id === a.parentId) : undefined;
    if (subs.length || parent) {
      parts.push(section(parent ? t('Started by') : t('Subagents')));
      const ul = el('ul');
      for (const x of parent ? [parent] : subs) ul.append(agentRow(x, () => world.select({ type: 'agent', id: x.id }, { focus: true })));
      parts.push(ul);
    }

    parts.push(section(t('Stats')));
    const stats = el('div', 'ui-stats');
    const stat = (label: string, value: string) => {
      const d = el('div');
      d.append(el('b', '', value), label);
      stats.append(d);
    };
    stat(t('tool calls'), compact(a.stats.toolCalls));
    stat(t('subagents'), compact(a.stats.subagents));
    stat(t('tokens in'), compact(a.stats.tokensIn));
    stat(t('tokens out'), compact(a.stats.tokensOut));
    stat(t('started'), ago(now - a.startedAt));
    stat(t('last event'), ago(now - a.lastEventAt));
    parts.push(stats);

    parts.push(section(t('Timeline')));
    const ul = el('ul');
    const items = history?.id === a.id ? history.items : a.recent;
    for (const act of [...items].reverse().slice(0, 60)) {
      const li = el('li', act.error ? 'err' : '');
      li.title = act.detail ?? '';
      li.append(el('span', '', act.icon), el('span', '', act.text), el('time', '', ago(now - act.at)));
      ul.append(li);
    }
    if (!items.length) ul.append(el('li', '', t('Nothing yet.')));
    parts.push(ul);
    // the long history comes from the server, refreshed when the agent changes
    // (only when this agent had new events, at most every 2 s)
    if ((history?.id !== a.id || history.key !== a.lastEventAt) && Date.now() - fetchedAt > 2000) {
      const key = a.lastEventAt;
      fetchedAt = Date.now();
      void store.agentHistory(a.id).then((list) => {
        const sel = world.getSelection();
        if (sel?.type === 'agent' && sel.id === a.id) {
          history = { id: a.id, items: list, key };
          schedule();
        }
      });
      history = history?.id === a.id ? { ...history, key } : { id: a.id, items: a.recent, key };
    }
    return parts;
  };

  const renderRoom = (snap: OfficeSnapshot, id: string) => {
    const room = store.room(id);
    if (!room) return null;
    const agents = snap.agents.filter((a) => a.roomId === id && a.status !== 'offline');
    const parts: HTMLElement[] = [el('h2', '', room.name), el('div', 'meta', room.path), section(t('Agents'))];
    const ul = el('ul');
    for (const a of agents) ul.append(agentRow(a, () => world.select({ type: 'agent', id: a.id }, { focus: true })));
    if (!agents.length) ul.append(el('li', '', t('Nobody here right now.')));
    parts.push(ul);
    return parts;
  };

  let receivedAt = Date.now();
  const render = () => {
    const sel: Selection = world.getSelection();
    const snap = store.snapshot;
    let parts: HTMLElement[] | null = null;
    if (snap && sel?.type === 'agent') {
      const a = store.agent(sel.id);
      parts = a ? renderAgent(snap, a) : null;
    } else if (snap && sel?.type === 'room') parts = renderRoom(snap, sel.id);
    root.hidden = !parts;
    compose.update(sel?.type === 'agent' && parts ? (store.agent(sel.id) ?? null) : null);
    if (!parts) return;
    const close = button('✕', t('Close (Esc)'), () => world.select(null), 'ui-btn close');
    content.replaceChildren(close, ...parts);
  };
  let timer = 0;
  const schedule = () => {
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      render();
    }, 120);
  };
  store.on('snapshot', () => {
    receivedAt = Date.now();
    if (!root.hidden) schedule();
  });
  world.onSelect(() => {
    history = null;
    fetchedAt = 0;
    render();
  });
  render();
  return { el: root, width: () => (root.hidden ? 0 : root.getBoundingClientRect().width + 20) };
}
