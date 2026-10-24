// Ported from habblaud shared/demo/simulator.ts (MIT, © 2026 Márcio Junior)
// Office simulator for demos and development. Pure (no Node or DOM): it runs on the server (AGENT_OFFICE_DEMO=1)
// and in the browser (?mock=1).
//
// Re-shaped for Agent Office: Habblaud's simulator builds snapshots itself; this one only emits AgentEvents, which go
// through the same office reducer as real agents. It mixes providers (Claude Code, Gemini CLI, Codex and a custom
// agent), each with its own tool names, and keeps Habblaud's realistic cycles: prompt → work → (permission or
// question) → (subagents) → (long foreground command) → end of turn → (waiting for a background shell) → pause → …
// Sessions end from time to time, to exercise arrivals, departures and empty rooms.
//
// Determinism: the same seed and the same tick times always produce the same events.
import { hash32, mulberry32 } from '../hash';
import { t } from '../i18n';
import type { AgentEvent, AgentEventType, EventTask, ProviderId, ProviderMeta } from '../protocol';

interface DemoProject {
  name: string;
  files: string[];
  prompts: string[];
  tasks: string[];
  queries: string[];
  commands: string[];
  greps: string[];
}

const ROOT = '/home/dev/projects';

const PROJECTS: DemoProject[] = [
  {
    name: 'online-store',
    files: ['src/pages/Checkout.tsx', 'src/components/Cart.tsx', 'src/api/orders.ts', 'src/hooks/useCart.ts', 'src/styles/theme.css', 'tests/cart.test.ts', 'package.json'],
    prompts: [t('Build the checkout page with an order summary'), t("The cart total doesn't update when an item is removed"), t('Add discount codes to checkout'), t('Improve the mobile layout of the storefront')],
    tasks: [t('Build the checkout page'), t('Validate the address form'), t('Hook up shipping rates'), t('Write cart tests'), t('Fix the mobile layout')],
    queries: ['react checkout form validation', 'shipping rates api'],
    commands: ['npm test', 'npm run build', 'git status', 'git diff', 'npm run lint', 'git commit -m "feat: checkout"'],
    greps: ['useCart', 'calculateTotal', 'TODO'],
  },
  {
    name: 'payments-api',
    files: ['src/routes/payments.ts', 'src/services/refunds.ts', 'src/db/migrations/004_refunds.sql', 'src/middleware/auth.ts', 'tests/refunds.test.ts', 'docker-compose.yml'],
    prompts: [t('Implement payment refunds'), t('Webhooks are charging twice, investigate'), t('Add rate limiting to the public routes')],
    tasks: [t('Map the refund flow'), t('Add the refunds migration'), t('POST /refunds route'), t('Idempotent webhooks'), t('Cover with tests')],
    queries: ['idempotency key webhook best practices', 'postgres advisory locks'],
    commands: ['npm test', 'docker compose up -d db', 'psql -c "select count(*) from payments"', 'git status', 'curl -s http://localhost:3000/health'],
    greps: ['webhook', 'idempotencyKey', 'refund'],
  },
  {
    name: 'mobile-app',
    files: ['app/screens/Home.tsx', 'app/screens/Profile.tsx', 'app/navigation/index.tsx', 'app/services/api.ts', 'app.json'],
    prompts: [t('Build the profile screen with photo editing'), t('Navigation freezes when going back from details'), t('Add dark mode to the app')],
    tasks: [t('Profile screen'), t('Photo upload'), t('Fix navigation'), t('Dark theme')],
    queries: ['react native navigation goBack freeze', 'expo image picker permissions'],
    commands: ['npx expo start', 'npm test', 'git status', 'npm install react-native-reanimated'],
    greps: ['navigation.goBack', 'useTheme'],
  },
  {
    name: 'data-pipeline',
    files: ['pipelines/ingest.py', 'pipelines/transform.py', 'dags/daily_report.py', 'requirements.txt', 'tests/test_transform.py'],
    prompts: [t('The daily report has the wrong dates'), t('Deduplicate events on ingest'), t('Speed up the slow transform step')],
    tasks: [t('Check time zones'), t('Fix date parsing'), t('Deduplicate events'), t('Regression tests')],
    queries: ['pandas tz_convert daylight saving', 'airflow dag catchup false'],
    commands: ['pytest -q', 'python pipelines/ingest.py --dry-run', 'pip install -r requirements.txt', 'git status'],
    greps: ['tz_localize', 'drop_duplicates'],
  },
  {
    name: 'company-site',
    files: ['src/pages/index.astro', 'src/components/Hero.astro', 'src/content/blog/launch.md', 'astro.config.mjs', 'public/robots.txt'],
    prompts: [t('Add a testimonials section to the home page'), t('Improve SEO on the blog pages'), t('Add a contact form')],
    tasks: [t('Testimonials section'), t('Blog meta tags'), 'Sitemap', t('Contact form')],
    queries: ['astro sitemap integration', 'schema.org organization json-ld'],
    commands: ['npm run build', 'npm run dev', 'git status', 'npx lighthouse http://localhost:4321'],
    greps: ['<meta', 'description'],
  },
  {
    name: 'support-bot',
    files: ['bot/handlers/faq.ts', 'bot/llm/prompt.ts', 'bot/integrations/helpdesk.ts', 'bot/index.ts', 'tests/faq.test.ts'],
    prompts: [t("The bot doesn't hand off to a human"), t('Integrate the helpdesk API'), t('Make the answers shorter')],
    tasks: [t('Handoff rule'), t('Helpdesk client'), t('Tune the prompt'), t('Conversation tests')],
    queries: ['helpdesk tickets api create', 'llm handoff to human patterns'],
    commands: ['npm test', 'npm run dev', 'git status', 'git push'],
    greps: ['handoff', 'escalate'],
  },
];

/** The demo's providers, with badges (the server adds the ones it doesn't run; the browser's mock mode uses all). */
export const DEMO_PROVIDERS: readonly ProviderMeta[] = [
  { id: 'claude-code', label: 'Claude Code', color: '#d97757', capabilities: { transcript: false, approve: false, message: false, usage: false, subagents: true } },
  { id: 'gemini-cli', label: 'Gemini CLI', color: '#4285f4', capabilities: { transcript: false, approve: false, message: false, usage: false, subagents: true } },
  { id: 'codex', label: 'Codex', color: '#10a37f', capabilities: { transcript: false, approve: false, message: false, usage: false, subagents: true } },
  { id: 'custom:demo', label: 'Custom agent', color: '#a77bf3', capabilities: { transcript: false, approve: false, message: false, usage: false, subagents: false } },
];

/** Who opens new sessions: provider and its share (out of 100). */
const PROVIDER_SHARES: Array<[ProviderId, number]> = [
  ['claude-code', 40],
  ['gemini-cli', 25],
  ['codex', 20],
  ['custom:demo', 15],
];

const MODELS: Record<string, string[]> = {
  'claude-code': ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'],
  'gemini-cli': ['gemini-3.8-flash', 'gemini-3.8-pro'],
  codex: ['gpt-5.3-codex', 'gpt-5.1-codex-mini'],
  'custom:demo': ['llama-4-70b', 'qwen-3-coder'],
};

const SUB_ROLES: Record<string, string[]> = {
  'claude-code': ['Explore', 'general-purpose', 'Plan', 'code-reviewer'],
  'gemini-cli': ['generalist', 'codebase_investigator'],
  codex: ['explorer', 'worker', 'reviewer'],
};

const SUB_TASKS = [
  t('Map the files involved'),
  t('Review the existing code'),
  t('Search the documentation'),
  t('Run the test suite'),
  t('Find the cause of the bug'),
  t('Propose an implementation plan'),
  t('Check test coverage'),
  t('Read the error logs'),
];

/** Commands agents leave running in the background (and end the turn waiting for them). */
const BACKGROUND_JOBS: Array<{ description: string; command: string }> = [
  { description: t('Run the test suite'), command: 'npm test -- --runInBand' },
  { description: t('Production build'), command: 'npm run build -- --mode production' },
  { description: t('Database migration'), command: 'npm run db:migrate && npm run db:seed' },
  { description: t('Integration tests'), command: 'pytest -q tests/integration' },
  { description: t('Start the containers'), command: 'docker compose up --build --wait' },
  { description: t('End-to-end tests'), command: 'npx playwright test' },
];
/** Long foreground commands (the agent sits waiting for the result). */
const FOREGROUND_JOBS: Array<{ description: string; command: string }> = [
  { description: t('Install the dependencies'), command: 'npm ci' },
  { description: t('Run the module tests'), command: 'npm test -- src/api' },
  { description: t('Compile the project'), command: 'npm run build' },
];

const SHELL_CHANCE = 0.35;
const FOREGROUND_CHANCE = 0.07;
const SHELL_FAIL_CHANCE = 0.15;
const DENY_CHANCE = 0.2;
/** A turn ends with a GitHub step (PR, merge, CI) this often. */
const GITHUB_CHANCE = 0.12;
/** Agents without a PID are checked by heartbeat: the demo sends one this often. */
const HEARTBEAT_MS = 30_000;

type ToolKind = 'read' | 'edit' | 'write' | 'grep' | 'glob' | 'shell' | 'search' | 'fetch' | 'plan' | 'delegate' | 'ask';

/** A tool call in the provider's own vocabulary. */
function toolFor(provider: ProviderId, kind: ToolKind, arg: string, extra: Record<string, unknown> = {}): { name: string; input: Record<string, unknown> } {
  const table: Record<string, Record<ToolKind, [string, string]>> = {
    'claude-code': {
      read: ['Read', 'file_path'], edit: ['Edit', 'file_path'], write: ['Write', 'file_path'], grep: ['Grep', 'pattern'], glob: ['Glob', 'pattern'],
      shell: ['Bash', 'command'], search: ['WebSearch', 'query'], fetch: ['WebFetch', 'url'], plan: ['TodoWrite', 'todos'], delegate: ['Agent', 'description'], ask: ['AskUserQuestion', 'questions'],
    },
    'gemini-cli': {
      read: ['read_file', 'file_path'], edit: ['replace', 'file_path'], write: ['write_file', 'file_path'], grep: ['grep_search', 'pattern'], glob: ['glob', 'pattern'],
      shell: ['run_shell_command', 'command'], search: ['google_web_search', 'query'], fetch: ['web_fetch', 'prompt'], plan: ['update_topic', 'topic'], delegate: ['invoke_agent', 'prompt'], ask: ['ask_user', 'question'],
    },
    // Codex 0.164 reads and searches through its shell tool (docs/providers/codex.md)
    codex: {
      read: ['exec_command', 'cmd'], edit: ['apply_patch', 'command'], write: ['apply_patch', 'command'], grep: ['exec_command', 'cmd'], glob: ['exec_command', 'cmd'],
      shell: ['exec_command', 'cmd'], search: ['web_search', 'query'], fetch: ['web_search', 'query'], plan: ['update_goal', 'objective'], delegate: ['spawn_agent', 'message'], ask: ['request_user_input', 'question'],
    },
    'custom:demo': {
      read: ['read_file', 'path'], edit: ['edit_file', 'path'], write: ['write_file', 'path'], grep: ['search_code', 'query'], glob: ['find_files', 'pattern'],
      shell: ['run_command', 'command'], search: ['web_search', 'query'], fetch: ['fetch_url', 'url'], plan: ['update_plan', 'plan'], delegate: ['delegate', 'task'], ask: ['ask_user', 'question'],
    },
  };
  const [name, key] = (table[provider] ?? table['custom:demo']!)[kind];
  if (provider === 'codex') {
    const wrap: Partial<Record<ToolKind, (a: string) => string>> = {
      read: (a) => `sed -n '1,200p' ${a}`,
      grep: (a) => `rg -n "${a}"`,
      glob: (a) => `rg --files -g '${a}'`,
      edit: (a) => `*** Begin Patch\n*** Update File: ${a}\n*** End Patch`,
      write: (a) => `*** Begin Patch\n*** Add File: ${a}\n*** End Patch`,
    };
    const value = wrap[kind]?.(arg) ?? arg;
    const input: Record<string, unknown> = { [key]: value, ...extra };
    // the demo's own fields (command for shells) map to Codex's
    if (kind === 'shell' && typeof extra.command === 'string') input.cmd = extra.command;
    return { name, input };
  }
  return { name, input: { [key]: arg, ...extra } };
}

type Phase = 'working' | 'waiting' | 'idle' | 'delegating' | 'shell' | 'leaving';

interface SimAgent {
  provider: ProviderId;
  session: string;
  /** Subagent id inside the session; absent = the main agent. */
  agent?: string;
  parent?: SimAgent;
  project: DemoProject;
  rng: () => number;
  phase: Phase;
  phaseUntil: number;
  nextActionAt: number;
  actionsLeft: number;
  children: SimAgent[];
  closeAt: number;
  tasks: EventTask[];
  /** Background jobs: id → end time and outcome. */
  jobs: Map<string, { at: number; ok: boolean }>;
  /** A tool waiting for its end (a permission or a long foreground command). */
  pendingTool?: { id: string; name: string; endAt: number; deny?: boolean };
  shelledThisTurn: boolean;
  foregroundThisTurn: boolean;
  model: string;
  lastBeatAt: number;
  done: boolean;
  seq: number;
}

export interface DemoOptions {
  seed?: number;
  /** Speed multiplier (2 = everything happens twice as fast). */
  speed?: number;
  /** How many main sessions to keep open (about). */
  sessions?: number;
}

export class DemoSimulator {
  private readonly rng: () => number;
  private readonly speed: number;
  private readonly target: number;
  private readonly tag: string;
  private agents: SimAgent[] = [];
  private pending: AgentEvent[] = [];
  private nextSpawnAt: number;
  private spawned = 0;

  constructor(opts: DemoOptions = {}, now = 0) {
    const seed = opts.seed ?? hash32(String(now));
    this.rng = mulberry32(seed);
    this.speed = opts.speed ?? 1;
    this.target = opts.sessions ?? 5;
    this.tag = (seed >>> 0).toString(36);
    // Start with a busy office: every provider present, two of them sharing a room, someone waiting for a shell.
    for (let i = 0; i < this.target - 1; i++) this.spawnSession(now, true);
    const first = this.agents[0];
    if (first) this.startBackgroundShells(first, now, true);
    this.nextSpawnAt = now + this.ms(20_000, 40_000);
  }

  /** Advances the simulation to `now` and returns the events since the last call. */
  tick(now: number): AgentEvent[] {
    if (now >= this.nextSpawnAt) {
      const open = this.agents.filter((a) => !a.agent && a.phase !== 'leaving').length;
      if (open < this.target) this.spawnSession(now, false);
      this.nextSpawnAt = now + this.ms(25_000, 70_000);
    }
    for (const a of [...this.agents]) this.step(a, now);
    // Agents without a process to probe stay present through heartbeats.
    for (const a of this.agents) {
      if (a.agent || a.phase === 'leaving' || now - a.lastBeatAt < HEARTBEAT_MS) continue;
      a.lastBeatAt = now;
      this.emit(a, 'heartbeat', now);
    }
    this.agents = this.agents.filter((a) => !(a.phase === 'leaving' || a.done));
    const out = this.pending;
    this.pending = [];
    return out;
  }

  // ---------------------------------------------------------------- sessions

  private spawnSession(now: number, warm: boolean): void {
    const k = this.spawned++;
    const open = new Set(this.agents.filter((a) => !a.agent).map((a) => a.project.name));
    // 35% of the time a second session joins an existing room.
    const reuse = open.size > 0 && this.rng() < 0.35;
    const candidates = PROJECTS.filter((p) => (reuse ? open.has(p.name) : !open.has(p.name)));
    let project = this.pick(candidates.length ? candidates : PROJECTS);
    // Opening: the second session shares the first one's room (two providers side by side).
    if (warm && k === 1 && this.agents[0]) project = this.agents[0].project;
    // Opening: one of each provider, then by share.
    const provider = warm && k < PROVIDER_SHARES.length ? PROVIDER_SHARES[k]![0] : this.pickProvider();
    const session = `demo-${this.tag}-${k + 1}`;
    const rng = mulberry32(hash32(session));
    const a: SimAgent = {
      provider,
      session,
      project,
      rng,
      phase: 'idle',
      phaseUntil: now + (warm ? this.ms(0, 8_000) : this.ms(2_000, 5_000)),
      nextActionAt: now,
      actionsLeft: 0,
      children: [],
      closeAt: now + this.ms(150_000, 420_000),
      tasks: project.tasks.slice(0, 3 + Math.floor(rng() * 2)).map((title, i) => ({ id: String(i + 1), title, status: 'pending' })),
      jobs: new Map(),
      shelledThisTurn: false,
      foregroundThisTurn: false,
      model: this.pick(MODELS[provider] ?? MODELS['custom:demo']!, rng),
      lastBeatAt: now,
      done: false,
      seq: 0,
    };
    this.agents.push(a);
    this.emit(a, 'session.start', now, { title: this.pick(project.prompts, rng) });
    this.emit(a, 'tasks', now, { tasks: a.tasks.map((x) => ({ ...x })) });
  }

  private spawnSub(parent: SimAgent, now: number): void {
    const agent = `sub-${++parent.seq}`;
    const rng = mulberry32(hash32(`${parent.session}:${agent}`));
    const sub: SimAgent = {
      provider: parent.provider,
      session: parent.session,
      agent,
      parent,
      project: parent.project,
      rng,
      phase: 'working',
      phaseUntil: now + this.ms(18_000, 55_000),
      nextActionAt: now + this.ms(1_500, 3_000),
      actionsLeft: 99,
      children: [],
      closeAt: Infinity,
      tasks: [],
      jobs: new Map(),
      shelledThisTurn: true,
      foregroundThisTurn: true,
      model: parent.model,
      lastBeatAt: now,
      done: false,
      seq: 0,
    };
    this.agents.push(sub);
    parent.children.push(sub);
    const roles = SUB_ROLES[parent.provider] ?? ['worker'];
    const title = this.pick(SUB_TASKS, rng);
    this.emit(sub, 'subagent.start', now, { subagent: { role: this.pick(roles, rng), title, background: rng() < 0.3 } });
    this.emit(sub, 'turn.start', now, { prompt: title });
  }

  // ---------------------------------------------------------------- behavior

  private step(a: SimAgent, now: number): void {
    if (a.done) return;
    if (a.agent) return this.stepSub(a, now);
    // The session ends (only when idle, like a user closing the terminal).
    if (now >= a.closeAt && a.phase === 'idle') {
      a.phase = 'leaving';
      this.emit(a, 'session.end', now);
      return;
    }
    switch (a.phase) {
      case 'idle':
        if (now < a.phaseUntil) break;
        this.startTurn(a, now, this.pick(a.project.prompts, a.rng));
        break;
      case 'waiting':
        if (a.pendingTool && now >= a.pendingTool.endAt) {
          const p = a.pendingTool;
          delete a.pendingTool;
          this.emit(a, 'tool.end', now, { tool: p.deny ? { id: p.id, name: p.name, ok: false, error: 'denied' } : { id: p.id, name: p.name, ok: true } });
          a.phase = 'working';
          a.nextActionAt = now + this.ms(800, 1_500);
        }
        break;
      case 'delegating':
        if (a.children.every((c) => c.done)) {
          a.children = [];
          a.phase = 'working';
          a.nextActionAt = now + this.ms(2_000, 4_000);
        }
        break;
      case 'shell': {
        // A background shell ends: the notification wakes the agent, which reads the result and works a bit more.
        const due = [...a.jobs].filter(([, j]) => j.at <= now);
        if (!due.length) break;
        for (const [id, j] of due) this.finishJob(a, id, j.ok, now);
        this.startTurn(a, now, undefined, 1 + Math.floor(a.rng() * 3));
        break;
      }
      case 'working': {
        if (now < a.nextActionAt) break;
        if (a.pendingTool) {
          const p = a.pendingTool;
          delete a.pendingTool;
          this.emit(a, 'tool.end', now, { tool: { id: p.id, name: p.name, ok: true } });
        }
        for (const [id, j] of [...a.jobs]) if (j.at <= now) this.finishJob(a, id, j.ok, now);
        if (a.actionsLeft <= 0) {
          if (a.jobs.size) {
            this.emit(a, 'turn.end', now);
            a.phase = 'shell';
            break;
          }
          if (!a.shelledThisTurn && a.rng() < SHELL_CHANCE) {
            this.startBackgroundShells(a, now, false);
            break;
          }
          if (a.rng() < GITHUB_CHANCE) this.github(a, now);
          this.advanceTask(a, 'completed', now);
          this.emit(a, 'turn.end', now);
          a.phase = 'idle';
          a.phaseUntil = now + this.ms(20_000, 75_000);
          break;
        }
        a.actionsLeft--;
        const roll = a.rng();
        if (roll < 0.1) this.askPermission(a, now);
        else if (roll < 0.2 && a.children.length === 0 && SUB_ROLES[a.provider]) this.delegate(a, now);
        else if (roll < 0.2 + FOREGROUND_CHANCE && !a.foregroundThisTurn && a.actionsLeft > 0) this.startForeground(a, now);
        else this.randomTool(a, now);
        break;
      }
      case 'leaving':
        break;
    }
  }

  private stepSub(a: SimAgent, now: number): void {
    if (now >= a.phaseUntil) {
      a.done = true;
      this.emit(a, 'subagent.end', now);
      return;
    }
    if (now >= a.nextActionAt) {
      this.randomTool(a, now);
      a.nextActionAt = now + this.ms(1_500, 4_500);
    }
  }

  private startTurn(a: SimAgent, now: number, prompt: string | undefined, actions = 5 + Math.floor(a.rng() * 9)): void {
    a.phase = 'working';
    a.shelledThisTurn = false;
    a.foregroundThisTurn = false;
    a.actionsLeft = actions;
    a.nextActionAt = now + this.ms(1_200, 2_500);
    this.emit(a, 'turn.start', now, prompt ? { prompt, title: prompt } : {});
    if (prompt) this.advanceTask(a, 'in_progress', now);
  }

  private askPermission(a: SimAgent, now: number): void {
    const question = a.rng() < 0.3;
    const file = `${ROOT}/${a.project.name}/${this.pick(a.project.files, a.rng)}`;
    const call = question ? toolFor(a.provider, 'ask', t('Which approach do you prefer?')) : toolFor(a.provider, 'write', file);
    const id = this.toolStart(a, call.name, call.input, now);
    a.phase = 'waiting';
    a.pendingTool = { id, name: call.name, endAt: now + this.ms(8_000, 25_000), deny: !question && a.rng() < DENY_CHANCE };
    this.emit(a, 'waiting', now, { waiting: question ? { reason: 'question' } : { reason: 'permission', text: t('Confirm write: {0}', [file.split('/').pop()]) } });
  }

  private delegate(a: SimAgent, now: number): void {
    const count = 2 + Math.floor(a.rng() * 3);
    const call = toolFor(a.provider, 'delegate', t('{0} tracks in parallel', [count]), a.provider === 'claude-code' ? { subagent_type: 'general-purpose' } : {});
    const id = this.toolStart(a, call.name, call.input, now);
    for (let i = 0; i < count; i++) this.spawnSub(a, now);
    a.phase = 'delegating';
    a.pendingTool = { id, name: call.name, endAt: now };
  }

  private randomTool(a: SimAgent, now: number): void {
    const p = a.project;
    const r = a.rng();
    const file = `${ROOT}/${p.name}/${this.pick(p.files, a.rng)}`;
    let call;
    if (r < 0.26) call = toolFor(a.provider, 'read', file);
    else if (r < 0.44) call = toolFor(a.provider, 'edit', file);
    else if (r < 0.5) call = toolFor(a.provider, 'write', file);
    else if (r < 0.62) call = toolFor(a.provider, 'grep', this.pick(p.greps, a.rng));
    else if (r < 0.66) call = toolFor(a.provider, 'glob', '**/*.ts');
    else if (r < 0.84) call = toolFor(a.provider, 'shell', this.pick(p.commands, a.rng));
    else if (r < 0.9) call = toolFor(a.provider, 'search', this.pick(p.queries, a.rng));
    else if (r < 0.93) call = toolFor(a.provider, 'fetch', 'https://developer.mozilla.org/en-US/docs/Web');
    else call = toolFor(a.provider, 'plan', '');
    const id = this.toolStart(a, call.name, call.input, now);
    // A failure now and then (a red bubble).
    const ok = a.rng() > 0.05;
    this.emit(a, 'tool.end', now, { tool: ok ? { id, name: call.name, ok } : { id, name: call.name, ok, error: 'error' } });
    this.emit(a, 'usage', now, { tokens: { in: 200 + Math.floor(a.rng() * 2_000), cached: Math.floor(a.rng() * 20_000), out: 50 + Math.floor(a.rng() * 600) } });
    a.nextActionAt = now + this.ms(1_800, 5_500);
  }

  /** A GitHub step at the end of a turn (room effects, P6-04): open or merge a PR, or watch CI (red now and then). */
  private github(a: SimAgent, now: number): void {
    const pr = 10 + Math.floor(a.rng() * 290);
    const r = a.rng();
    const command = r < 0.35 ? 'gh pr create --fill' : r < 0.7 ? `gh pr merge ${pr} --squash` : `gh pr checks ${pr} --watch`;
    const ok = r < 0.7 || a.rng() >= 0.4;
    const call = toolFor(a.provider, 'shell', command, { command });
    const id = this.toolStart(a, call.name, call.input, now);
    this.emit(a, 'tool.end', now, { tool: ok ? { id, name: call.name, ok } : { id, name: call.name, ok, error: 'exit 1' } });
  }

  private startForeground(a: SimAgent, now: number): void {
    const spec = this.pick(FOREGROUND_JOBS, a.rng);
    const call = toolFor(a.provider, 'shell', spec.command, { description: spec.description });
    const id = this.toolStart(a, call.name, call.input, now);
    a.foregroundThisTurn = true;
    a.nextActionAt = now + this.ms(15_000, 40_000);
    a.pendingTool = { id, name: call.name, endAt: a.nextActionAt };
  }

  /**
   * Leaves 1 (or 2) commands running in the background and ends the turn waiting for them. `warm` = the office is
   * opening: the shell has been running for a while.
   */
  private startBackgroundShells(a: SimAgent, now: number, warm: boolean): void {
    const count = a.rng() < 0.25 ? 2 : 1;
    const specs = BACKGROUND_JOBS.slice();
    if (warm) this.emit(a, 'turn.start', now, { prompt: this.pick(a.project.prompts, a.rng) });
    for (let i = 0; i < count; i++) {
      const spec = specs.splice(Math.floor(a.rng() * specs.length), 1)[0]!;
      const call = toolFor(a.provider, 'shell', spec.command, { description: spec.description, ...(a.provider === 'gemini-cli' ? { is_background: true } : { run_in_background: true }) });
      const id = this.toolStart(a, call.name, call.input, now, true);
      this.emit(a, 'tool.end', now, { tool: { id, name: call.name, ok: true } });
      const jobId = `job-${a.session}-${++a.seq}`;
      a.jobs.set(jobId, { at: now + this.ms(40_000, 150_000), ok: a.rng() >= SHELL_FAIL_CHANCE });
      this.emit(a, 'job.start', now, { job: { id: jobId, label: spec.description, command: spec.command } });
    }
    a.shelledThisTurn = true;
    if (!warm) this.advanceTask(a, 'completed', now);
    this.emit(a, 'turn.end', now);
    a.phase = 'shell';
  }

  private finishJob(a: SimAgent, id: string, ok: boolean, now: number): void {
    a.jobs.delete(id);
    this.emit(a, 'job.end', now, { job: ok ? { id } : { id, ok: false } });
  }

  private advanceTask(a: SimAgent, status: 'in_progress' | 'completed', now: number): void {
    if (!a.tasks.length) return;
    if (status === 'in_progress') {
      const next = a.tasks.find((x) => x.status === 'pending');
      if (!next || a.tasks.some((x) => x.status === 'in_progress')) return;
      next.status = 'in_progress';
    } else {
      const cur = a.tasks.find((x) => x.status === 'in_progress');
      if (!cur) return;
      cur.status = 'completed';
    }
    this.emit(a, 'tasks', now, { tasks: a.tasks.map((x) => ({ ...x })) });
  }

  // ---------------------------------------------------------------- helpers

  private toolStart(a: SimAgent, name: string, input: Record<string, unknown>, now: number, background = false): string {
    const id = `${a.agent ?? 'main'}-${++a.seq}`;
    this.emit(a, 'tool.start', now, { tool: background ? { id, name, input, background } : { id, name, input } });
    return id;
  }

  private emit(a: SimAgent, type: AgentEventType, at: number, extra: Partial<AgentEvent> = {}): void {
    const e: AgentEvent = { v: 1, provider: a.provider, account: 'demo', session: a.session, cwd: `${ROOT}/${a.project.name}`, at, type, model: a.model, ...extra };
    if (a.agent) e.agent = a.agent;
    if (a.parent?.agent) e.parentAgent = a.parent.agent;
    this.pending.push(e);
  }

  private pickProvider(): ProviderId {
    let r = this.rng() * 100;
    for (const [id, share] of PROVIDER_SHARES) {
      if ((r -= share) < 0) return id;
    }
    return 'claude-code';
  }

  private ms(min: number, max: number): number {
    return (min + this.rng() * (max - min)) / this.speed;
  }

  private pick<T>(arr: readonly T[], rng = this.rng): T {
    return arr[Math.floor(rng() * arr.length)]!;
  }
}
