// Tool tables per provider. Adapters, the demo simulator and the client describe tool calls through here.
import { basename, describeCommand, humanize, make, str, truncate, type ActivityDescription } from '../activity';
import { t } from '../i18n';
import type { ProviderId } from '../protocol';
import { describeClaudeTool } from './claude-code';
import { describeGeminiTool } from './gemini-cli';

/**
 * For custom agents (and providers without a table yet): guesses from common tool names and input fields, so an SDK
 * user gets sensible bubbles without registering anything.
 */
export function describeGenericTool(name: string, rawInput: unknown): ActivityDescription {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  // Whole words of the name: "read_file" → read, file; "frobnicate" doesn't contain "cat".
  const words = new Set(humanize(name).split(/[\s.:/]+/));
  const has = (...ws: string[]) => ws.some((w) => words.has(w));
  const file = str(input.file_path) || str(input.path) || str(input.file) || str(input.filename);
  const command = str(input.command) || str(input.cmd);
  if (command && has('shell', 'bash', 'exec', 'execute', 'command', 'terminal', 'run', 'powershell')) return describeCommand(command, str(input.description));
  if (has('read', 'open', 'view', 'cat', 'load')) return make('read', '📖', file ? t('Reading {0}', [basename(file)]) : t('Reading a file'), file);
  if (has('write', 'create', 'save')) return make('write', '📝', file ? t('Writing {0}', [basename(file)]) : t('Writing a file'), file);
  if (has('edit', 'replace', 'patch', 'modify', 'update')) return make('edit', '✏️', file ? t('Editing {0}', [basename(file)]) : t('Editing a file'), file);
  if (has('search', 'grep', 'find', 'glob', 'query', 'lookup')) {
    const q = str(input.pattern) || str(input.query);
    return make('search', '🔎', q ? t('Searching for “{0}”', [truncate(q, 26)]) : t('Searching'), q);
  }
  if (has('web', 'http', 'fetch', 'browse', 'url', 'get', 'post', 'request')) return make('web', '🌐', t('Using the web'), str(input.url) || str(input.query));
  if (has('test', 'tests')) return make('test', '🧪', t('Running tests'));
  if (has('agent', 'subagent', 'delegate', 'spawn')) return make('delegate', '👥', t('Calling a subagent'), str(input.prompt) || str(input.task));
  if (has('ask', 'question', 'confirm')) return make('ask', '❓', t('Asking you a question'));
  if (has('plan', 'todo', 'todos', 'task', 'tasks')) return make('plan', '🗒️', t('Planning'));
  return make('other', '🛠️', t('Using {0}', [humanize(name)]));
}

/** Native tool name + input → activity, using the provider's own table. */
export function describeToolFor(provider: ProviderId, name: string, input: unknown): ActivityDescription {
  switch (provider) {
    case 'claude-code':
      return describeClaudeTool(name, input);
    case 'gemini-cli':
      return describeGeminiTool(name, input);
    default:
      return describeGenericTool(name, input);
  }
}
