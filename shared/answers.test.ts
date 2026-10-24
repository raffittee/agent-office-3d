// Ported from habblaud shared/answers.test.ts (MIT, © 2026 Márcio Junior)
// Ask-the-user answers from the office: checked against the questions (by position), and the summary.
import { describe, expect, it } from 'vitest';
import { answerSummary, checkAnswers } from './answers';
import type { AskQuestion } from './protocol';

// Original positions: question 1 was invalid (skipped), and so was option 1 of the first.
const QS: AskQuestion[] = [
  { index: 0, header: 'Database', question: 'Which database?', options: [{ index: 0, label: 'Postgres' }, { index: 2, label: 'SQLite' }] },
  { index: 2, question: 'Which tests before the commit?', multiSelect: true, options: [{ index: 0, label: 'Unit' }, { index: 1, label: 'E2E' }] },
];

describe('checkAnswers', () => {
  it('normalizes: question order, options ascending, text trimmed, no empty fields', () => {
    expect(checkAnswers(QS, [{ question: 2, options: [1, 0], other: '  lint  ' }, { question: 0, options: [2], other: '   ' }])).toEqual([
      { question: 0, options: [2] },
      { question: 2, options: [0, 1], other: 'lint' },
    ]);
    // Without multiSelect the free text replaces an option; with multiSelect it may stand alone too.
    expect(checkAnswers(QS, [{ question: 0, other: 'MySQL' }, { question: 2, other: 'none' }])).toEqual([
      { question: 0, other: 'MySQL' },
      { question: 2, other: 'none' },
    ]);
  });

  it('each question exactly once', () => {
    expect(checkAnswers(QS, [{ question: 0, options: [0] }])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [0] }, { question: 0, options: [2] }])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [0] }, { question: 1, options: [0] }])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [0] }, { question: 2, options: [0] }, { question: 2, options: [1] }])).toBeUndefined();
    expect(checkAnswers(QS, undefined)).toBeUndefined();
    expect(checkAnswers([], [])).toBeUndefined();
  });

  it('single choice: exactly one option OR the free text', () => {
    const multi = { question: 2, options: [0] };
    expect(checkAnswers(QS, [{ question: 0, options: [0, 2] }, multi])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [0], other: 'and more' }, multi])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0 }, multi])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [] }, multi])).toBeUndefined();
  });

  it('multiple: at least one choice; options the question lacks, or repeated, are refused', () => {
    const single = { question: 0, options: [0] };
    expect(checkAnswers(QS, [single, { question: 2 }])).toBeUndefined();
    expect(checkAnswers(QS, [{ question: 0, options: [1] }, { question: 2, options: [0] }])).toBeUndefined();
    expect(checkAnswers(QS, [single, { question: 2, options: [0, 0] }])).toBeUndefined();
    expect(checkAnswers(QS, [single, { question: 2, options: [5] }])).toBeUndefined();
    expect(checkAnswers(QS, [single, { question: 2, other: 'x'.repeat(2_001) }])).toBeUndefined();
  });
});

describe('answerSummary', () => {
  it('header (or the question) and the chosen labels; free text quoted and masked', () => {
    expect(answerSummary(QS, [{ question: 0, options: [2] }, { question: 2, options: [0, 1], other: 'go ahead' }])).toBe(
      'Database: SQLite · Which tests before the commit?: Unit, E2E, “go ahead”',
    );
    const secret = answerSummary(QS, [{ question: 0, other: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }]);
    expect(secret).toMatch(/^Database: “token .+”$/);
    expect(secret).not.toContain('abcdefghijklmnop');
  });
});
