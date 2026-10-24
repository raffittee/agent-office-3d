// Messages from the office (P7-04): the box at the bottom of the details drawer that sends text to the selected
// agent's session, as if typed in its terminal. It lives outside the drawer's re-rendered part, so a half-typed
// message survives new snapshots. Shown only for agents that can receive messages (AgentInfo.canMessage).
import { MESSAGE_MAX } from '../../../shared/messages';
import { t } from '../../../shared/i18n';
import type { AgentInfo, OutboxMessage } from '../../../shared/protocol';
import { button, el } from './dom';

/** How a message's status reads under the box. */
export function statusText(m: Pick<OutboxMessage, 'status' | 'error'>): string {
  switch (m.status) {
    case 'queued':
      return t('Waiting for the session to pick it up…');
    case 'sent':
      return t('Handed to the session…');
    case 'delivered':
      return t('Delivered ✓');
    case 'failed':
      return t('Not delivered: {0}', [m.error ?? t('unknown error')]);
  }
}

export interface Compose {
  el: HTMLElement;
  /** The selected agent (or null): shows or hides the box and keeps a draft per agent. */
  update(agent: AgentInfo | null): void;
}

export function createCompose(): Compose {
  const root = el('form', 'ui-compose');
  root.hidden = true;
  const label = el('label', 'ui-compose-label', t('Message'));
  const box = el('textarea');
  box.rows = 2;
  box.maxLength = MESSAGE_MAX;
  box.placeholder = t('Type a message for this agent (Ctrl+Enter sends)');
  label.htmlFor = box.id = 'ui-compose-text';
  const status = el('p', 'ui-compose-status');
  status.setAttribute('aria-live', 'polite');
  const send = button(t('Send'), t('Send to the agent’s session, as if typed in its terminal'), () => void submit(), 'ui-btn on');
  send.type = 'submit';
  const row = el('div', 'ui-compose-row');
  row.append(status, send);
  root.append(label, box, row);

  let agentId: string | null = null;
  const drafts = new Map<string, string>();
  let poll = 0;

  const watch = (id: string) => {
    window.clearInterval(poll);
    let tries = 0;
    poll = window.setInterval(async () => {
      if (++tries > 60) return window.clearInterval(poll);
      try {
        const res = await fetch(`/api/messages/${encodeURIComponent(id)}`);
        if (!res.ok) return window.clearInterval(poll);
        const m = (await res.json()) as OutboxMessage;
        status.textContent = statusText(m);
        if (m.status === 'delivered' || m.status === 'failed') window.clearInterval(poll);
      } catch {
        window.clearInterval(poll);
      }
    }, 1_000);
  };

  const submit = async () => {
    const text = box.value;
    if (!agentId || !text.trim()) return;
    send.disabled = true;
    status.textContent = t('Sending…');
    try {
      const res = await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, text }) });
      const body = (await res.json().catch(() => ({}))) as OutboxMessage & { error?: string };
      if (res.ok) {
        box.value = '';
        drafts.delete(agentId);
        status.textContent = statusText(body);
        watch(body.id);
      } else status.textContent = body.error ?? t('Could not send ({0})', [res.status]);
    } catch {
      status.textContent = t('Agent Office is unreachable');
    } finally {
      send.disabled = false;
    }
  };

  root.addEventListener('submit', (e) => {
    e.preventDefault();
    void submit();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
    // keep the office's shortcuts (N, B, /…) out of the text
    e.stopPropagation();
  });
  box.addEventListener('input', () => {
    if (agentId) drafts.set(agentId, box.value);
  });

  return {
    el: root,
    update(agent) {
      const id = agent?.canMessage ? agent.id : null;
      root.hidden = !id;
      if (id === agentId) return;
      agentId = id;
      box.value = id ? (drafts.get(id) ?? '') : '';
      status.textContent = '';
      window.clearInterval(poll);
    },
  };
}
