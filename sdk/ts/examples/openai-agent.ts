// A minimal agent loop on an OpenAI-compatible Chat Completions endpoint (Ollama by default) that reports to Agent
// Office (P5-02).
//
//   ollama pull llama3.2                      # or any model with tool calling
//   npx tsx sdk/ts/examples/openai-agent.ts "What does this project do?"
//
//   OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_API_KEY=... OPENAI_MODEL=gpt-5-mini npx tsx sdk/ts/examples/openai-agent.ts
//
// The model can call two read-only tools (list_files, read_file) inside the current folder. Each turn, tool call and
// token count shows up in the office as a "custom:openai-example" agent in this folder's room.
import { readdir, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { AgentOffice } from '../agent-office';

const TOOLS = [
  { type: 'function', function: { name: 'list_files', description: 'List files in a folder of the project.', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a text file of the project.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
];

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface AgentConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  root: string;
  /** Where Agent Office runs (default: AGENT_OFFICE_PORT). */
  officeUrl?: string;
}

function inside(root: string, path: string): string {
  const p = resolve(root, path);
  if (p !== root && !p.startsWith(root + sep)) throw new Error('outside the project');
  return p;
}

async function runTool(root: string, name: string, args: Record<string, unknown>): Promise<string> {
  if (name === 'list_files') {
    const entries = await readdir(inside(root, String(args.path ?? '.')), { withFileTypes: true });
    return entries.map((e) => e.name + (e.isDirectory() ? '/' : '')).sort().slice(0, 200).join('\n');
  }
  if (name === 'read_file') return (await readFile(inside(root, String(args.path)), 'utf8')).slice(0, 20_000);
  throw new Error(`unknown tool ${name}`);
}

/** Answers `question`, reporting to Agent Office. Returns the final answer. */
export async function runAgent(question: string, cfg: AgentConfig): Promise<string> {
  const office = new AgentOffice({ name: 'openai-example', cwd: cfg.root, ...(cfg.officeUrl ? { url: cfg.officeUrl } : {}) });
  await office.sessionStart({ title: question.slice(0, 80), model: cfg.model });
  office.turnStart(question);
  const messages: Message[] = [{ role: 'user', content: question }];
  let answer = '';
  try {
    for (let step = 0; step < 10; step++) {
      const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({ model: cfg.model, messages, tools: TOOLS }),
      });
      if (!res.ok) throw new Error(`the model endpoint answered ${res.status}`);
      const reply = (await res.json()) as { choices: { message: Message }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } };
      const cached = reply.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      office.usage({ in: (reply.usage?.prompt_tokens ?? 0) - cached, out: reply.usage?.completion_tokens ?? 0, cached });
      const msg = reply.choices[0]!.message;
      messages.push(msg);
      if (!msg.tool_calls?.length) {
        answer = msg.content ?? '';
        break;
      }
      for (const call of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          // the model sent broken JSON: the tool sees no arguments
        }
        let content: string;
        try {
          content = await office.tool(call.function.name, args, () => runTool(cfg.root, call.function.name, args));
        } catch (err) {
          content = `error: ${(err as Error).message}`;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }
  } finally {
    office.turnEnd();
    await office.close();
  }
  return answer;
}

const isMain = process.argv[1] && /openai-agent\.[jt]s$/.test(process.argv[1]);
if (isMain) {
  const question = process.argv.slice(2).join(' ') || 'Summarize this project in three sentences.';
  runAgent(question, {
    baseUrl: process.env.OPENAI_BASE_URL ?? 'http://localhost:11434/v1',
    ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
    model: process.env.OPENAI_MODEL ?? 'llama3.2',
    root: process.cwd(),
  })
    .then((a) => console.log(a))
    .catch((err: unknown) => {
      console.error((err as Error).message);
      process.exitCode = 1;
    });
}
