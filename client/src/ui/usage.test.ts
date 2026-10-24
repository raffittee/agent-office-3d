// Plan usage chips (P5-04): bars, levels, reset times and the tooltip's source line.
import { describe, expect, it } from 'vitest';
import { usageChips } from './usage';

const NOW = Date.parse('2026-10-25T00:00:00Z');

describe('usage chips', () => {
  it('the browser shows bars, reset times and the source in the tooltip', () => {
    const chips = usageChips(
      [
        { id: 'default', provider: 'codex', short: 'X', name: 'Codex', color: '#10a37f', sessions: 1, usageStatus: 'ok', usage: { source: 'codex', fetchedAt: NOW, fiveHour: { utilization: 91, resetsAt: NOW + 150 * 60_000 }, sevenDay: { utilization: 40 } } },
        { id: 'default', provider: 'gemini-cli', short: 'G', name: 'Gemini CLI', color: '#4285f4', sessions: 1, usageStatus: 'disabled' },
      ],
      NOW,
    );
    expect(chips[0]!.bars).toEqual([
      { label: '5h', pct: 91, level: 'high', resets: 'resets in 2 h 30 min' },
      { label: 'week', pct: 40, level: 'ok' },
    ]);
    expect(chips[0]!.title).toContain('From codex');
    expect(chips[1]!.bars).toEqual([]);
    expect(chips[1]!.title).toContain('not available');
  });
});
