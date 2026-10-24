// Answering from the office (P7-01, P7-02): a card for every pending permission request or question, bottom right.
// Approve, approve with an "always allow" rule the CLI offered, deny (with an optional reason), or hand it back to the
// terminal; questions get their options and an "Other" field. Shown only when the server's interactive features are on.
import { checkAnswers } from '../../../shared/answers';
import { t } from '../../../shared/i18n';
import type { AgentInfo, AskQuestion, OfficeSnapshot, PermissionAnswer, PermissionDecision, PermissionRequestInfo } from '../../../shared/protocol';
import type { OfficeStore } from '../net/store';
import type { WorldApi } from '../render3d/world';
import { button, el } from './dom';

export interface PendingRequest {
  agent: AgentInfo;
  request: PermissionRequestInfo;
}

/** The agents' pending requests, oldest first (none unless the interactive features are on). */
export function pendingRequests(snap: OfficeSnapshot | null): PendingRequest[] {
  if (!snap?.meta.interactive) return [];
  return snap.agents
    .filter((a): a is AgentInfo & { permission: PermissionRequestInfo } => !!a.permission)
    .map((a) => ({ agent: a, request: a.permission }))
    .sort((x, y) => x.request.createdAt - y.request.createdAt);
}

/** The answers a question form holds, checked like the server does; null while something is missing. */
export function formAnswers(questions: readonly AskQuestion[], picks: ReadonlyMap<number, ReadonlySet<number>>, others: ReadonlyMap<number, string>): PermissionAnswer[] | null {
  const answers = questions.map((q) => {
    const options = [...(picks.get(q.index) ?? [])];
    const other = others.get(q.index)?.trim() ?? '';
    return { question: q.index, ...(options.length ? { options } : {}), ...(other ? { other } : {}) };
  });
  return checkAnswers(questions, answers) ?? null;
}

/** "Always allow" button text: the rules and where they're kept. */
export function suggestionLabel(rules: readonly string[], destination: string): string {
  const where: Record<string, string> = { session: t('this session'), localSettings: t('this project, just you'), projectSettings: t('this project'), userSettings: t('everywhere') };
  return t('Always allow {0} ({1})', [rules.join(', '), where[destination] ?? destination]);
}

async function send(id: string, d: PermissionDecision): Promise<string | null> {
  try {
    const res = await fetch(`/api/permissions/${encodeURIComponent(id)}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? t('Could not send ({0})', [res.status]);
  } catch {
    return t('Agent Office is unreachable');
  }
}

function questionForm(req: PermissionRequestInfo, onChange: (answers: PermissionAnswer[] | null) => void): HTMLElement {
  const form = el('div', 'ui-req-questions');
  const picks = new Map<number, Set<number>>();
  const others = new Map<number, string>();
  const update = () => onChange(formAnswers(req.questions ?? [], picks, others));
  for (const q of req.questions ?? []) {
    const box = el('fieldset', 'ui-req-q');
    box.append(el('legend', '', q.header ? `${q.header} · ${q.question}` : q.question));
    const name = `${req.id}-q${q.index}`;
    for (const o of q.options) {
      const row = el('label', 'ui-req-opt');
      const input = el('input');
      input.type = q.multiSelect ? 'checkbox' : 'radio';
      input.name = name;
      input.addEventListener('change', () => {
        const set = q.multiSelect ? (picks.get(q.index) ?? new Set<number>()) : new Set<number>();
        if (input.checked) set.add(o.index);
        else set.delete(o.index);
        picks.set(q.index, set);
        // single choice: an option clears the "Other" text
        if (!q.multiSelect) {
          others.delete(q.index);
          other.value = '';
        }
        update();
      });
      row.append(input, el('span', '', o.label));
      if (o.description) row.title = o.description;
      box.append(row);
    }
    const other = el('input', 'ui-req-other');
    other.placeholder = t('Other…');
    other.maxLength = 2_000;
    other.addEventListener('input', () => {
      others.set(q.index, other.value);
      if (!q.multiSelect && other.value.trim()) {
        picks.set(q.index, new Set());
        for (const r of box.querySelectorAll<HTMLInputElement>('input[type=radio]')) r.checked = false;
      }
      update();
    });
    box.append(other);
    form.append(box);
  }
  return form;
}

function card(item: PendingRequest, world: WorldApi): HTMLElement {
  const { agent, request: req } = item;
  const root = el('article', 'ui-req');
  root.setAttribute('aria-label', t('Request from {0}', [agent.name]));
  const head = el('header', 'ui-req-head');
  const who = el('button', 'ui-req-who', `${req.icon} ${agent.name}${req.subagent ? ` · ${req.subagent}` : ''}`);
  who.type = 'button';
  who.title = t('Show this agent');
  who.addEventListener('click', () => world.select({ type: 'agent', id: agent.id }, { focus: true }));
  head.append(who, el('span', 'ui-req-what', req.questions?.length ? t('has a question') : t('asks permission')));
  // how many more wait behind this one (refreshed by the list on every snapshot)
  head.append(el('span', 'ui-req-queued', req.queued ? t('+{0} more', [req.queued]) : ''));
  root.append(head);
  const status = el('p', 'ui-req-status');
  status.hidden = true;
  const actions = el('div', 'ui-req-actions');
  const all: HTMLButtonElement[] = [];
  const act = (d: PermissionDecision) => async () => {
    for (const b of all) b.disabled = true;
    const err = await send(req.id, d);
    if (err) {
      status.textContent = err;
      status.hidden = false;
      for (const b of all) b.disabled = false;
    } else {
      status.textContent = t('Sent.');
      status.hidden = false;
    }
  };
  const add = (b: HTMLButtonElement) => {
    all.push(b);
    actions.append(b);
    return b;
  };

  if (req.questions?.length) {
    let answers: PermissionAnswer[] | null = null;
    const sendBtn = button(t('Send answer'), t('Answer the question from the office'), () => answers && void act({ behavior: 'answer', answers })(), 'ui-btn on');
    sendBtn.disabled = true;
    root.append(
      questionForm(req, (a) => {
        answers = a;
        sendBtn.disabled = !a;
      }),
    );
    add(sendBtn);
  } else {
    root.append(el('div', 'ui-req-title', req.title), el('p', 'ui-req-text', req.text));
    const details = el('details', 'ui-req-details');
    const summary = el('summary', '', t('Arguments'));
    const pre = el('pre');
    details.append(summary, pre);
    details.addEventListener('toggle', () => {
      if (!details.open || pre.textContent) return;
      pre.textContent = t('Loading…');
      fetch(`/api/permissions/${encodeURIComponent(req.id)}`)
        .then((r) => (r.ok ? (r.json() as Promise<PermissionRequestInfo>) : null))
        .then((d) => (pre.textContent = d?.input ?? t('No arguments.')))
        .catch(() => (pre.textContent = t('Could not load the arguments.')));
    });
    root.append(details);
    add(button(t('Allow'), t('Approve this once'), () => void act({ behavior: 'allow' })(), 'ui-btn on'));
    for (const s of req.suggestions ?? []) add(button(suggestionLabel(s.rules, s.destination), t('Approve, and add this rule to Claude Code’s permissions'), () => void act({ behavior: 'allow', suggestion: s.index })()));
  }
  const reason = el('input', 'ui-req-reason');
  reason.placeholder = t('Reason (optional, the agent sees it)');
  reason.maxLength = 1_000;
  add(button(t('Deny'), t('Deny, telling the agent why (optional)'), () => void act({ behavior: 'deny', ...(reason.value.trim() ? { message: reason.value.trim() } : {}) })()));
  add(button(t('Answer in the terminal'), t('Leave this request to the terminal'), () => void act({ behavior: 'terminal' })(), 'ui-btn ui-req-terminal'));
  root.append(reason, actions, status);
  return root;
}

export function createRequests(store: OfficeStore, world: WorldApi): HTMLElement {
  const root = el('section', 'ui-requests');
  root.setAttribute('aria-label', t('Requests waiting for you'));
  root.setAttribute('aria-live', 'polite');
  // cards are kept while their request is pending, so a half-filled form survives new snapshots
  const cards = new Map<string, HTMLElement>();
  const render = (snap: OfficeSnapshot | null) => {
    const items = pendingRequests(snap);
    const seen = new Set<string>();
    for (const item of items) {
      seen.add(item.request.id);
      const existing = cards.get(item.request.id);
      if (!existing) cards.set(item.request.id, card(item, world));
      else {
        const q = existing.querySelector('.ui-req-queued');
        const text = item.request.queued ? t('+{0} more', [item.request.queued]) : '';
        if (q && q.textContent !== text) q.textContent = text;
      }
    }
    for (const [id, c] of cards) {
      if (seen.has(id)) continue;
      c.remove();
      cards.delete(id);
    }
    // re-attach only when the list changed (moving a node would take the focus from a field being typed in)
    const want = items.map((i) => cards.get(i.request.id)!);
    if (want.length !== root.children.length || want.some((c, i) => root.children[i] !== c)) root.replaceChildren(...want);
    root.hidden = !items.length;
  };
  store.on('snapshot', render);
  render(store.snapshot);
  return root;
}
