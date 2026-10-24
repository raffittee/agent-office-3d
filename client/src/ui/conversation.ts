// The read-only conversation view (P7-05): what an agent and you said, its thinking, tool calls and results, rebuilt
// by the server from the provider's transcript (masked and cut there). Opened from the details drawer (live: it
// refreshes while open) or from the session history in the top bar. Only with the interactive features on.
import { t } from '../../../shared/i18n';
import type { ConversationEntry, ConversationPage, RecentSession } from '../../../shared/protocol';
import { modal } from './dialogs';
import { button, el } from './dom';
import { ago } from './model';

/** How often an open live view refreshes. */
const REFRESH_MS = 2_500;
/** Results longer than this start folded. */
const FOLD_LINES = 6;

/** A result's first line and how many lines it has (for the folded summary). */
export function resultSummary(text: string): { first: string; lines: number } {
  const lines = text.split('\n');
  return { first: lines[0] ?? '', lines: lines.length };
}

/** The tool entry's id → its result, so a result renders under its call. */
export function resultsByTool(entries: readonly ConversationEntry[]): Map<string, Extract<ConversationEntry, { kind: 'result' }>> {
  const out = new Map<string, Extract<ConversationEntry, { kind: 'result' }>>();
  for (const e of entries) if (e.kind === 'result') out.set(e.toolId, e);
  return out;
}

function pre(text: string, cls = ''): HTMLElement {
  const p = el('pre', cls);
  p.textContent = text;
  return p;
}

function resultEl(r: Extract<ConversationEntry, { kind: 'result' }>): HTMLElement {
  const wrap = el('div', `ui-conv-result${r.error ? ' err' : ''}`);
  const s = resultSummary(r.text);
  if (s.lines <= FOLD_LINES) {
    wrap.append(pre(r.text || t('(no output)')));
    return wrap;
  }
  const d = el('details');
  d.append(el('summary', '', t('{0} … ({1} lines)', [s.first, s.lines])), pre(r.text));
  wrap.append(d);
  return wrap;
}

/** The entries as DOM rows (results under their tool calls). */
export function renderEntries(entries: readonly ConversationEntry[]): HTMLElement[] {
  const results = resultsByTool(entries);
  const rows: HTMLElement[] = [];
  for (const e of entries) {
    switch (e.kind) {
      case 'user': {
        const row = el('div', 'ui-conv-user');
        row.append(el('span', 'ui-conv-who', '›'), pre(e.text));
        rows.push(row);
        break;
      }
      case 'assistant':
        rows.push(pre(e.text, 'ui-conv-assistant'));
        break;
      case 'thinking': {
        if (!e.text) {
          rows.push(el('div', 'ui-conv-thinking', t('✻ Thinking…')));
          break;
        }
        const d = el('details', 'ui-conv-thinking');
        d.append(el('summary', '', t('✻ Thinking')), pre(e.text));
        rows.push(d);
        break;
      }
      case 'tool': {
        const row = el('div', 'ui-conv-tool');
        const head = el('div', 'ui-conv-title', `● ${e.title}`);
        row.append(head);
        if (e.input && e.input !== e.title) {
          const d = el('details');
          d.append(el('summary', '', t('Arguments')), pre(e.input));
          row.append(d);
        }
        const r = results.get(e.id);
        if (r) row.append(resultEl(r));
        rows.push(row);
        break;
      }
      case 'result':
        // shown under its tool call; an orphan (its call fell before the window) shows alone
        if (!entries.some((x) => x.kind === 'tool' && x.id === e.toolId)) rows.push(resultEl(e));
        break;
      case 'system':
        rows.push(el('div', `ui-conv-system ${e.level ?? 'info'}`, e.text));
        break;
    }
  }
  return rows;
}

/** Opens a conversation (`live` refreshes it while open). Returns the close function. */
export function openConversation(root: HTMLElement, title: string, url: string, live: boolean): () => void {
  const body = el('div', 'ui-conv');
  body.append(el('p', 'ui-empty', t('Loading…')));
  const note = el('p', 'ui-conv-note');
  let timer = 0;
  let closed = false;
  const load = async () => {
    try {
      const res = await fetch(url);
      const data = (await res.json()) as ConversationPage & { error?: string };
      if (closed) return;
      if (!res.ok) {
        body.replaceChildren(el('p', 'ui-empty', data.error ?? t('Could not load the conversation.')));
        return;
      }
      // stay at the bottom when already there (following a live session)
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      body.replaceChildren(...(data.entries.length ? renderEntries(data.entries) : [el('p', 'ui-empty', t('Nothing yet.'))]));
      note.textContent = data.truncated ? t('Older parts of the conversation are not shown.') : '';
      if (atBottom) body.scrollTop = body.scrollHeight;
    } catch {
      if (!closed) body.replaceChildren(el('p', 'ui-empty', t('Agent Office is unreachable')));
    }
  };
  const close = () => {
    closed = true;
    window.clearInterval(timer);
    back.remove();
  };
  const back = modal(title, [note, body], close);
  back.querySelector('.ui-modal')?.classList.add('wide');
  root.append(back);
  void load().then(() => {
    body.scrollTop = body.scrollHeight;
  });
  if (live) timer = window.setInterval(() => void load(), REFRESH_MS);
  return close;
}

/** The session history: recent sessions, open or ended; each opens its conversation. */
export function openHistory(root: HTMLElement): () => void {
  const list = el('ul', 'ui-history');
  list.append(el('li', 'ui-empty', t('Loading…')));
  let inner: (() => void) | null = null;
  const close = () => {
    inner?.();
    back.remove();
  };
  const back = modal(t('Session history'), [list], close);
  back.querySelector('.ui-modal')?.classList.add('wide');
  root.append(back);
  void fetch('/api/sessions')
    .then(async (res) => {
      const data = (await res.json()) as RecentSession[] | { error?: string };
      if (!res.ok || !Array.isArray(data)) {
        list.replaceChildren(el('li', 'ui-empty', (data as { error?: string }).error ?? t('Could not load the history.')));
        return;
      }
      if (!data.length) return list.replaceChildren(el('li', 'ui-empty', t('No sessions found.')));
      const now = Date.now();
      list.replaceChildren(
        ...data.map((s) => {
          const li = el('li');
          const open = button(`${s.project ?? s.sessionId.slice(0, 8)}`, t('Show this conversation'), () => {
            inner = openConversation(root, `${s.project ?? s.sessionId.slice(0, 8)} · ${s.provider}`, `/api/sessions/${s.key}/conversation`, false);
          }, 'ui-history-open');
          li.append(open, el('span', 'ui-history-meta', `${s.provider} · ${s.account}${s.open ? ` · ${t('open')}` : ''}`), el('time', '', ago(now - s.lastAt)));
          return li;
        }),
      );
    })
    .catch(() => list.replaceChildren(el('li', 'ui-empty', t('Agent Office is unreachable'))));
  return close;
}
