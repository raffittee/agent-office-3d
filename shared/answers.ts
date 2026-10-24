// Ported from habblaud shared/answers.ts (MIT, © 2026 Márcio Junior)
// Answers to ask-the-user questions from the office (the `answer` decision of POST /api/permissions/:id/decision):
// checked against the request's questions, plus the summary for the timeline. Pure: used by the server
// (server/permissions/registry.ts) and the page (the answer card).
import { maskSecrets, truncate } from './activity';
import { t } from './i18n';
import type { AskQuestion, PermissionAnswer } from './protocol';

/** Longest free text ("Other") accepted in an answer. */
export const ANSWER_OTHER_MAX = 2_000;
/** Claude Code's ask-the-user tool. */
export const ASK_TOOL = 'AskUserQuestion';

const SUMMARY_MAX = 300;

/**
 * Checks the answers against the request's questions and returns them normalized (in question order, options
 * ascending, free text trimmed, no empty fields). undefined = they don't fit: a question unanswered or answered twice,
 * a question or option the request doesn't have, without multiSelect anything other than exactly one option OR the
 * free text, with multiSelect no choice at all.
 */
export function checkAnswers(questions: readonly AskQuestion[], answers: readonly PermissionAnswer[] | undefined): PermissionAnswer[] | undefined {
  if (!questions.length || !Array.isArray(answers) || answers.length !== questions.length) return undefined;
  const byQuestion = new Map<number, PermissionAnswer>();
  for (const a of answers) {
    if (!a || typeof a !== 'object' || byQuestion.has(a.question)) return undefined;
    byQuestion.set(a.question, a);
  }
  const out: PermissionAnswer[] = [];
  for (const q of questions) {
    const a = byQuestion.get(q.index);
    if (!a) return undefined;
    const raw = Array.isArray(a.options) ? a.options : [];
    const options = [...new Set(raw)].sort((x, y) => x - y);
    if (options.length !== raw.length || options.some((i) => !q.options.some((o) => o.index === i))) return undefined;
    const other = typeof a.other === 'string' ? a.other.trim() : '';
    if (other.length > ANSWER_OTHER_MAX) return undefined;
    const picks = options.length + (other ? 1 : 0);
    if (q.multiSelect ? picks < 1 : picks !== 1) return undefined;
    out.push({ question: q.index, ...(options.length ? { options } : {}), ...(other ? { other } : {}) });
  }
  return out;
}

/** A short summary of the choices for the timeline, free text masked: "Database: Redis · Tests: Unit, E2E". */
export function answerSummary(questions: readonly AskQuestion[], answers: readonly PermissionAnswer[]): string {
  const parts = answers.flatMap((a) => {
    const q = questions.find((x) => x.index === a.question);
    if (!q) return [];
    const labels = (a.options ?? []).map((i) => q.options.find((o) => o.index === i)?.label ?? t('option {0}', [i + 1]));
    if (a.other) labels.push(`“${truncate(maskSecrets(a.other.slice(0, ANSWER_OTHER_MAX)), 80)}”`);
    return [`${q.header ?? truncate(q.question, 40)}: ${labels.join(', ')}`];
  });
  return truncate(parts.join(' · '), SUMMARY_MAX);
}
