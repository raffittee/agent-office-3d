// Gemini CLI's tool table, from the tool declarations captured in P0-04 (Gemini CLI 0.65.0; see
// docs/providers/gemini-cli.md). Older names (read_many_files, save_memory, write_todos, search_file_content) are
// kept so older versions still read well.
import { IMAGE_EXT, basename, describeCommand, describeJob, domainOf, humanize, make, str, truncate, type ActivityDescription } from '../activity';
import { t } from '../i18n';

function firstUrl(s: string): string {
  return /https?:\/\/[^\s"'<>)]+/.exec(s)?.[0] ?? '';
}

/** Describes a Gemini CLI tool call. */
export function describeGeminiTool(name: string, rawInput: unknown): ActivityDescription {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  const file = str(input.file_path) || str(input.absolute_path) || str(input.path);

  switch (name) {
    case 'read_file':
      if (IMAGE_EXT.test(file)) return make('read', '🖼️', t('Looking at {0}', [basename(file)]), file);
      if (/\.pdf$/i.test(file)) return make('read', '📕', t('Reading {0}', [basename(file)]), file);
      return make('read', '📖', file ? t('Reading {0}', [basename(file)]) : t('Reading a file'), file);
    case 'read_many_files':
      return make('read', '📖', t('Reading several files'), Array.isArray(input.paths) ? input.paths.filter((p) => typeof p === 'string').join(', ') : undefined);
    case 'list_directory': {
      const dir = str(input.dir_path) || str(input.path);
      return make('read', '📂', t('Listing {0}', [dir && dir !== '.' ? basename(dir) : t('a folder')]), dir);
    }
    case 'glob':
      return make('search', '🔎', t('Looking for {0}', [truncate(str(input.pattern) || t('files'), 30)]), str(input.pattern));
    case 'grep_search':
    case 'search_file_content': {
      const pat = str(input.pattern);
      return make('search', '🔎', pat ? t('Searching for “{0}”', [truncate(pat, 26)]) : t('Searching the code'), pat);
    }
    case 'replace':
      return make('edit', '✏️', file ? t('Editing {0}', [basename(file)]) : t('Editing a file'), file);
    case 'write_file':
      return make('write', '📝', file ? t('Writing {0}', [basename(file)]) : t('Writing a file'), file);
    case 'run_shell_command':
      return describeCommand(str(input.command), str(input.description));
    case 'list_background_processes':
      return make('run', '📟', t('Checking background processes'));
    case 'read_background_output':
      return make('run', '📟', t('Checking terminal output'));
    case 'web_fetch': {
      const url = str(input.url) || firstUrl(str(input.prompt));
      return make('web', '🌐', url ? t('Reading {0}', [domainOf(url)]) : t('Reading a page'), url || str(input.prompt));
    }
    case 'google_web_search': {
      const q = str(input.query);
      return make('web', '🌐', q ? t('Searching the web for “{0}”', [truncate(q, 22)]) : t('Searching the web'), q);
    }
    case 'invoke_agent': {
      const agent = str(input.agent_name);
      return make('delegate', '👥', agent ? t('Delegating to {0}', [humanize(agent)]) : t('Calling a subagent'), str(input.prompt));
    }
    case 'complete_task':
      return make('communicate', '📤', t('Handing in the result'));
    case 'activate_skill':
      return make('skill', '🧩', t('Using the {0} skill', [str(input.name)]));
    case 'enter_plan_mode':
      return make('plan', '🧭', t('Entering plan mode'), str(input.reason));
    case 'update_topic':
      return make('plan', '🧭', str(input.title) ? t('Topic: {0}', [str(input.title)]) : t('Updating the topic'), str(input.summary) || str(input.strategic_intent));
    case 'write_todos':
      return make('plan', '🗒️', t('Updating the task list'));
    case 'save_memory':
      return make('other', '🧠', t('Saving a memory'));
    default:
      return make('other', '🛠️', t('Using {0}', [humanize(name)]));
  }
}

/** Job label for a Gemini background shell (run_shell_command with is_background). */
export function geminiJob(rawInput: unknown): { label: string; command?: string; kind: 'shell' | 'monitor' } {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  return describeJob(str(input.command), str(input.description));
}
