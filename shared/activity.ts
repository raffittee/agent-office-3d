// Ported from habblaud shared/activity.ts (MIT, © 2026 Márcio Junior)
// Turns what agents do into short, readable activities (English, through t()). Pure code, used by the server
// (adapters), the demo simulator and the client. Provider tool tables live in shared/tools/; this module holds the
// provider-neutral parts: secret masking, text helpers, the shell-command heuristics and the special activities.
import { t } from './i18n';
import type { ActivityKind, AskQuestion } from './protocol';

export interface ActivityDescription {
  kind: ActivityKind;
  icon: string;
  text: string;
  detail?: string;
  questions?: AskQuestion[];
}

export const MAX_TEXT = 46;
export const MAX_DETAIL = 300;
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;

/** Collapses whitespace and line breaks, and cuts with an ellipsis. */
export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, Math.max(1, n - 1)).trimEnd()}…` : one;
}

export function basename(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  const i = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return i >= 0 ? clean.slice(i + 1) : clean;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return truncate(url, 30);
  }
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** "create_issue" / "createIssue" → "create issue". */
export function humanize(id: string): string {
  return id
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
}

/** Builds a description: masks before cutting (a secret cut in half would leak its start). */
export function make(kind: ActivityKind, icon: string, text: string, detail?: string): ActivityDescription {
  return {
    kind,
    icon,
    text: truncate(maskSecrets(text.slice(0, MAX_TEXT * 8)), MAX_TEXT),
    ...(detail ? { detail: truncate(maskSecrets(detail.slice(0, MAX_DETAIL * 4)), MAX_DETAIL) } : {}),
  };
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic)$/i;

/** Questions of an ask-the-user tool, masked and cut, keeping their original positions (answers go back by them). */
export function askQuestions(raw: unknown): AskQuestion[] {
  const clean = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? truncate(maskSecrets(v.slice(0, n * 4)), n) : '');
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
  const qs = Array.isArray(raw) ? raw.slice(0, MAX_QUESTIONS) : [];
  return qs.flatMap((q, index) => {
    if (!obj(q)) return [];
    const question = clean(q.question, 300);
    if (!question) return [];
    const opts = Array.isArray(q.options) ? q.options.slice(0, MAX_OPTIONS) : [];
    const options = opts.flatMap((o, i) => {
      if (!obj(o)) return [];
      const label = clean(o.label, 80);
      if (!label) return [];
      const description = clean(o.description, 200);
      return [{ index: i, label, ...(description ? { description } : {}) }];
    });
    const header = clean(q.header, 30);
    return [{ index, question, ...(header ? { header } : {}), ...(q.multiSelect === true ? { multiSelect: true } : {}), options }];
  });
}

// ------------------------------------------------------------------ secrets

/**
 * Secret patterns masked in texts and details (commands, prompts, replies, errors). Details reach the browser and
 * the feed: a token pasted into a `curl` must not show up there.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // PEM private key blocks.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key]'],
  // Credential headers: Authorization, Cookie, X-Api-Key, ...
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|private-token|x-goog-api-key)(\s*:\s*)[^'"\n]+/gi, '$1$2***'],
  // Loose Bearer/Basic <value>.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g, '$1 ***'],
  // URL with user:password.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:)[^\s@/'"]+@/gi, '$1***@'],
  // Webhooks: the host stays, the secret path goes.
  [/(\bhttps?:\/\/hooks\.slack\.com\/services\/)T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/gi, '$1***'],
  [/(\bhttps?:\/\/(?:discordapp|discord)\.com\/api\/webhooks\/)\d+\/[A-Za-z0-9_-]+/gi, '$1***'],
  [/(\bhttps?:\/\/api\.telegram\.org\/bot)\d+:[A-Za-z0-9_-]+/gi, '$1***'],
  // curl -u user:password / --user user:password.
  [/((?:^|\s)(?:-u|--user)\s+['"]?[^\s:'"]+:)[^\s'"]+/g, '$1***'],
  // --token X, --password=X, --api-key X, ...
  [/((?:^|\s)--?(?:token|password|passwd|pass|secret|api-key|apikey|access-token|auth-token)(?:\s+|=))(['"]?)[^\s'"]+\2/gi, '$1$2***$2'],
  // SENSITIVE_NAME=value / "password": "value" (GITHUB_TOKEN, DB_PASSWORD, client_secret, api_key, ...).
  [
    /\b([A-Za-z0-9_.-]*?(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|_key|credentials?))(["']?\s*[=:]\s*)(["']?)([^\s"'&;|,}]+)\3/gi,
    '$1$2$3***$3',
  ],
  // Keys with a known prefix.
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***'],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, 'github_pat_***'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, 'glpat-***'],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, 'xox*-***'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza***'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, 'sk_***'],
  // Loose npm and Hugging Face tokens (real token length; "npm test" and "hf" stay).
  [/\bnpm_[A-Za-z0-9]{30,}/g, 'npm_***'],
  [/\bhf_[A-Za-z0-9]{30,}/g, 'hf_***'],
  // JWT.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'eyJ***'],
];

/** Masks common secrets (tokens, passwords, keys) in free text. */
export function maskSecrets(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

// ------------------------------------------------------------------ shell

/**
 * Splits into words like the shell does (quotes and escapes), without expanding anything. `$(...)` and
 * `` `...` `` substitutions stay whole inside the word (`NOW=$(date +%s)` is one word). In PowerShell mode the
 * backslash is a literal (Windows paths) and the backtick is the escape character.
 */
export function shellWords(s: string, ps = false): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let q: string | null = null;
  let depth = 0;
  let tick = false;
  const esc = ps ? '`' : '\\';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
      continue;
    }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === esc && i + 1 < s.length && (ps || '"\\$`'.includes(s[i + 1]!))) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === esc && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (c === '`') {
      tick = !tick;
      cur += c;
      has = true;
    } else if (c === '$' && s[i + 1] === '(') {
      depth++;
      cur += '$(';
      i++;
      has = true;
    } else if (depth && c === '(') {
      depth++;
      cur += c;
    } else if (depth && c === ')') {
      depth--;
      cur += c;
    } else if (/\s/.test(c) && !depth && !tick) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** Splits a line at top-level operators (`|`, `||`, `&&`, `;`, `&`), outside quotes and subshells. */
export function splitShell(line: string, ps = false): string[] {
  const segs: string[] = [];
  let start = 0;
  let q: string | null = null;
  let depth = 0;
  const esc = ps ? '`' : '\\';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === esc && q !== "'") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === esc) {
      i++;
      continue;
    }
    if (c === "'" || c === '"' || (!ps && c === '`')) {
      q = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    if (depth) continue;
    let len = 0;
    if ((c === '&' && line[i + 1] === '&') || (c === '|' && line[i + 1] === '|')) len = 2;
    else if (c === '|' || c === ';') len = 1;
    else if (c === '&' && line[i - 1] !== '>' && line[i - 1] !== '<' && line[i + 1] !== '>') len = 1;
    if (!len) continue;
    segs.push(line.slice(start, i));
    i += len - 1;
    start = i + 1;
  }
  segs.push(line.slice(start));
  return segs.map((s) => s.trim()).filter(Boolean);
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * Prefixes that only change how the command runs (the real command comes after), with the flags of each that take
 * a separate value (e.g. `nice -n 10`, `npx -p package`, `sudo -u someone`).
 */
const WRAPPERS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(['-u', '-g', '-p', '-C', '-h', '-U']),
  time: new Set(),
  nohup: new Set(),
  exec: new Set(['-a']),
  builtin: new Set(),
  nice: new Set(['-n']),
  caffeinate: new Set(['-t', '-w']),
  stdbuf: new Set(),
  unbuffer: new Set(),
  command: new Set(),
  npx: new Set(['-p', '--package', '-c', '--call']),
  bunx: new Set(['-p', '--package']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir']),
};

/** Drops assignments (`X=1`) and prefixes (`nohup`, `npx -y`, `timeout 30`, ...) and returns the real command. */
function stripWrappers(words: string[]): string[] {
  let w = words.slice();
  for (let guard = 0; guard < 12 && w.length; guard++) {
    const head = w[0]!;
    if (ASSIGN.test(head)) {
      w = w.slice(1);
      continue;
    }
    if (head === '(' || head === '{' || head === '!' || head === '&') {
      w = w.slice(1);
      continue;
    }
    if (head === 'command' && (w[1] === '-v' || w[1] === '-V')) break;
    if (head === 'timeout' || head === 'gtimeout') {
      let i = 1;
      while (i < w.length && w[i]!.startsWith('-')) i += w[i] === '-s' || w[i] === '-k' ? 2 : 1;
      w = w.slice(i + 1);
      continue;
    }
    if ((head === 'pnpm' || head === 'yarn') && (w[1] === 'dlx' || w[1] === 'exec')) {
      w = w.slice(2);
      continue;
    }
    if (head === 'npm' && w[1] === 'exec') {
      w = w.slice(2);
      continue;
    }
    const valued = Object.hasOwn(WRAPPERS, head) ? WRAPPERS[head] : undefined;
    // A lone prefix (`env`, `time`) is the command itself.
    if (!valued || w.length === 1) break;
    let i = 1;
    while (i < w.length && w[i]!.startsWith('-') && w[i] !== '--') i += valued.has(w[i]!) ? 2 : 1;
    if (w[i] === '--') i++;
    w = w.slice(i);
  }
  while (w.length && /^[)}]$/.test(w[w.length - 1]!)) w = w.slice(0, -1);
  return w;
}

/** File receiving standard output (`> file`, `>>file`, `1> file`), if any. */
function stdoutTarget(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const m = /^1?(>>?)(.*)$/.exec(args[i]!);
    if (m) return m[2] || args[i + 1];
  }
  return undefined;
}

/** A segment that doesn't say what the agent is doing (setup): `cd`, `X=1`, `set -e`, `sleep 2`, `echo`, ... */
function isNoise(words: string[]): boolean {
  if (!words.length) return true;
  const head = words[0]!;
  if (words.every((x) => ASSIGN.test(x))) return true;
  if (head === 'export' || head === 'unset' || head === 'local' || head === 'readonly') return words.slice(1).every((x) => ASSIGN.test(x) || /^[A-Za-z_]\w*$/.test(x) || x.startsWith('-'));
  if ((head === 'echo' || head === 'printf') && stdoutTarget(words.slice(1))) return false;
  if (/^(set-location|write-host|write-output)$/i.test(head)) return true;
  if (/^\$[A-Za-z_][\w:]*$/.test(head) && words[1] === '=') return true; // PowerShell assignment: $x = 1
  return /^(cd|pushd|popd|set|shopt|source|\.|true|false|:|trap|ulimit|umask|clear|sleep|echo|printf|do|done|then|fi|else|esac)$/.test(head);
}

/** Words that are redirections (and their target, when separate) are dropped from the arguments. */
function withoutRedirects(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (/^\d*(?:>>?|<<?<?|>&|&>)$/.test(a)) {
      i++;
      continue;
    }
    if (/^\d*(?:>>?|<<?<?|>&|&>)/.test(a)) continue;
    out.push(a);
  }
  return out;
}

/** Positional arguments, skipping flags (and the value of the flags listed in `valued`). */
function positionals(args: string[], valued: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  const clean = withoutRedirects(args);
  for (let i = 0; i < clean.length; i++) {
    const a = clean[i]!;
    if (a === '--') {
      out.push(...clean.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      if (valued.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const looksLikeFile = (s: string) => !!s && !s.includes('$') && !/^\d+$/.test(s) && s !== '-';

/** "a.ts", "a.ts and b.ts", "a.ts and 3 more" (or undefined when there is no readable file). */
function filesLabel(files: string[]): string | undefined {
  const names = files.filter(looksLikeFile).map((f) => basename(f) || f);
  if (!names.length) return undefined;
  if (names.length === 1) return names[0];
  if (names.length === 2) return t('{0} and {1}', [names[0], names[1]]);
  return t('{0} and {1} more', [names[0], names.length - 1]);
}

const GREP_VALUED = new Set(['-e', '-f', '-A', '-B', '-C', '-m', '-d', '-D', '--regexp', '--file', '--max-count', '--context', '--include', '--exclude', '--exclude-dir', '-g', '-t', '-T', '--glob', '--type', '--type-not', '-j', '--threads', '-M', '--max-columns']);
const CURL_VALUED = new Set([
  '-H', '-d', '-X', '-o', '-u', '-A', '-e', '-b', '-c', '-F', '-T', '-w', '-m', '-x', '-K', '-r', '-E', '-U', '-Y', '-y', '-z', '-P', '-Q',
  '--header', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json', '--request', '--output', '--user', '--user-agent',
  '--referer', '--cookie', '--cookie-jar', '--form', '--upload-file', '--write-out', '--max-time', '--connect-timeout', '--proxy',
  '--retry', '--retry-delay', '--cacert', '--cert', '--key', '--resolve', '--interface', '--limit-rate', '--range', '--config',
  // wget
  '-O', '-P', '-t', '-T', '--output-document', '--directory-prefix', '--tries', '--timeout', '--password', '--http-user', '--http-password',
  // PowerShell Invoke-WebRequest / Invoke-RestMethod
  '-Method', '-Headers', '-Body', '-OutFile', '-ContentType', '-TimeoutSec',
]);

/** "Testing the local API (:4763/api/snapshot)" or "Calling api.github.com". */
function describeHttp(args: string[]): string {
  let target: string | undefined;
  const clean = withoutRedirects(args);
  for (let i = 0; i < clean.length; i++) {
    const a = clean[i]!;
    if (a === '--url' || /^-Uri$/i.test(a)) {
      target = clean[i + 1];
      break;
    }
    if (a.startsWith('-')) {
      if (CURL_VALUED.has(a)) i++;
      continue;
    }
    if (/^(?:https?:\/\/)?(?:localhost|\[[0-9a-f:]+\]|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]\S*)?$/i.test(a)) {
      target = a;
      break;
    }
  }
  if (!target) return t('Making an HTTP request');
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(target) ? target : `http://${target}`);
  } catch {
    return t('Making an HTTP request');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || /^127\./.test(host)) {
    const path = `${url.port ? `:${url.port}` : ''}${url.pathname === '/' && !url.port ? '/' : url.pathname}`;
    return `${url.pathname.startsWith('/api') ? t('Testing the local API') : t('Testing the local server')} (${truncate(path, 22)})`;
  }
  return t('Calling {0}', [host.replace(/^www\./, '')]);
}

const LANG: Record<string, string> = { node: 'Node', python: 'Python', python3: 'Python', py: 'Python', ruby: 'Ruby', php: 'PHP', deno: 'Deno', bun: 'Bun', tsx: 'TypeScript', 'ts-node': 'TypeScript', perl: 'Perl' };

const GIT_TEXT: Record<string, [string, string]> = {
  commit: ['📦', t('Committing')],
  push: ['🚀', t('Pushing commits (git push)')],
  pull: ['⬇️', t('Pulling from the remote (git pull)')],
  fetch: ['⬇️', t('Fetching from the remote (git fetch)')],
  checkout: ['🌿', t('Switching branches')],
  switch: ['🌿', t('Switching branches')],
  merge: ['🔀', t('Merging')],
  rebase: ['🔀', t('Rebasing')],
  status: ['🌿', t('Checking git status')],
  diff: ['🌿', t('Checking the changes (diff)')],
  show: ['🌿', t('Looking at a commit (git show)')],
  log: ['🌿', t('Reading the git history')],
  add: ['🌿', t('Staging files (git add)')],
  stash: ['🌿', t('Stashing changes')],
  clone: ['⬇️', t('Cloning a repository')],
  branch: ['🌿', t('Checking the branches')],
  worktree: ['🌿', t('Working with worktrees')],
  reset: ['🌿', t('Undoing changes (git reset)')],
  restore: ['🌿', t('Restoring files (git restore)')],
  tag: ['🏷️', t('Working with tags')],
  blame: ['🌿', t('Seeing who changed each line')],
  'cherry-pick': ['🍒', t('Picking a commit (cherry-pick)')],
};

const READER_VALUED: Record<string, ReadonlySet<string>> = {
  head: new Set(['-n', '-c', '--lines', '--bytes']),
  tail: new Set(['-n', '-c', '-s', '--lines', '--bytes']),
  sed: new Set(['-e', '-f', '-l']),
  gsed: new Set(['-e', '-f', '-l']),
  awk: new Set(['-F', '-v', '-f']),
  gawk: new Set(['-F', '-v', '-f']),
  jq: new Set(['-f', '--indent', '--tab']),
  sort: new Set(['-k', '-t', '-o', '-S', '-T']),
  cut: new Set(['-d', '-f', '-c', '-b']),
  column: new Set(['-s', '-c', '-o']),
  bat: new Set(['-l', '--language', '-r', '--line-range', '-H', '--highlight-line', '--style']),
  less: new Set(['-p', '-x', '-y', '-z']),
};

/** PowerShell cmdlets (Claude Code's PowerShell tool on Windows), lower-cased → [kind, icon, text]. */
const POWERSHELL: Record<string, [ActivityKind, string, string]> = {
  'get-content': ['read', '📖', 'Reading {0}'],
  'set-content': ['write', '📝', 'Writing {0}'],
  'add-content': ['write', '📝', 'Writing {0}'],
  'out-file': ['write', '📝', 'Writing {0}'],
  'new-item': ['run', '🗂️', 'Organizing files'],
  'remove-item': ['run', '🗂️', 'Organizing files'],
  'copy-item': ['run', '🗂️', 'Organizing files'],
  'move-item': ['run', '🗂️', 'Organizing files'],
  'rename-item': ['run', '🗂️', 'Organizing files'],
  'get-childitem': ['read', '📂', 'Exploring folders'],
  'select-string': ['search', '🔎', 'Searching the code'],
  'get-process': ['run', '🔍', 'Checking processes'],
  'stop-process': ['run', '🛑', 'Stopping a process'],
  'start-process': ['run', '▶️', 'Starting a process'],
  'get-nettcpconnection': ['run', '🔌', 'Checking processes and ports'],
  'test-path': ['read', '🔍', 'Checking a file'],
  'get-item': ['read', '🔍', 'Checking a file'],
  'get-command': ['search', '🔎', 'Looking for a program'],
  'start-sleep': ['wait', '⏳', 'Waiting a moment'],
  'get-ciminstance': ['run', '🔍', 'Checking the system'],
  'get-date': ['run', '🕒', 'Checking the date and time'],
  'expand-archive': ['run', '🗂️', 'Organizing files'],
  'compress-archive': ['run', '🗂️', 'Organizing files'],
};

/** Describes a command already stripped of prefixes. undefined = not recognized. */
function describeWords(w: string[], depth: number, ps: boolean): ActivityDescription | undefined {
  if (!w.length) return undefined;
  const prog = basename(w[0]!).replace(/\.exe$/i, '');
  const args = w.slice(1);
  const text = w.join(' ');
  const mk = (kind: ActivityKind, icon: string, s: string) => make(kind, icon, s);

  if (/\b(vitest|jest|pytest|phpunit|mocha|ava|rspec)\b|\b(go|cargo|deno|bun)\s+test\b|playwright\s+test|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnode\s+--test\b|-m\s+(pytest|unittest)\b|\bdotnet\s+test\b/.test(text)) {
    return mk('test', '🧪', t('Running tests'));
  }
  if (prog === 'git') {
    let i = 0;
    while (i < args.length && args[i]!.startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
    const sub = args[i] ?? '';
    const [icon, s] = GIT_TEXT[sub] ?? ['🌿', sub ? `git ${sub}` : t('Using git')];
    return mk('git', icon, s);
  }
  if (prog === 'gh') return mk('git', '🐙', t('GitHub CLI: gh {0}', [args.slice(0, 2).join(' ')]).trim());
  if (/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bcomposer\s+(install|require)\b|\bpoetry\s+(add|install)\b|\bcargo\s+add\b|\bgo\s+get\b|\buv\s+(add|sync|pip\s+install)\b|\bwinget\s+install\b|\bchoco\s+install\b/.test(text)) {
    return mk('run', '📦', t('Installing dependencies'));
  }
  if ((prog === 'tsc' && args.includes('--noEmit')) || /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(typecheck|type-check|check-types)\b/.test(text)) {
    return mk('run', '🔍', t('Checking types (TypeScript)'));
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\bvite\s+build\b|^tsc\b|\bwebpack\b|\bcargo\s+build\b|\bgo\s+build\b|^make\b|\bgradle\b|\bmvn\b|\besbuild\b|\brollup\b|\bdotnet\s+build\b/.test(text)) {
    return mk('run', '🏗️', t('Building the project'));
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview)\b|^vite(\s|$)(?!build)|^(next|nuxt|astro)\s+dev\b|^expo\s+start\b|^nodemon\b|^tsx\s+watch\b/.test(text)) {
    return mk('run', '▶️', /\bpreview\b/.test(text) ? t('Starting the build preview') : t('Starting the dev server'));
  }
  if (/\b(eslint|prettier|ruff|black|biome|rubocop|phpcs|stylelint|oxlint)\b|\b(npm|pnpm|yarn)\s+(run\s+)?(lint|format)\b/.test(text)) {
    return mk('run', '🧹', t('Running the linter'));
  }
  if (/^(npm|pnpm|yarn|bun)$/.test(prog) && args[0] === 'run' && args[1]) return mk('run', '▶️', t('Running the {0} script', [args[1]]));
  if (prog === 'docker' || prog === 'docker-compose') return mk('run', '🐳', t('Docker: {0}', [args.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ')]).trim());
  if (/^(kubectl|helm|terraform|aws|gcloud|az|flyctl|fly|vercel|wrangler|netlify|railway)$/.test(prog)) return mk('run', '☁️', t('Working in the cloud ({0})', [prog]));
  if (/^(curl|wget|http|https|xh)$/.test(prog) || /^(invoke-webrequest|invoke-restmethod|iwr|irm)$/i.test(prog)) return mk('web', '🌐', describeHttp(args));
  if (/^(psql|mysql|sqlite3|redis-cli|mongosh|mongo|duckdb)$/.test(prog)) return mk('run', '🗄️', t('Querying the database'));
  if (/^(rg|grep|egrep|fgrep|ag|ack|git-grep|findstr)$/.test(prog)) {
    const e = args.findIndex((a) => a === '-e' || a === '--regexp');
    const pat = e >= 0 ? args[e + 1] : positionals(args, GREP_VALUED)[0];
    const shown = pat?.replace(/\\\|/g, ' | ').replace(/\\([.()[\]{}+?*^$])/g, '$1');
    return mk('search', '🔎', shown ? t('Searching for “{0}”', [truncate(shown, 24)]) : t('Searching the code'));
  }
  const cmdlet = POWERSHELL[prog.toLowerCase()];
  if (cmdlet) {
    const [kind, icon, s] = cmdlet;
    const target = /\{0\}/.test(s) ? filesLabel(positionals(args, new Set(['-Encoding', '-Value', '-Pattern', '-Filter', '-Tail', '-TotalCount', '-Head']))) : undefined;
    if (/\{0\}/.test(s)) return mk(kind, icon, target ? t(s, [target]) : kind === 'read' ? t('Reading a file') : t('Writing a file'));
    return mk(kind, icon, t(s));
  }
  if (/^(ls|find|tree|fd|du|df|eza|exa|dir)$/.test(prog)) return mk('read', '📂', t('Exploring folders'));
  if (prog === 'cd' || prog === 'pushd') return mk('read', '📂', t('Changing folders'));
  if (prog === 'cat' || prog === 'tee' || prog === 'echo' || prog === 'printf') {
    // `cat > file <<EOF`, `cat <<'EOF' >> file`, `echo x > file`, `tee [-a] file`: writing.
    const written = prog === 'tee' ? positionals(args)[0] : stdoutTarget(args);
    if (written && looksLikeFile(written) && written !== '/dev/null') return mk('write', '📝', t('Writing {0}', [basename(written)]));
    if (prog === 'tee') return mk('write', '📝', t('Writing a file'));
    if (prog !== 'cat') return mk('run', '💬', t('Printing to the terminal'));
  }
  if (/^(sed|gsed|perl)$/.test(prog) && args.some((a) => /^-i|^--in-place|^-pi/.test(a))) {
    const last = positionals(args, new Set(['-e', '-f'])).pop();
    return mk('edit', '✏️', last && looksLikeFile(last) && /[./]/.test(last) ? t('Editing {0}', [basename(last)]) : t('Editing from the terminal'));
  }
  if (/^(cat|head|tail|less|more|bat|nl|sed|gsed|awk|gawk|jq|wc|strings|xxd|od|hexdump|column|sort|uniq|cut|type)$/.test(prog) && !(prog === 'type' && args.length === 1 && !/[./\\]/.test(args[0]!))) {
    // jq --arg name value: two values.
    const jqArgs = prog === 'jq' ? args.filter((_, i) => !/^--(arg|argjson|slurpfile|rawfile)$/.test(args[i - 1] ?? '') && !/^--(arg|argjson|slurpfile|rawfile)$/.test(args[i - 2] ?? '')) : args;
    let files = positionals(jqArgs, READER_VALUED[prog]);
    // sed/awk/jq: the first positional is the program/filter, not a file.
    if (/^(sed|gsed|awk|gawk|jq)$/.test(prog) && !args.includes('-e') && !args.includes('-f')) files = files.slice(1);
    const label = filesLabel(files);
    if (prog === 'wc') {
      const n = files.filter(looksLikeFile).length;
      return mk('read', '🔢', n > 2 ? t('Counting lines in {0} files', [n]) : label ? t('Counting lines in {0}', [label]) : t('Counting lines'));
    }
    if (prog === 'tail' && args.some((a) => a === '-f' || a === '-F')) return mk('read', '📜', label ? t('Following {0}', [label]) : t('Following a log'));
    if (prog === 'jq' && !label) return mk('read', '🔎', t('Filtering JSON'));
    if (/^(sort|uniq|cut|column)$/.test(prog) && !label) return undefined;
    return mk('read', '📖', label ? t('Reading {0}', [label]) : t('Reading a file'));
  }
  if (/^(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|rsync|tar|zip|unzip|gzip|gunzip|xattr|del|copy|move|md)$/.test(prog)) return mk('run', '🗂️', t('Organizing files'));
  if (prog === 'sleep' || prog === 'wait') return mk('wait', '⏳', t('Waiting a moment'));
  if (prog === 'open' || prog === 'xdg-open' || prog === 'start') return mk('run', '🖥️', t('Opening on the computer'));
  if (/^(code|cursor|subl|vim|nvim|nano|emacs|notepad)$/.test(prog)) return mk('edit', '✏️', t('Opening in the editor'));
  if (/^(pkill|kill|killall|taskkill)$/.test(prog)) return mk('run', '🛑', t('Stopping a process'));
  if (prog === 'lsof' || prog === 'netstat') {
    const port = args.map((a) => /^(?:-i)?(?:tcp)?:(\d{2,5})$/i.exec(a)?.[1]).find(Boolean);
    return mk('run', '🔌', port ? t('Checking what uses port {0}', [port]) : t('Checking processes and ports'));
  }
  if (/^(ps|pgrep|top|htop|jobs|tasklist)$/.test(prog)) return mk('run', '🔍', t('Checking processes'));
  if (/^(which|whereis|type|where)$/.test(prog) || (prog === 'command' && /^-[vV]$/.test(args[0] ?? ''))) return mk('search', '🔎', t('Looking for a program'));
  if (/^(diff|cmp|comm|colordiff|delta|fc)$/.test(prog)) return mk('read', '🔀', t('Comparing files'));
  if (prog === 'date') return mk('run', '🕒', t('Checking the date and time'));
  if (prog === 'env' || prog === 'printenv') return mk('run', '🔍', t('Checking environment variables'));
  if (/^(stat|file|md5|md5sum|shasum|sha256sum|realpath|readlink|certutil)$/.test(prog)) return mk('read', '🔍', t('Checking a file'));
  if (prog === 'claude') return mk('run', '🤖', t('Running Claude Code'));
  if (prog === 'gemini') return mk('run', '🤖', t('Running Gemini CLI'));
  if (prog === 'codex') return mk('run', '🤖', t('Running Codex'));
  if (/^(pbcopy|pbpaste|clip)$/.test(prog)) return mk('run', '📋', t('Using the clipboard'));
  if (/^(bash|sh|zsh|fish|pwsh|powershell|cmd)$/i.test(prog)) {
    const c = args.findIndex((a) => /^(-c|-Command|\/c)$/i.test(a));
    if (c >= 0 && args[c + 1] && depth < 3) return describeLine(args.slice(c + 1).join(' '), depth + 1, /^(pwsh|powershell)$/i.test(prog)).desc;
    const script = positionals(args).find(looksLikeFile);
    return mk('run', '▶️', script ? t('Running {0}', [basename(script)]) : t('Running a shell script'));
  }
  if (/^(node|python3?|py|ruby|php|deno|bun|tsx|ts-node|perl|java)$/.test(prog) || (prog === 'go' && args[0] === 'run')) {
    // Skip flags, redirections/heredocs and inline code (-e/-c '...').
    const list = withoutRedirects(prog === 'go' ? args.slice(1) : args);
    const script = list.find((s, i) => !s.startsWith('-') && !/^-[ecpr]$|^--(eval|print|import|require|loader)$/.test(list[i - 1] ?? '') && /[./]/.test(s) && !/^\d+(\.\d+)*$/.test(s));
    if (script && !/^(-m|-c)$/.test(list[0] ?? '')) return mk('run', '▶️', t('Running {0}', [basename(script)]));
    if (list[0] === '-m' && list[1]) return mk('run', '▶️', t('Running the {0} module', [list[1]]));
    return mk('run', '▶️', t('Running a {0} script', [LANG[prog] ?? prog]));
  }
  if (/^(\.{0,2}[\\/]|~[\\/])/.test(w[0]!) || /\.(sh|bash|zsh|py|rb|mjs|js|ts|ps1|cmd|bat)$/i.test(w[0]!)) return mk('run', '▶️', t('Running {0}', [prog]));
  return undefined;
}

interface LineDescription {
  desc?: ActivityDescription;
  /** Main program found (for the generic text, when there is no description). */
  prog?: string;
}

/** Describes the first "real" line of a shell snippet. */
function describeLine(text: string, depth: number, ps: boolean): LineDescription {
  const lines = (ps ? text : text.replace(/\\\r?\n/g, ' ')).split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!.trim();
    if (!line || line.startsWith('#')) continue;
    const segs = splitShell(line, ps);
    let main: string[] | undefined;
    let mainIdx = -1;
    for (let i = 0; i < segs.length; i++) {
      let seg = segs[i]!;
      // A whole subshell `( ... )` or group `{ ...; }`: look inside.
      if (/^\(.*\)$/.test(seg) && depth < 3) {
        const inner = describeLine(seg.slice(1, -1), depth + 1, ps);
        if (inner.desc || inner.prog) return inner;
        continue;
      }
      seg = seg.replace(/^\{\s*/, '');
      const words = stripWrappers(shellWords(seg, ps));
      if (isNoise(words)) continue;
      main = words;
      mainIdx = i;
      break;
    }
    if (!main) {
      // Only setup on this line (`S=/tmp/x`, `cd folder`): go to the next one, unless it's the last; then describe
      // whatever there is (`sleep 5` alone).
      if (lines.slice(li + 1).some((l) => l.trim() && !l.trim().startsWith('#'))) continue;
      const words = stripWrappers(shellWords(segs[0] ?? '', ps));
      return { desc: describeWords(words, depth, ps), prog: words[0] };
    }
    // Loops and conditionals: the body matters (`do ...` / `then ...`), on the same line or the next.
    if (/^(for|while|until|if|select)$/.test(main[0]!) && depth < 3) {
      const rest = segs.slice(mainIdx + 1).join('; ');
      const body = /^(?:do|then)\b\s*(.*)$/s.exec(rest.replace(/^.*?;\s*(?=(do|then)\b)/s, ''))?.[1]?.trim();
      const next = [body, ...lines.slice(li + 1)].filter((l): l is string => !!l && !!l.trim() && !/^(done|fi|else|esac)\b/.test(l.trim())).join('\n');
      const inner = next ? describeLine(next, depth + 1, ps) : {};
      return inner.desc ? inner : { desc: make('run', '🔁', t('Repeating a command in a loop')) };
    }
    return { desc: describeWords(main, depth, ps), prog: main[0] };
  }
  return {};
}

/** A command that starts with a PowerShell cmdlet (`Get-Content ...`, `& Invoke-WebRequest ...`). */
const CMDLET = /^\s*(?:&\s*)?[A-Z][a-z]+-[A-Z][A-Za-z]+\b/;

/**
 * Describes a shell command (bash or PowerShell). The heuristic looks at the first line with a real command
 * (skipping `X=1`, `cd`, `set -e`, comments), the first useful segment (before `|`, `&&`, `;`) and its arguments.
 * When the command isn't recognized, the tool's own `description` becomes the text.
 */
export function describeCommand(command: string, description?: string, shell?: 'powershell'): ActivityDescription {
  const detail = command.trim();
  const ps = shell === 'powershell' || CMDLET.test(detail);
  let found: LineDescription = {};
  try {
    found = describeLine(detail.slice(0, 8_000), 0, ps);
  } catch {
    found = {}; // too odd for the heuristic: fall back to the generic text
  }
  if (found.desc) return make(found.desc.kind, found.desc.icon, found.desc.text, detail);
  const desc = description?.trim();
  if (desc) return make('run', '💻', desc, detail);
  const prog = basename(found.prog ?? '');
  const text = /^[A-Za-z][\w.+-]{0,23}$/.test(prog) ? t('Running {0}', [prog]) : t('Running a terminal command');
  return make('run', '💻', text, detail);
}

/** Activity for a user prompt. */
export function describePrompt(text: string): ActivityDescription {
  return make('prompt', '📨', t('New task: “{0}”', [truncate(text, 30)]), text);
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min${s % 60 ? ` ${s % 60}s` : ''}`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}min` : ''}`;
}

// ------------------------------------------------------------------ jobs (waiting for commands)

/** Marker (Activity.tool) for the end of a background job: the office celebrates (or not, with `error`). */
export const JOB_DONE_TOOL = 'JobDone';
/** Marker (Activity.tool) for the "Waiting for the shell" bubble, synthesized while the status is 'shell'. */
export const JOB_WAIT_TOOL = 'JobWait';

/** How a background job ended. */
export type JobOutcome = 'ok' | 'failed' | 'killed';

/** An activity with a tool marker (can go straight into an `Activity` with `...desc`). */
export type MarkedDescription = ActivityDescription & { tool: string; error?: boolean };

/**
 * Label (≤ 46 characters) and command (≤ 300) of a job the agent will wait for, masked. The label is the tool's
 * description; without one, the command summary ("Running tests").
 */
export function describeJob(command: string, description?: string, kind: 'shell' | 'monitor' = 'shell'): { label: string; command?: string; kind: 'shell' | 'monitor' } {
  const cmd = command.trim();
  const desc = (description ?? '').trim();
  let label: string;
  if (desc) label = truncate(maskSecrets(desc.slice(0, MAX_TEXT * 8)), MAX_TEXT);
  else if (kind === 'monitor') label = /^wss?:\/\//.test(cmd) ? t('Listening to {0}', [domainOf(cmd)]) : t('Monitoring a process');
  else label = cmd ? describeCommand(cmd).text : t('Terminal command');
  const out: { label: string; command?: string; kind: 'shell' | 'monitor' } = { label, kind };
  if (cmd) out.command = truncate(maskSecrets(cmd.slice(0, MAX_DETAIL * 4)), MAX_DETAIL);
  return out;
}

/** "<prefix><label><suffix>" within MAX_TEXT: only the label is cut (the duration never disappears). */
function fitLabel(prefix: string, label: string | undefined, suffix = ''): string {
  if (!label) return `${prefix.replace(/:\s*$/, '')}${suffix}`;
  const room = Math.max(8, MAX_TEXT - prefix.length - suffix.length);
  return `${prefix}${truncate(label, room)}${suffix}`;
}

export const SPECIAL = {
  think: (): ActivityDescription => make('think', '💭', t('Thinking…')),
  respond: (text?: string): ActivityDescription => make('respond', '💬', t('Writing the reply'), text),
  turnDone: (ms?: number): ActivityDescription => make('done', '✅', ms ? t('Done in {0}', [formatDuration(ms)]) : t('Done')),
  error: (tool?: string, detail?: string): ActivityDescription => make('error', '⚠️', tool ? t('Error in {0}', [tool]) : t('Something went wrong'), detail),
  interrupted: (): ActivityDescription => make('wait', '✋', t('Interrupted by you')),
  compact: (): ActivityDescription => make('compact', '🧹', t('Tidying up its memory (compacting)')),
  waiting: (reason?: string): ActivityDescription => make('wait', '✋', reason ? t('Needs you: {0}', [reason]) : t('Needs you')),
  backgroundResult: (summary?: string): ActivityDescription => make('other', '📬', t('Got a background result'), summary),
  apiRetry: (): ActivityDescription => make('wait', '🔁', t('API hiccup, retrying')),
  rejected: (tool?: string): ActivityDescription => make('wait', '🚫', tool ? t('You declined: {0}', [tool]) : t('You declined the action')),
  cancelled: (): ActivityDescription => make('wait', '✋', t('Request cancelled')),
  cleared: (): ActivityDescription => make('compact', '🧽', t('Started a new conversation (/clear)')),
  supervising: (): ActivityDescription => make('delegate', '👥', t('Watching the subagents')),
  answered: (question?: string): ActivityDescription => make('ask', '💬', t('Got your answer'), question),
  /** The 'shell' status bubble: "Waiting for the shell: <label>" (or "Waiting for 2 shells: ..."). */
  waitingShell: (label?: string, n = 1, detail?: string): MarkedDescription => ({
    ...make('wait', '⏳', fitLabel(n > 1 ? t('Waiting for {0} shells: ', [n]) : t('Waiting for the shell: '), label), detail),
    tool: JOB_WAIT_TOOL,
  }),
  /**
   * End of a background job (marker 'JobDone'): success "Shell finished: <label> (<duration>)", failure "Shell
   * failed: <label>" and killed "Shell stopped: <label>" (both with `error`).
   */
  jobDone: (label: string | undefined, outcome: JobOutcome, ms?: number, detail?: string): MarkedDescription => {
    if (outcome === 'failed') return { ...make('run', '❌', fitLabel(t('Shell failed: '), label), detail), tool: JOB_DONE_TOOL, error: true };
    if (outcome === 'killed') return { ...make('run', '🛑', fitLabel(t('Shell stopped: '), label), detail), tool: JOB_DONE_TOOL, error: true };
    const took = ms !== undefined && ms >= 1_000 ? ` (${formatDuration(ms)})` : '';
    return { ...make('run', '✅', fitLabel(t('Shell finished: '), label, took), detail), tool: JOB_DONE_TOOL };
  },
} as const;
