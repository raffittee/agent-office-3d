// Ported from habblaud server/sources/subagents.ts (MIT, © 2026 Márcio Junior)
// A session's subagent files:
//   <project>/<sessionId>/subagents/agent-<agentId>.jsonl (+ .meta.json)
//   <project>/<sessionId>/subagents/workflows/<runId>/agent-<agentId>.jsonl (+ .meta.json, journal.jsonl)
// Checked against a real capture (2.1.310, test/fixtures/claude-code/subagent/): the meta also carries `model`,
// `isBuiltIn`, `requestNonInteractive` and, once the subagent hands back, `finished: true`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { t } from '../../../shared/i18n';

export interface SubagentFile {
  agentId: string;
  path: string;
  metaPath: string;
  /** Workflow run that owns the subagent (folder subagents/workflows/<runId>/). */
  runId?: string;
}

export interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  requestShape?: string;
  workflowPhase?: string;
  model?: string;
  /** Written when the subagent hands its result back (2.1.310). */
  finished?: boolean;
}

/** No writes for 5 s after an end_turn: finished. */
export const END_TURN_QUIET_MS = 5_000;
/** No writes for 120 s: finished (or stuck). */
export const IDLE_TIMEOUT_MS = 120_000;
/** With a tool in progress (a long command, say), wait longer before giving up. */
export const PENDING_TOOL_TIMEOUT_MS = 600_000;
/** At boot, only subagents written in the last 90 s come in. */
export const BOOT_RECENT_MS = 90_000;

const AGENT_FILE = /^agent-([\w-]+)\.jsonl$/;

/** The session's data folder (sibling of the transcript <sessionId>.jsonl). */
export function sessionDirOf(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, '');
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function listSubagentFiles(sessionDir: string): SubagentFile[] {
  const out: SubagentFile[] = [];
  const base = join(sessionDir, 'subagents');
  const collect = (dir: string, runId?: string) => {
    for (const name of listDir(dir)) {
      const m = AGENT_FILE.exec(name);
      if (!m) continue;
      const file: SubagentFile = { agentId: m[1]!, path: join(dir, name), metaPath: join(dir, `agent-${m[1]}.meta.json`) };
      if (runId) file.runId = runId;
      out.push(file);
    }
  };
  collect(base);
  for (const runId of listDir(join(base, 'workflows'))) collect(join(base, 'workflows', runId), runId);
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function parseSubagentMeta(raw: string): SubagentMeta | undefined {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return undefined;
    const meta: SubagentMeta = {};
    for (const k of ['agentType', 'description', 'toolUseId', 'requestShape', 'workflowPhase', 'model'] as const) {
      const v = str(j[k]);
      if (v) meta[k] = v;
    }
    if (typeof j.spawnDepth === 'number') meta.spawnDepth = j.spawnDepth;
    if (j.finished === true) meta.finished = true;
    return meta;
  } catch {
    return undefined;
  }
}

export function readSubagentMeta(metaPath: string): SubagentMeta | undefined {
  try {
    return parseSubagentMeta(readFileSync(metaPath, 'utf8'));
  } catch {
    return undefined;
  }
}

export interface JournalAgent {
  label?: string;
  done: boolean;
}

const JOURNAL_DONE = /^(completed?|finished|done|failed|errored|error|killed|cancell?ed|stopped|succeeded|result)$/i;

/** A workflow's journal.jsonl: each agent's label and which ones have finished. */
export function parseJournal(text: string): Map<string, JournalAgent> {
  const out = new Map<string, JournalAgent>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const agentId = str(j.agentId);
    const type = str(j.type);
    if (!agentId || !type) continue;
    const cur = out.get(agentId) ?? { done: false };
    const label = str(j.label);
    if (label) cur.label = label;
    if (JOURNAL_DONE.test(type)) cur.done = true;
    out.set(agentId, cur);
  }
  return out;
}

/** The role shown for the subagent. */
export function subagentRole(meta: SubagentMeta | undefined, spawnType?: string): string {
  const type = meta?.agentType ?? spawnType;
  if (!type) return t('Subagent');
  if (type === 'workflow-subagent') return 'Workflow';
  return type;
}

export interface IdleCheck {
  now: number;
  lastWriteAt: number;
  /** The subagent's last message ended its turn (end_turn, or a tool that ends the turn, like SubagentHandback). */
  ended: boolean;
  /** A tool was called and has no result yet. */
  pendingTool: boolean;
}

/** Finished by inactivity: end of turn + 5 s of quiet, or a long quiet. */
export function concludedByIdle(c: IdleCheck): boolean {
  const quiet = c.now - c.lastWriteAt;
  if (c.ended && !c.pendingTool && quiet >= END_TURN_QUIET_MS) return true;
  return quiet >= (c.pendingTool ? PENDING_TOOL_TIMEOUT_MS : IDLE_TIMEOUT_MS);
}
