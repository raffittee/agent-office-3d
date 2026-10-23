// Keeps the captured provider fixtures well-formed and free of machine-specific data, so later parser tests can
// trust them.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));

function jsonl(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown);
}

function providerFiles(provider: string): string[] {
  return readdirSync(join(dir, provider))
    .filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'))
    .map((f) => join(dir, provider, f));
}

describe('fixtures', () => {
  it('contain no personal paths or names', () => {
    for (const provider of readdirSync(dir)) {
      for (const f of providerFiles(provider)) {
        expect(readFileSync(f, 'utf8'), f).not.toMatch(/AppData|Rafi|raffittee|nroscillada/i);
      }
    }
  });

  describe('gemini-cli', () => {
    const base = ['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'timestamp'];

    it('hook payloads carry the common fields', () => {
      for (const f of providerFiles('gemini-cli').filter((f) => /[\\/]hooks-[^\\/]+$/.test(f))) {
        const lines = jsonl(f) as { payload: Record<string, unknown> }[];
        expect(lines.length, f).toBeGreaterThan(0);
        for (const { payload } of lines) for (const k of base) expect(payload, `${f}: ${k}`).toHaveProperty(k);
      }
    });

    it('a denied tool produces no AfterTool, and the chat file records the cancellation', () => {
      const hooks = (jsonl(join(dir, 'gemini-cli', 'hooks-tui-allow-deny.jsonl')) as { payload: Record<string, unknown> }[]).map((l) => l.payload);
      const names = hooks.map((p) => p.hook_event_name);
      const lastNotice = names.lastIndexOf('Notification');
      expect(names[lastNotice - 1]).toBe('BeforeTool');
      expect(names[lastNotice + 1]).toBe('BeforeAgent');

      const chat = jsonl(join(dir, 'gemini-cli', 'chat-tui-allow-deny.jsonl')) as { type?: string; content?: unknown; toolCalls?: { status: string }[] }[];
      expect(chat.some((m) => m.toolCalls?.some((t) => t.status === 'cancelled'))).toBe(true);
      expect(chat.some((m) => m.type === 'info' && m.content === 'Request cancelled.')).toBe(true);
    });
  });
});
