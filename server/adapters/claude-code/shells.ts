// Ported from habblaud server/sources/shells.ts (MIT, © 2026 Márcio Junior)
// Shells a session's agents are waiting for: background Bash/PowerShell (run_in_background, or sent to the background
// mid-run), foreground commands without a result yet, and Monitor. The adapter turns the background shells into
// job.start / job.end events.
//
// One tracker per session (main + subagents): the end notification of a shell started by a subagent can arrive in
// the main transcript, and vice versa. Jobs are keyed by the tool_use id; the background task id ("bo0ov3q3l")
// arrives in the tool_result.
//
// End: <task-notification> (queue-operation 'enqueue', user message or attachment) matching the task id or tool-use
// id; TaskStop/KillShell/KillBash with the id; end of turn / interruption (foreground only); /clear or session end
// (tracker dropped); age.
import type { JobOutcome } from '../../../shared/activity';
import type { ShellJob } from '../../../shared/protocol';

/** Jobs older than this are dropped (the process is surely dead, or the notification was lost). */
export const SHELL_MAX_AGE_MS = 24 * 3_600_000;
/** Registry "idle" + a background shell without notification for less than this = status 'shell' (old CLIs). */
export const SHELL_FALLBACK_MAX_AGE_MS = 12 * 3_600_000;
/** Monitor: expires by itself after timeout_ms (default 5 min, ceiling 1 h) + this grace. */
const MONITOR_DEFAULT_TIMEOUT_MS = 300_000;
const MONITOR_MAX_TIMEOUT_MS = 3_600_000;
const EXPIRY_GRACE_MS = 60_000;
/** Tolerance between the transcript's clock and the process start in the registry. */
const PROCESS_START_SLACK_MS = 2_000;
/** Ended ids kept (so re-reading the transcript or merging the file's start doesn't revive a job). */
const MAX_ENDED = 2_000;
/** A repeated notification (queue -> message) up to this long after the end is still "the same end". */
const RECENT_END_MS = 120_000;

/** A Bash/PowerShell/Monitor start seen in the transcript. */
export interface ShellStart {
  toolUseId: string;
  label: string;
  command?: string;
  /** run_in_background (Bash/PowerShell) or Monitor. */
  background: boolean;
  kind: 'shell' | 'monitor';
  /** Epoch ms of the tool_use. */
  at: number;
  /** Monitor's timeout_ms (expiry). */
  timeoutMs?: number;
}

export interface TrackedShell {
  owner: string;
  toolUseId: string;
  taskId?: string;
  label: string;
  command?: string;
  background: boolean;
  kind: 'shell' | 'monitor';
  /** Start shown (the real launch, once a background job's tool_result arrives). */
  startedAt: number;
  /** When the tool_use was written (basis of the "older than the current process" filter). */
  requestedAt: number;
  timeoutMs?: number;
  /** Foreground waiting for approval: hidden, and its clock doesn't run. */
  held?: boolean;
}

export interface ShellFinish {
  job: TrackedShell;
  outcome: JobOutcome;
  at: number;
  summary?: string;
}

export interface ShellRef {
  toolUseId?: string;
  taskId?: string;
}

const OK = /^(completed?|success|succeeded|done|finished|exited)$/i;
const FAILED = /^(failed|failure|error|errored|timeout|timed[_ -]?out)$/i;
const KILLED = /^(killed|stopped|cancell?ed|aborted|interrupted|terminated)$/i;

/**
 * Outcome of a notification: undefined = not terminal (a Monitor event, say). Without a status, a shell sends only one
 * notification (the end); a Monitor sends one per event.
 */
export function notificationOutcome(kind: 'shell' | 'monitor', status: string | undefined, summary: string | undefined): JobOutcome | undefined {
  const s = status?.trim();
  const exit = summary ? /exit code (-?\d+)/i.exec(summary)?.[1] : undefined;
  if (s && OK.test(s)) return exit !== undefined && exit !== '0' ? 'failed' : 'ok';
  if (s && FAILED.test(s)) return 'failed';
  if (s && KILLED.test(s)) return 'killed';
  if (s || kind === 'monitor') return undefined;
  if (summary && /\b(killed|stopped|interrupted|cancell?ed)\b/i.test(summary)) return 'killed';
  if (summary && /\bfailed\b/i.test(summary)) return 'failed';
  return exit !== undefined && exit !== '0' ? 'failed' : 'ok';
}

export class ShellTracker {
  private jobs = new Map<string, TrackedShell>();
  private taskToTool = new Map<string, string>();
  /** tool_use id / task id already ended -> when. */
  private ended = new Map<string, number>();
  /** Launches whose tool_use isn't in the window read (matched when the file's start is merged). */
  private orphanLaunches = new Map<string, { taskId?: string; at: number }>();
  /** Ids of shells whose end was already reported (notification/TaskStop) -> when. */
  private reported = new Map<string, number>();

  get size(): number {
    return this.jobs.size;
  }

  /** Bash/Monitor called. Ignores what already ended (re-reading the transcript). */
  start(owner: string, s: ShellStart): void {
    if (this.jobs.has(s.toolUseId) || this.ended.has(s.toolUseId)) return;
    const job: TrackedShell = {
      owner,
      toolUseId: s.toolUseId,
      label: s.label,
      background: s.background,
      kind: s.kind,
      startedAt: s.at,
      requestedAt: s.at,
    };
    if (s.command) job.command = s.command;
    if (s.timeoutMs !== undefined) job.timeoutMs = s.timeoutMs;
    this.jobs.set(s.toolUseId, job);
    const orphan = this.orphanLaunches.get(s.toolUseId);
    if (orphan) {
      this.orphanLaunches.delete(s.toolUseId);
      this.launch(job, orphan.taskId, orphan.at);
    }
  }

  /**
   * A Bash/Monitor tool_result. With a background task id (or if it was already in the background), the job waits for
   * the notification; otherwise (foreground finished, error, denial) it leaves the list.
   */
  result(toolUseId: string, opts: { taskId?: string; error: boolean; at: number }): void {
    const job = this.jobs.get(toolUseId);
    if (!job) {
      if (opts.taskId && !opts.error && !this.ended.has(toolUseId)) {
        this.orphanLaunches.set(toolUseId, { taskId: opts.taskId, at: opts.at });
        if (this.orphanLaunches.size > 256) this.orphanLaunches.delete(this.orphanLaunches.keys().next().value as string);
      }
      return;
    }
    if (opts.error || (!job.background && !opts.taskId)) {
      this.remove(job, opts.at);
      return;
    }
    this.launch(job, opts.taskId, opts.at);
  }

  private launch(job: TrackedShell, taskId: string | undefined, at: number): void {
    if (taskId && this.ended.has(taskId)) {
      this.remove(job, at);
      return;
    }
    // Requested in the background: it really starts at launch (after a possible approval). Sent to the background
    // mid-run (foreground): it keeps counting from the start.
    if (job.background) job.startedAt = Math.max(job.startedAt, at);
    job.background = true;
    delete job.held;
    if (taskId) {
      job.taskId = taskId;
      this.taskToTool.set(taskId, job.toolUseId);
    }
  }

  private find(ref: ShellRef): TrackedShell | undefined {
    if (ref.toolUseId) {
      const j = this.jobs.get(ref.toolUseId);
      if (j) return j;
    }
    if (ref.taskId) {
      const tool = this.taskToTool.get(ref.taskId);
      if (tool) return this.jobs.get(tool);
    }
    return undefined;
  }

  private markEnded(id: string | undefined, at: number): void {
    if (!id) return;
    this.ended.delete(id);
    this.ended.set(id, at);
    if (this.ended.size > MAX_ENDED) this.ended.delete(this.ended.keys().next().value as string);
  }

  private remove(job: TrackedShell, at: number): void {
    this.jobs.delete(job.toolUseId);
    if (job.taskId) this.taskToTool.delete(job.taskId);
    this.markEnded(job.toolUseId, at);
    this.markEnded(job.taskId, at);
  }

  /** <task-notification>: returns the end (once only) of a known job. */
  notify(ref: ShellRef & { status?: string; summary?: string; at: number }): ShellFinish | undefined {
    const job = this.find(ref);
    if (!job) {
      // Unknown (a subagent, or the tool_use was before the window read): remember it so it isn't revived.
      if (!ref.status || OK.test(ref.status) || FAILED.test(ref.status) || KILLED.test(ref.status)) {
        this.markEnded(ref.toolUseId, ref.at);
        this.markEnded(ref.taskId, ref.at);
      }
      return undefined;
    }
    const outcome = notificationOutcome(job.kind, ref.status, ref.summary);
    if (!outcome) return undefined;
    this.remove(job, ref.at);
    this.markReported(job, ref.at);
    const fin: ShellFinish = { job, outcome, at: ref.at };
    if (ref.summary) fin.summary = ref.summary;
    return fin;
  }

  private markReported(job: TrackedShell, at: number): void {
    for (const id of [job.toolUseId, job.taskId]) {
      if (!id) continue;
      this.reported.set(id, at);
      if (this.reported.size > 256) this.reported.delete(this.reported.keys().next().value as string);
    }
  }

  /** TaskStop/KillShell/KillBash accepted. */
  stop(taskId: string, at: number): ShellFinish | undefined {
    const job = this.find({ taskId, toolUseId: taskId });
    if (!job) {
      this.markEnded(taskId, at);
      return undefined;
    }
    this.remove(job, at);
    this.markReported(job, at);
    return { job, outcome: 'killed', at };
  }

  /** End of turn or interruption: no foreground command keeps running. */
  endForeground(owner: string | undefined, at: number): void {
    for (const job of [...this.jobs.values()]) if (!job.background && (owner === undefined || job.owner === owner)) this.remove(job, at);
  }

  /**
   * The session waits for approval (registry 'waiting'): foreground commands haven't started yet. They leave the
   * list, and their clock restarts when the wait ends.
   */
  holdForeground(waiting: boolean, now: number): void {
    for (const job of this.jobs.values()) {
      if (job.background) continue;
      if (waiting) {
        job.held = true;
        job.startedAt = Math.max(job.startedAt, now);
      } else delete job.held;
    }
  }

  /**
   * Was this shell's end reported a moment ago (the queue announced it, and now the same notification is delivered to
   * the agent)? Only for tracked shells (not subagents).
   */
  reportedRecently(ref: ShellRef, at: number): boolean {
    for (const id of [ref.toolUseId, ref.taskId]) {
      const t = id ? this.reported.get(id) : undefined;
      if (t !== undefined && Math.abs(at - t) <= RECENT_END_MS) return true;
    }
    return false;
  }

  /**
   * Drops what can't be running: over 24 h, older than the current Claude Code process (shells die with it, e.g. a
   * resumed session), and monitors past their own timeout.
   */
  prune(now: number, processStart?: number): boolean {
    let changed = false;
    for (const job of [...this.jobs.values()]) {
      let drop = now - job.requestedAt > SHELL_MAX_AGE_MS;
      if (processStart !== undefined && job.requestedAt < processStart - PROCESS_START_SLACK_MS) drop = true;
      if (job.kind === 'monitor') {
        const limit = Math.min(job.timeoutMs ?? MONITOR_DEFAULT_TIMEOUT_MS, MONITOR_MAX_TIMEOUT_MS);
        if (now - job.startedAt > limit + EXPIRY_GRACE_MS) drop = true;
      }
      if (drop) {
        this.remove(job, now);
        changed = true;
      }
    }
    return changed;
  }

  /** Is a background shell running (started less than `maxAgeMs` ago)? Monitors don't count (as in Claude Code). */
  hasBackgroundShell(now: number, maxAgeMs = SHELL_FALLBACK_MAX_AGE_MS): boolean {
    for (const job of this.jobs.values()) if (job.background && job.kind === 'shell' && now - job.startedAt < maxAgeMs) return true;
    return false;
  }

  /**
   * The registry (a version that writes "shell") says no background shell is running: what's left here missed its
   * notification. Drops the background shells (monitors aren't part of Claude Code's count).
   */
  dropBackgroundShells(now: number): boolean {
    let changed = false;
    for (const job of [...this.jobs.values()]) {
      if (!job.background || job.kind !== 'shell') continue;
      this.remove(job, now);
      changed = true;
    }
    return changed;
  }

  /** Visible jobs (without foreground ones waiting for approval), oldest first. */
  list(): TrackedShell[] {
    return [...this.jobs.values()].filter((j) => !j.held).sort((a, b) => a.startedAt - b.startedAt || a.toolUseId.localeCompare(b.toolUseId));
  }

  /**
   * Background jobs left open in the file's start (read after the end window): they come in, unless the window
   * already showed their end.
   */
  merge(jobs: readonly TrackedShell[]): boolean {
    let changed = false;
    for (const j of jobs) {
      if (!j.background || this.jobs.has(j.toolUseId) || this.ended.has(j.toolUseId) || (j.taskId && this.ended.has(j.taskId))) continue;
      const job: TrackedShell = { ...j };
      this.jobs.set(job.toolUseId, job);
      const orphan = this.orphanLaunches.get(job.toolUseId);
      if (orphan) {
        this.orphanLaunches.delete(job.toolUseId);
        this.launch(job, orphan.taskId, orphan.at);
      } else if (job.taskId) this.taskToTool.set(job.taskId, job.toolUseId);
      changed = true;
    }
    return changed;
  }

  /** Background jobs still open (to merge the file's start). */
  openBackground(): TrackedShell[] {
    return [...this.jobs.values()].filter((j) => j.background).map((j) => ({ ...j }));
  }
}

/** The published ShellJob (without the internal fields). */
export function toShellJob(j: TrackedShell): ShellJob {
  const job: ShellJob = { id: j.taskId ?? j.toolUseId, label: j.label, startedAt: j.startedAt, background: j.background, kind: j.kind };
  if (j.command) job.command = j.command;
  return job;
}
