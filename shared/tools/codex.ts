// Ported from habblaud server/sources/codex/rollout.ts (MIT, © 2026 Márcio Junior)
// Codex's tool table, checked against the tools Codex 0.164.0 offers and the names its hooks report (P5-01; see
// docs/providers/codex.md): rollouts name a shell call `exec_command` (`shell`, `local_shell`, `shell_command` in
// older versions) while hooks say `Bash`; hooks prefix namespaced tools (`multi_agent_v1wait_agent`); an
// `apply_patch` input is the patch text (only the file names are read from it).
import { IMAGE_EXT, basename, describeCommand, describeJob, humanize, make, str, truncate, type ActivityDescription } from '../activity';
import { t } from '../i18n';

const SHELLS = /^(?:.*[\\/])?(?:ba|z|da|k|fi)?sh(?:\.exe)?$/;

/**
 * The readable command of a shell call: `cmd`/`command` is a string or a list (`["/bin/bash", "-lc", "npm test"]`).
 * The shell wrapper goes; the rest is joined with spaces (words with spaces quoted).
 */
export function commandText(cmd: unknown): string {
  if (typeof cmd === 'string') return cmd.trim();
  if (!Array.isArray(cmd)) return '';
  const words = cmd.filter((w): w is string => typeof w === 'string');
  if (words.length >= 3 && SHELLS.test(words[0]!) && /^-[a-z]*c$/.test(words[1]!)) return words.slice(2).join(' ').trim();
  return words
    .map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`))
    .join(' ')
    .trim();
}

/** Files a patch touches ("*** Add File: x", "*** Update File: y", "*** Delete File: z"). */
export function patchFiles(patch: string): Array<{ path: string; kind: 'add' | 'update' | 'delete' }> {
  const out: Array<{ path: string; kind: 'add' | 'update' | 'delete' }> = [];
  for (const m of patch.slice(0, 200_000).matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
    out.push({ path: m[2]!.trim(), kind: m[1]!.toLowerCase() as 'add' | 'update' | 'delete' });
  }
  return out;
}

const NAMESPACES = ['multi_agent_v1', 'multi_agent_v2', 'multi_agent'];

/** A tool name without the namespace prefix hooks add (`multi_agent_v1wait_agent` → `wait_agent`). */
export function codexToolName(name: string): string {
  for (const ns of NAMESPACES) if (name.startsWith(ns) && name.length > ns.length) return name.slice(ns.length).replace(/^[._]+/, '');
  return name;
}

/** Describes a Codex tool call. */
export function describeCodexTool(rawName: string, rawInput: unknown): ActivityDescription {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  const name = codexToolName(rawName);
  switch (name) {
    case 'Bash':
    case 'shell':
    case 'shell_command':
    case 'local_shell':
    case 'exec_command':
    case 'container.exec':
      return describeCommand(commandText(input.cmd ?? input.command), str(input.justification) || undefined);
    case 'write_stdin':
      return make('run', '⌨️', str(input.chars) ? t('Typing into a command') : t('Checking terminal output'));
    case 'apply_patch': {
      const patch = str(input.command) || str(input.input) || str(input.patch);
      const files = Array.isArray(input.files) ? (input.files as unknown[]).filter((f): f is string => typeof f === 'string').map((path) => ({ path, kind: 'update' as const })) : patchFiles(patch);
      const first = files[0];
      if (!first) return make('edit', '✏️', t('Editing files'));
      const detail = files.length > 1 ? truncate(files.map((f) => f.path).join(', '), 300) : first.path;
      if (files.length > 1) return make('edit', '✏️', t('Editing {0} files', [String(files.length)]), detail);
      if (first.kind === 'add') return make('write', '📝', t('Writing {0}', [basename(first.path)]), detail);
      if (first.kind === 'delete') return make('edit', '🗑️', t('Deleting {0}', [basename(first.path)]), detail);
      return make('edit', '✏️', t('Editing {0}', [basename(first.path)]), detail);
    }
    case 'update_plan':
      return make('plan', '🗒️', t('Updating the plan'));
    case 'view_image': {
      const path = str(input.path);
      return make('read', '🖼️', path && IMAGE_EXT.test(path) ? t('Looking at {0}', [basename(path)]) : t('Looking at an image'), path);
    }
    case 'web_search':
    case 'web_search_preview': {
      const q = str(input.query);
      return make('web', '🌐', q ? t('Searching the web for “{0}”', [truncate(q, 22)]) : t('Searching the web'), q);
    }
    case 'tool_search':
      return make('search', '🧰', t('Looking for a tool'));
    case 'spawn_agent': {
      const task = str(input.message) || str(input.prompt);
      return make('delegate', '👥', t('Calling a subagent'), task ? truncate(task, 200) : undefined);
    }
    case 'wait':
    case 'wait_agent':
      return make('delegate', '⏳', t('Waiting for the subagents'));
    case 'send_input':
    case 'send_message':
      return make('communicate', '💬', t('Messaging a subagent'));
    case 'resume_agent':
      return make('delegate', '👥', t('Resuming a subagent'));
    case 'close_agent':
      return make('delegate', '👥', t('Closing a subagent'));
    case 'request_user_input':
      return make('ask', '❓', t('Asking you a question'));
    case 'request_permissions':
      return make('wait', '🔐', t('Asking for permissions'));
    case 'get_goal':
    case 'create_goal':
    case 'update_goal':
      return make('plan', '🎯', name === 'get_goal' ? t('Checking the goal') : t('Updating the goal'));
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      if (mcp) return make('other', '🔌', t('Using {0}', [humanize(mcp[2]!)]), mcp[1]);
      return make('other', '🛠️', t('Using {0}', [humanize(name)]));
    }
  }
}

/** Job label for a Codex command left running in the background (an exec session). */
export function codexJob(command: string): { label: string; command?: string; kind: 'shell' | 'monitor' } {
  return describeJob(command);
}
