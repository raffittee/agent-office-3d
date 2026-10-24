// How a permission request reads in the office (P7-01): a CLI-style title ("Bash(npm test)", "Edit(src/app.ts)") and a
// preview of the arguments (the command, a small diff, the JSON). Everything masked and truncated. Pure. Habblaud's
// equivalent is toolView in server/sources/terminal.ts.
import { maskSecrets, truncate } from './activity';

const TITLE_MAX = 120;
/** Longest preview of the arguments. */
export const INPUT_MAX = 4_000;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A path relative to the project when it is inside it (forward slashes, case-insensitive on the drive). */
export function relPath(path: string, cwd?: string): string {
  if (!cwd || !path) return path;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const p = norm(path);
  const c = norm(cwd);
  return p.toLowerCase().startsWith(`${c.toLowerCase()}/`) ? p.slice(c.length + 1) : p;
}

function lines(prefix: string, text: string, max: number): string {
  return text
    .split('\n')
    .slice(0, max)
    .map((l) => `${prefix}${l}`)
    .join('\n');
}

/** Masks and cuts a block of text, keeping its line breaks. */
export function cutBlock(text: string, max: number): string {
  const masked = maskSecrets(text.slice(0, max * 2)).replace(/\r\n?/g, '\n').replace(/[^\S\n]+$/gm, '');
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}

export function permissionView(tool: string, input: unknown, cwd?: string): { title: string; input?: string } {
  const r = rec(input);
  const clean = (s: string, n: number) => truncate(maskSecrets(s.slice(0, n * 4)), n);
  const file = str(r.file_path) || str(r.notebook_path) || str(r.path);
  let arg = '';
  let preview = '';
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      arg = str(r.command).split('\n')[0] ?? '';
      preview = str(r.command);
      break;
    case 'Edit':
      arg = relPath(file, cwd);
      preview = `${lines('- ', str(r.old_string), 30)}\n${lines('+ ', str(r.new_string), 30)}`;
      break;
    case 'MultiEdit': {
      arg = relPath(file, cwd);
      const edits = Array.isArray(r.edits) ? r.edits.slice(0, 5).map(rec) : [];
      preview = edits.map((e) => `${lines('- ', str(e.old_string), 10)}\n${lines('+ ', str(e.new_string), 10)}`).join('\n…\n');
      break;
    }
    case 'Write':
      arg = relPath(file, cwd);
      preview = lines('', str(r.content), 40);
      break;
    case 'Read':
    case 'NotebookEdit':
      arg = relPath(file, cwd);
      break;
    case 'WebFetch':
      arg = str(r.url);
      break;
    case 'WebSearch':
      arg = str(r.query);
      break;
    default:
      if (file) arg = relPath(file, cwd);
      else if (str(r.command)) arg = str(r.command).split('\n')[0] ?? '';
  }
  if (!preview && Object.keys(r).length) {
    try {
      preview = JSON.stringify(r, null, 2);
    } catch {
      preview = '';
    }
  }
  const title = clean(arg ? `${tool}(${arg})` : tool, TITLE_MAX);
  const out: { title: string; input?: string } = { title };
  if (preview.trim()) out.input = cutBlock(preview, INPUT_MAX);
  return out;
}
