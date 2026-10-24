// P8-02: an accelerated soak. Runs the demo simulator, the Office reducer and the client's simulation (pure core, no
// WebGL) on a simulated clock for many hours, as fast as the CPU allows. Every simulated hour it forces a GC and
// records the heap, the agents, rooms and the reducer's bookkeeping; every frame it times the sim's update. The
// report says whether memory stays flat and whether the sim's share of the frame budget holds.
//
//   node --expose-gc --import tsx scripts/soak.ts [--hours 8] [--sessions 15] [--seed 7] [--json out.json]
//
// The browser's own frame time (rendering included) needs a real GPU: use ?stats=1 there (docs/perf.md).
import { writeFileSync } from 'node:fs';
import { createMockOffice } from '../shared/demo/mock';
import { DEFAULT_WORLD_OPTIONS } from '../client/src/core/options';
import { Sim } from '../client/src/core/sim/sim';

export interface SoakSample {
  hour: number;
  heapMb: number;
  agents: number;
  rooms: number;
  chars: number;
  feed: number;
  /** The sim's update time per frame this hour, in ms: median and 99th percentile. */
  p50: number;
  p99: number;
}

export interface SoakReport {
  hours: number;
  sessions: number;
  frames: number;
  samples: SoakSample[];
  /** Heap growth from the second hour (after warm-up) to the end, in MB. */
  heapGrowthMb: number;
  peakAgents: number;
  /** Worst hourly p99 of the sim's update, in ms. */
  worstP99: number;
  wallSeconds: number;
}

const FRAME_MS = 1_000 / 30;
const OFFICE_EVERY = 8; // ~250 ms of simulated time

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

export function soak(opts: { hours: number; sessions: number; seed: number; gc?: () => void; onHour?: (s: SoakSample) => void }): SoakReport {
  const t0 = performance.now();
  const start = Date.UTC(2026, 9, 26, 9, 0, 0);
  let now = start;
  const mock = createMockOffice({ seed: opts.seed, sessions: opts.sessions }, now);
  const sim = new Sim({ options: () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'lively' }) });
  sim.applySnapshot(mock.office.commit().snapshot, now);
  const samples: SoakSample[] = [];
  let times: number[] = [];
  let frames = 0;
  let peakAgents = 0;
  const end = start + opts.hours * 3_600_000;
  let nextHour = start + 3_600_000;
  while (now < end) {
    now += FRAME_MS;
    frames++;
    if (frames % OFFICE_EVERY === 0) {
      const r = mock.step(now);
      if (r.changed) sim.applySnapshot(r.snapshot, now);
      peakAgents = Math.max(peakAgents, r.snapshot.agents.length);
    }
    const a = performance.now();
    sim.update(FRAME_MS / 1_000, now);
    times.push(performance.now() - a);
    sim.effects.length = 0;
    if (now >= nextHour) {
      nextHour += 3_600_000;
      opts.gc?.();
      const snap = mock.office.commit().snapshot;
      times.sort((x, y) => x - y);
      const s: SoakSample = {
        hour: samples.length + 1,
        heapMb: +(process.memoryUsage().heapUsed / 1_048_576).toFixed(1),
        agents: snap.agents.length,
        rooms: snap.rooms.length,
        chars: sim.chars.size,
        feed: mock.office.recentFeed(1_000).length,
        p50: +percentile(times, 50).toFixed(3),
        p99: +percentile(times, 99).toFixed(3),
      };
      samples.push(s);
      opts.onHour?.(s);
      times = [];
    }
  }
  const base = samples[1] ?? samples[0];
  const last = samples.at(-1);
  return {
    hours: opts.hours,
    sessions: opts.sessions,
    frames,
    samples,
    heapGrowthMb: base && last ? +(last.heapMb - base.heapMb).toFixed(1) : 0,
    peakAgents,
    worstP99: Math.max(0, ...samples.map((s) => s.p99)),
    wallSeconds: +((performance.now() - t0) / 1_000).toFixed(1),
  };
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

if (process.argv[1] && /soak\.ts$/.test(process.argv[1])) {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) console.warn('Run with node --expose-gc for meaningful heap numbers.');
  const report = soak({
    hours: arg('hours', 8),
    sessions: arg('sessions', 15),
    seed: arg('seed', 7),
    gc,
    onHour: (s) => console.log(`hour ${s.hour}: heap ${s.heapMb} MB · ${s.agents} agents in ${s.rooms} rooms · sim update p50 ${s.p50} ms, p99 ${s.p99} ms`),
  });
  console.log(`\n${report.frames} frames (${report.hours} simulated hours) in ${report.wallSeconds} s · peak ${report.peakAgents} agents · heap growth after warm-up ${report.heapGrowthMb} MB · worst p99 ${report.worstP99} ms`);
  const i = process.argv.indexOf('--json');
  if (i >= 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1]!, `${JSON.stringify(report, null, 2)}\n`);
}
