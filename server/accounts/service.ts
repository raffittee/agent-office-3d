// Ported from habblaud server/accounts/{service,statusline,detect}.ts (MIT, © 2026 Márcio Junior)
// The accounts in OfficeSnapshot.accounts (P5-04): one per provider config folder the adapters watch, plus any account
// that has open sessions. Plan usage comes only from local files the tools (or our taps) write:
// - Claude Code: <dataDir>/usage/claude-code-<account>.json, written by hooks/statusline-tap.mjs from the
//   `rate_limits` Claude Code hands its statusline;
// - Codex: `token_count.rate_limits` in its rollouts (the adapter passes them on).
// Identity: from a Claude config's `.claude.json`, ONLY oauthAccount.emailAddress and organizationName. Nothing else
// is read; no credentials, no network.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { AccountInfo, AccountUsage, ProviderId, ProviderMeta, UsageWindow } from '../../shared/protocol';

/** An account an adapter knows about. */
export interface ProviderAccount {
  id: string;
  /** The config folder (for the name, and Claude's identity file). Never sent to the browser. */
  dir?: string;
  usage?: AccountUsage;
  plan?: string;
}

/** Usage older than this shows as stale. */
export const STALE_MS = 30 * 60_000;
const USAGE_FILE = /^([a-z0-9:-]+)-([0-9a-z]{1,40})\.json$/;
const MAX_USAGE_FILE = 64 * 1024;
const IDENTITY_REFRESH_MS = 60_000;

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Seconds or milliseconds or an ISO date → epoch ms. */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return toEpochMs(n);
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

function window(raw: unknown): UsageWindow | undefined {
  const w = rec(raw);
  const u = w?.utilization ?? w?.used_percentage ?? w?.used_percent;
  const n = typeof u === 'string' ? Number(u) : u;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  const out: UsageWindow = { utilization: Math.min(100, Math.max(0, n)) };
  const resets = toEpochMs(w?.resets_at);
  if (resets !== undefined) out.resetsAt = resets;
  return out;
}

/** A tap file → (provider, account, usage). */
export function parseUsageFile(raw: string, now: number): { provider: string; account: string; usage: AccountUsage } | undefined {
  let j: Record<string, unknown> | undefined;
  try {
    j = rec(JSON.parse(raw));
  } catch {
    return undefined;
  }
  const provider = str(j?.provider);
  const account = str(j?.account);
  const fetched = toEpochMs(j?.fetchedAt);
  if (!j || !provider || !account || !/^[0-9a-z]{1,40}$/.test(account) || fetched === undefined) return undefined;
  const usage: AccountUsage = { source: 'statusline', fetchedAt: Math.min(now, fetched) };
  const five = window(j.five_hour);
  const week = window(j.seven_day);
  if (five) usage.fiveHour = five;
  if (week) usage.sevenDay = week;
  return five || week ? { provider, account, usage } : undefined;
}

/** Codex rate limits (adapter form) → AccountUsage: 300-minute window = 5 h, 10080 = the week. */
export function usageFromCodex(limits: { windows: { minutes: number; usedPercent: number; resetsAt?: number }[]; reached?: string }, at: number): AccountUsage {
  const usage: AccountUsage = { source: 'codex', fetchedAt: at };
  for (const w of limits.windows) {
    const win: UsageWindow = { utilization: w.usedPercent, ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}) };
    if (w.minutes === 300) usage.fiveHour ??= win;
    else if (w.minutes === 10080) usage.sevenDay ??= win;
  }
  if (limits.reached) usage.noQuota = true;
  return usage;
}

/** "Name's Organization" is Claude's default name for a personal org: not worth showing. */
export function meaningfulOrganization(org: string | undefined, email: string | undefined): string | undefined {
  if (!org) return undefined;
  const generic = /^(.+?)['’]s organi[sz]ation$/i.exec(org.trim());
  if (generic && (!email || generic[1]!.trim().toLowerCase() === email.trim().toLowerCase() || generic[1]!.includes('@'))) return undefined;
  return org;
}

/**
 * Email and organization of a Claude config folder: `$HOME/.claude.json` for the default folder (`~/.claude`),
 * `<dir>/.claude.json` otherwise. Only those two fields are kept.
 */
export function claudeIdentity(dir: string, home: string): { email?: string; organization?: string } {
  const isDefault = resolve(dir) === resolve(home, '.claude');
  for (const file of isDefault ? [join(home, '.claude.json'), join(dir, '.claude.json')] : [join(dir, '.claude.json')]) {
    try {
      const profile = rec(rec(JSON.parse(readFileSync(file, 'utf8')))?.oauthAccount);
      const email = str(profile?.emailAddress);
      const organization = meaningfulOrganization(str(profile?.organizationName), email);
      if (email || organization) return { ...(email ? { email } : {}), ...(organization ? { organization } : {}) };
    } catch {
      // missing or unreadable: try the next
    }
  }
  return {};
}

const PROVIDER_SHORT: Record<string, string> = { 'claude-code': 'C', 'gemini-cli': 'G', codex: 'X' };

export interface AccountsServiceOptions {
  usageDir: string;
  home: string;
  /** The adapters' accounts and badges. */
  providers: () => ProviderMeta[];
  accountsOf: (provider: ProviderId) => ProviderAccount[];
  /** Demo mode: made-up usage for the simulated accounts. */
  extraUsage?: (provider: ProviderId, account: string, now: number) => AccountUsage | undefined;
  now?: () => number;
}

/** Demo mode's usage: fixed, clearly labelled made-up numbers per provider (source 'demo'). */
export function demoUsage(provider: ProviderId, account: string, now: number): AccountUsage | undefined {
  if (account !== 'demo') return undefined;
  const pct: Record<string, [number, number]> = { 'claude-code': [42, 18], codex: [67, 31] };
  const p = pct[provider];
  if (!p) return undefined;
  const hour = 3_600_000;
  return { source: 'demo', fetchedAt: now, fiveHour: { utilization: p[0], resetsAt: now + 2.5 * hour }, sevenDay: { utilization: p[1], resetsAt: now + 4 * 24 * hour } };
}

/** Builds OfficeSnapshot.accounts. Reads small files at most every few seconds; never throws. */
export class AccountsService {
  private usageCache = new Map<string, { mtimeMs: number; size: number; parsed?: ReturnType<typeof parseUsageFile> }>();
  private identities = new Map<string, { at: number; email?: string; organization?: string }>();
  private readonly now: () => number;

  constructor(private readonly opts: AccountsServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Usage written by the taps, by `${provider}|${account}`. */
  tapUsage(): Map<string, AccountUsage> {
    const out = new Map<string, AccountUsage>();
    let names: string[] = [];
    try {
      names = readdirSync(this.opts.usageDir);
    } catch {
      return out;
    }
    const now = this.now();
    for (const name of names) {
      if (!USAGE_FILE.test(name)) continue;
      const file = join(this.opts.usageDir, name);
      try {
        const st = statSync(file);
        if (!st.isFile() || st.size > MAX_USAGE_FILE) continue;
        let c = this.usageCache.get(file);
        if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
          c = { mtimeMs: st.mtimeMs, size: st.size, parsed: parseUsageFile(readFileSync(file, 'utf8'), now) };
          this.usageCache.set(file, c);
        }
        if (c.parsed) out.set(`${c.parsed.provider}|${c.parsed.account}`, c.parsed.usage);
      } catch {
        // a file being replaced: next round
      }
    }
    return out;
  }

  private identity(dir: string): { email?: string; organization?: string } {
    const now = this.now();
    let id = this.identities.get(dir);
    if (!id || now - id.at > IDENTITY_REFRESH_MS) {
      id = { at: now, ...claudeIdentity(dir, this.opts.home) };
      this.identities.set(dir, id);
    }
    return id;
  }

  /** Changes when any account's usage does (for refreshing snapshots between events). */
  usageKey(): string {
    const parts: string[] = [];
    for (const [k, u] of this.tapUsage()) parts.push(`${k}:${u.fetchedAt}`);
    for (const p of this.opts.providers()) for (const a of this.opts.accountsOf(p.id)) if (a.usage) parts.push(`${p.id}|${a.id}:${a.usage.fetchedAt}`);
    return parts.sort().join(',');
  }

  /** The accounts for a snapshot, given the open sessions per `${provider}|${account}`. */
  accounts(sessions: ReadonlyMap<string, number>): AccountInfo[] {
    const now = this.now();
    const taps = this.tapUsage();
    const out: AccountInfo[] = [];
    for (const p of this.opts.providers()) {
      const known = new Map<string, ProviderAccount>();
      try {
        for (const a of this.opts.accountsOf(p.id)) known.set(a.id, a);
      } catch {
        // an adapter failing to list never hides the others
      }
      for (const key of sessions.keys()) {
        const [prov, acc] = key.split('|');
        if (prov === p.id && acc && !known.has(acc)) known.set(acc, { id: acc });
      }
      const list = [...known.values()].sort((a, b) => (a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.id.localeCompare(b.id)));
      list.forEach((a, i) => {
        const open = sessions.get(`${p.id}|${a.id}`) ?? 0;
        const usage = taps.get(`${p.id}|${a.id}`) ?? a.usage ?? this.opts.extraUsage?.(p.id, a.id, now);
        // accounts without sessions or usage stay out of the way
        if (!open && !usage) return;
        const ident = p.id === 'claude-code' && a.dir ? this.identity(a.dir) : {};
        const folder = a.dir && a.id !== 'default' ? basename(a.dir) : undefined;
        const info: AccountInfo = {
          id: a.id,
          provider: p.id,
          short: `${PROVIDER_SHORT[p.id] ?? p.id.replace(/^custom:/, '').slice(0, 1).toUpperCase()}${i ? i + 1 : ''}`,
          name: ident.email ?? (folder ? `${p.label} (${folder})` : p.label),
          color: p.color,
          sessions: open,
          usageStatus: usage ? (now - usage.fetchedAt > STALE_MS ? 'stale' : 'ok') : 'disabled',
        };
        if (ident.email) info.email = ident.email;
        if (ident.organization) info.organization = ident.organization;
        if (a.plan) info.plan = a.plan;
        if (usage) info.usage = usage;
        out.push(info);
      });
    }
    return out;
  }
}
