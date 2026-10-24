// The conversation view (P7-05): results under their calls, and the folded summary.
import { describe, expect, it } from 'vitest';
import type { ConversationEntry } from '../../../shared/protocol';
import { resultsByTool, resultSummary } from './conversation';

describe('conversation view', () => {
  it('maps results to their tool calls', () => {
    const e: ConversationEntry[] = [
      { kind: 'tool', id: 't1', at: 1, tool: 'Bash', title: 'Bash(ls)' },
      { kind: 'result', id: 't1:result', at: 2, toolId: 't1', text: 'a\nb' },
    ];
    expect(resultsByTool(e).get('t1')?.text).toBe('a\nb');
    expect(resultSummary('first\nsecond\nthird')).toEqual({ first: 'first', lines: 3 });
  });
});
