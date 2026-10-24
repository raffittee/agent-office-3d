// The message box (P7-04): status texts.
import { describe, expect, it } from 'vitest';
import { statusText } from './compose';

describe('compose', () => {
  it('reads each status', () => {
    expect(statusText({ status: 'queued' })).toMatch(/Waiting/);
    expect(statusText({ status: 'delivered' })).toBe('Delivered ✓');
    expect(statusText({ status: 'failed', error: 'the agent left the office' })).toBe('Not delivered: the agent left the office');
  });
});
