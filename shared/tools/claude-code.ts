// Ported from habblaud shared/activity.ts (MIT, © 2026 Márcio Junior)
// Claude Code's tool table: native tool name + input → activity. Includes the PowerShell tool (Windows, P0-05).
import {
  IMAGE_EXT,
  askQuestions,
  basename,
  describeCommand,
  describeJob,
  domainOf,
  humanize,
  make,
  str,
  truncate,
  type ActivityDescription,
} from '../activity';
import { t } from '../i18n';

function describeMcp(name: string, input: Record<string, unknown>): ActivityDescription {
  const [, server = '', ...rest] = name.split('__');
  const tool = rest.join('__');
  const srv = server.replace(/^claude_ai_/, '');
  if (/playwright|chrome|browser|puppeteer/i.test(srv)) {
    const url = str(input.url);
    if (/navigate/.test(tool)) return make('browser', '🧭', url ? t('Opening {0}', [domainOf(url)]) : t('Browsing'), url);
    if (/screenshot/.test(tool)) return make('browser', '📸', t('Taking a screenshot'));
    if (/click/.test(tool)) return make('browser', '🖱️', t('Clicking on the page'));
    if (/type|fill|form/.test(tool)) return make('browser', '⌨️', t('Filling in a form'));
    if (/snapshot|read|get_page|find/.test(tool)) return make('browser', '🧭', t('Reading the page'));
    return make('browser', '🧭', t('Browser: {0}', [humanize(tool)]));
  }
  if (/github/i.test(srv)) return make('mcp', '🐙', `GitHub: ${humanize(tool)}`);
  if (/gmail|mail/i.test(srv)) return make('mcp', '✉️', t('Email: {0}', [humanize(tool)]));
  if (/drive|docs|notion|confluence/i.test(srv)) return make('mcp', '📄', `${srv}: ${humanize(tool)}`);
  if (/sql|postgres|mysql|mongo|elastic|redis|db/i.test(srv)) return make('mcp', '🗄️', t('Database ({0}): {1}', [srv, humanize(tool)]));
  return make('mcp', '🔌', `${srv}: ${humanize(tool)}`);
}

/** Describes a Claude Code tool call. */
export function describeClaudeTool(name: string, rawInput: unknown): ActivityDescription {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path);

  switch (name) {
    case 'Read':
      if (IMAGE_EXT.test(file)) return make('read', '🖼️', t('Looking at {0}', [basename(file)]), file);
      if (/\.pdf$/i.test(file)) return make('read', '📕', t('Reading {0}', [basename(file)]), file);
      return make('read', '📖', file ? t('Reading {0}', [basename(file)]) : t('Reading a file'), file);
    case 'Edit':
    case 'MultiEdit':
      return make('edit', '✏️', file ? t('Editing {0}', [basename(file)]) : t('Editing a file'), file);
    case 'Write':
      return make('write', '📝', file ? t('Writing {0}', [basename(file)]) : t('Writing a file'), file);
    case 'NotebookEdit':
      return make('edit', '📓', t('Editing notebook {0}', [basename(file)]), file);
    case 'Glob':
      return make('search', '🔎', t('Looking for {0}', [truncate(str(input.pattern) || t('files'), 30)]), str(input.pattern));
    case 'Grep': {
      const pat = str(input.pattern);
      return make('search', '🔎', pat ? t('Searching for “{0}”', [truncate(pat, 26)]) : t('Searching the code'), pat);
    }
    case 'LS':
      return make('read', '📂', t('Listing {0}', [basename(file) || t('a folder')]), file);
    case 'Bash':
      return describeCommand(str(input.command), str(input.description));
    case 'PowerShell':
      return describeCommand(str(input.command), str(input.description), 'powershell');
    case 'BashOutput':
    case 'TaskOutput':
      return make('run', '📟', t('Checking terminal output'));
    case 'Monitor':
      return make('run', '📟', t('Monitoring a process'), str(input.description) || str(input.command));
    case 'KillShell':
    case 'KillBash':
    case 'TaskStop':
      return make('run', '🛑', t('Stopping a process'));
    case 'WebSearch': {
      const q = str(input.query);
      return make('web', '🌐', q ? t('Searching the web for “{0}”', [truncate(q, 22)]) : t('Searching the web'), q);
    }
    case 'WebFetch': {
      const url = str(input.url);
      return make('web', '🌐', url ? t('Reading {0}', [domainOf(url)]) : t('Reading a page'), url);
    }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
      const done = todos.filter((x) => x.status === 'completed').length;
      return make('plan', '🗒️', t('Updating the task list'), todos.length ? t('{0}/{1} done', [done, todos.length]) : undefined);
    }
    case 'TaskCreate':
      return make('plan', '🗒️', t('New task: {0}', [str(input.subject) || t('untitled')]), str(input.description));
    case 'TaskUpdate': {
      const st = str(input.status);
      if (st === 'completed') return make('plan', '✅', t('Finished task #{0}', [str(input.taskId)]));
      if (st === 'in_progress') return make('plan', '🗒️', t('Started task #{0}', [str(input.taskId)]));
      return make('plan', '🗒️', t('Updating task #{0}', [str(input.taskId)]));
    }
    case 'TaskList':
    case 'TaskGet':
      return make('plan', '🗒️', t('Reviewing the tasks'));
    case 'EnterPlanMode':
      return make('plan', '🧭', t('Entering plan mode'));
    case 'ExitPlanMode':
      return make('plan', '🧭', t('Presenting the plan'));
    case 'Agent':
    case 'Task': {
      const d = str(input.description);
      const type = str(input.subagent_type);
      return make('delegate', '👥', d ? t('Delegating: {0}', [d]) : t('Calling a subagent'), [type, str(input.prompt)].filter(Boolean).join(' — '));
    }
    case 'Workflow':
      return make('delegate', '🕸️', t('Orchestrating a workflow'));
    case 'StructuredOutput':
      return make('communicate', '📤', t('Handing in the result'));
    case 'ListAgents':
      return make('communicate', '👥', t('Checking on the team'));
    case 'SendMessage':
      return make('communicate', '💬', t('Message to {0}', [str(input.to) || t('another agent')]), str(input.message));
    case 'AskUserQuestion': {
      const qs = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
      const questions = askQuestions(qs);
      return { ...make('ask', '❓', t('Asking you a question'), qs[0] ? str(qs[0].question) : undefined), ...(questions.length ? { questions } : {}) };
    }
    case 'Skill':
      return make('skill', '🧩', t('Using the {0} skill', [str(input.skill) || str(input.command)]));
    case 'SlashCommand':
      return make('skill', '⌨️', t('Running {0}', [str(input.command)]));
    case 'ToolSearch':
      return make('other', '🧰', t('Looking for tools'));
    case 'ListMcpResourcesTool':
    case 'ReadMcpResourceTool':
      return make('mcp', '🔌', t('Reading MCP resources'));
    case 'Artifact':
      return make('other', '🖼️', t('Publishing a page'));
    case 'ArtifactData':
    case 'ArtifactComments':
      return make('other', '🖼️', t('Updating a published page'));
    case 'CronCreate':
    case 'CronDelete':
    case 'CronList':
    case 'ScheduleWakeup':
    case 'RemoteTrigger':
      return make('plan', '⏰', t('Scheduling a task'));
    case 'EnterWorktree':
    case 'ExitWorktree':
      return make('git', '🌿', t('Switching worktrees'));
    case 'PushNotification':
    case 'SendUserFile':
      return make('communicate', '📣', t('Sending you something'));
    default:
      if (name.startsWith('mcp__')) return describeMcp(name, input);
      return make('other', '🛠️', t('Using {0}', [name]));
  }
}

/** Job label for a Claude Code shell or monitor tool (Bash, PowerShell, Monitor). */
export function claudeJob(name: string, rawInput: unknown): { label: string; command?: string; kind: 'shell' | 'monitor' } {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  const ws = input.ws && typeof input.ws === 'object' ? str((input.ws as Record<string, unknown>).url) : '';
  return describeJob(str(input.command) || ws, str(input.description), name === 'Monitor' ? 'monitor' : 'shell');
}

/** Translates `waitingFor` from Claude Code's session registry. */
export function describeClaudeWaitingFor(raw: string | undefined): string {
  if (!raw) return t('answer in the terminal');
  const r = raw.toLowerCase();
  if (r === 'input needed') return t('answer a question');
  if (r === 'worker request') return t('approve a worker request');
  if (r === 'sandbox request') return t('approve sandbox access');
  if (r === 'dialog open') return t('close an open dialog');
  if (/permission|approve|allow/.test(r)) return t('approve a permission');
  if (/trust/.test(r)) return t('trust this folder');
  return truncate(raw, 40);
}
