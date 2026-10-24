// Request cards (P7-01/P7-02): which requests show, and the question form's answers.
import { describe, expect, it } from 'vitest';
import type { AgentInfo, AskQuestion, OfficeSnapshot } from '../../../shared/protocol';
import { formAnswers, pendingRequests, suggestionLabel } from './requests';

const Q: AskQuestion[] = [
  { index: 0, question: 'DB?', options: [{ index: 0, label: 'Postgres' }, { index: 1, label: 'SQLite' }] },
  { index: 1, question: 'Tests?', multiSelect: true, options: [{ index: 0, label: 'Unit' }, { index: 1, label: 'E2E' }] },
];

const snap = (interactive: boolean, agents: Partial<AgentInfo>[]) => ({ meta: { interactive }, agents }) as unknown as OfficeSnapshot;
const req = (id: string, createdAt: number) => ({ id, provider: 'claude-code', tool: 'Bash', title: 'Bash(ls)', text: 'x', icon: '⌨️', createdAt, expiresAt: createdAt + 1 }) as const;

describe('request cards', () => {
  it('only with the interactive features on, oldest first', () => {
    const agents = [{ id: 'a', permission: req('p2', 20) }, { id: 'b' }, { id: 'c', permission: req('p1', 10) }];
    expect(pendingRequests(snap(false, agents))).toEqual([]);
    expect(pendingRequests(snap(true, agents)).map((r) => r.request.id)).toEqual(['p1', 'p2']);
    expect(pendingRequests(null)).toEqual([]);
  });

  it('the form gives answers only once every question has a valid choice', () => {
    const picks = new Map<number, Set<number>>([[0, new Set([1])]]);
    const others = new Map<number, string>();
    expect(formAnswers(Q, picks, others)).toBeNull();
    picks.set(1, new Set([1, 0]));
    expect(formAnswers(Q, picks, others)).toEqual([{ question: 0, options: [1] }, { question: 1, options: [0, 1] }]);
    others.set(0, 'MySQL');
    expect(formAnswers(Q, picks, others)).toBeNull();
    picks.set(0, new Set());
    expect(formAnswers(Q, picks, others)).toEqual([{ question: 0, other: 'MySQL' }, { question: 1, options: [0, 1] }]);
  });

  it('labels the rule suggestions', () => {
    expect(suggestionLabel(['Bash(npm test:*)'], 'localSettings')).toBe('Always allow Bash(npm test:*) (this project, just you)');
  });
});
