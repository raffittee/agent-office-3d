// Ported from habblaud server/test/fixtures.ts (MIT, © 2026 Márcio Junior)
// Builders of SYNTHETIC JSONL lines in Claude Code's transcript format (for tests). Nothing here comes from real
// conversations; the real-file checks replay test/fixtures/claude-code/.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ts = (at: number) => new Date(at).toISOString();

export interface LineOpts {
  at?: number;
  sessionId?: string;
  agentId?: string;
  gitBranch?: string;
}

function base(type: string, o: LineOpts): Record<string, unknown> {
  const rec: Record<string, unknown> = {
    type,
    uuid: uuid(),
    timestamp: ts(o.at ?? Date.now()),
    sessionId: o.sessionId ?? 'sess-test',
    cwd: '/projects/demo',
    gitBranch: o.gitBranch ?? 'main',
    isSidechain: !!o.agentId,
  };
  if (o.agentId) rec.agentId = o.agentId;
  return rec;
}

export const L = {
  prompt(text: string, o: LineOpts = {}): string {
    return JSON.stringify({ ...base('user', o), message: { role: 'user', content: text } });
  },
  meta(text: string, o: LineOpts = {}): string {
    return JSON.stringify({ ...base('user', o), isMeta: true, message: { role: 'user', content: text } });
  },
  assistant(
    blocks: Array<Record<string, unknown>>,
    o: LineOpts & { msgId?: string; stop?: string | null; usage?: Record<string, number>; model?: string } = {},
  ): string {
    return JSON.stringify({
      ...base('assistant', o),
      requestId: `req_${o.msgId ?? n}`,
      message: {
        id: o.msgId ?? `msg_${++n}`,
        role: 'assistant',
        model: o.model ?? 'claude-test-1',
        content: blocks,
        stop_reason: o.stop ?? null,
        usage: o.usage ?? { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      },
    });
  },
  thinking: () => ({ type: 'thinking', thinking: 'hmm', signature: 'x' }),
  text: (text: string) => ({ type: 'text', text }),
  tool: (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input }),
  result(
    id: string,
    content: string,
    o: LineOpts & { error?: boolean; toolUseResult?: unknown; extraText?: string; extra?: Record<string, unknown> } = {},
  ): string {
    const blocks: Array<Record<string, unknown>> = [{ type: 'tool_result', tool_use_id: id, content, ...(o.error ? { is_error: true } : {}) }];
    if (o.extraText) blocks.push({ type: 'text', text: o.extraText });
    const rec: Record<string, unknown> = { ...base('user', o), message: { role: 'user', content: blocks }, ...o.extra };
    if (o.toolUseResult !== undefined) rec.toolUseResult = o.toolUseResult;
    return JSON.stringify(rec);
  },
  system(subtype: string, extra: Record<string, unknown> = {}, o: LineOpts = {}): string {
    return JSON.stringify({ ...base('system', o), subtype, ...extra });
  },
  /** Metadata lines without a timestamp (custom-title, ai-title...). */
  raw(type: string, fields: Record<string, unknown>): string {
    return JSON.stringify({ type, sessionId: 'sess-test', ...fields });
  },
  notification(toolUseId: string, status: string, summary: string, o: LineOpts = {}): string {
    const text = `<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
    return JSON.stringify({ ...base('user', o), origin: { kind: 'task-notification' }, message: { role: 'user', content: text } });
  },
  /**
   * Start of a fork's transcript, as Claude Code writes it: the reference to the parent's context, the COPY of the
   * parent's Agent call (same tool_use id as the meta.json) and its result ("Fork started…") with the fork's directive
   * after the <fork-boilerplate> block.
   */
  forkStart(agentId: string, toolUseId: string, directive: string, o: LineOpts = {}): string[] {
    const ref = JSON.stringify({ type: 'fork-context-ref', agentId, parentSessionId: o.sessionId ?? 'sess-test', parentLastUuid: uuid(), contextLength: 42 });
    const spawn = JSON.parse(L.assistant([L.tool(toolUseId, 'Agent', { description: 'x', subagent_type: 'fork', prompt: directive, run_in_background: true })], { ...o, agentId, stop: 'tool_use' })) as Record<string, unknown>;
    spawn.parentUuid = null;
    const text = `<fork-boilerplate>\nYou are a worker fork. Do the directive.\n</fork-boilerplate>\n\nYour directive: ${directive}`;
    return [ref, JSON.stringify(spawn), L.result(toolUseId, 'Fork started — processing in background', { ...o, agentId, extraText: text })];
  },
  /** A background shell launched: tool_result with the task id (as Claude Code writes it). */
  bgLaunched(toolUseId: string, taskId: string, o: LineOpts = {}): string {
    return L.result(toolUseId, `Command running in background with ID: ${taskId}. Output is being written to: /tmp/tasks/${taskId}.output`, {
      ...o,
      toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: taskId },
    });
  },
  /**
   * End of a background shell: 'queue' = a queue-operation line (enqueue, when it ends); 'message' = the notification
   * delivered to the agent as a user message.
   */
  shellNotification(via: 'queue' | 'message', nt: { taskId: string; toolUseId?: string; status: string; summary?: string }, o: LineOpts = {}): string {
    const text = [
      '<task-notification>',
      `<task-id>${nt.taskId}</task-id>`,
      ...(nt.toolUseId ? [`<tool-use-id>${nt.toolUseId}</tool-use-id>`] : []),
      `<output-file>/tmp/tasks/${nt.taskId}.output</output-file>`,
      `<status>${nt.status}</status>`,
      `<summary>${nt.summary ?? `Background command "x" ${nt.status}`}</summary>`,
      '</task-notification>',
    ].join('\n');
    if (via === 'queue') {
      return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: ts(o.at ?? Date.now()), sessionId: o.sessionId ?? 'sess-test', content: text });
    }
    return JSON.stringify({ ...base('user', o), origin: { kind: 'task-notification' }, message: { role: 'user', content: text } });
  },
};

export function writeLines(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => `${l}\n`).join(''));
}

export function appendLines(path: string, lines: string[]): void {
  appendFileSync(path, lines.map((l) => `${l}\n`).join(''));
}
