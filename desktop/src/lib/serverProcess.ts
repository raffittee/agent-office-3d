// Runs the Agent Office server as a child process of the app. In the packaged app `execPath` is the app's own
// executable, which acts as plain Node because of ELECTRON_RUN_AS_NODE; in tests it is just `node`.
import { spawn, type ChildProcess } from 'node:child_process';
import { probeHealth } from './health';

export interface ServerOptions {
  execPath: string;
  /** dist/server/index.js */
  entry: string;
  port: number;
  /** Extra environment (data dir, theme, …). */
  env?: Record<string, string>;
  /** How long to wait for /api/health. */
  healthTimeoutMs?: number;
  /** One line of the server's own output (the server never logs conversation content). */
  onLog?: (line: string) => void;
  /** The server ended without stop() being called. */
  onUnexpectedExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface ServerHandle {
  readonly port: number;
  readonly pid: number | undefined;
  /** Asks the server to shut down cleanly (it saves its state), then forces it after `graceMs`. */
  stop(graceMs?: number): Promise<void>;
}

const TAIL_LINES = 40;

function lines(stream: NodeJS.ReadableStream | null, push: (line: string) => void): void {
  if (!stream) return;
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const parts = (rest + chunk).split(/\r?\n/);
    rest = parts.pop() ?? '';
    for (const p of parts) if (p) push(p);
  });
  stream.on('end', () => {
    if (rest) push(rest);
  });
}

export async function startServer(o: ServerOptions): Promise<ServerHandle> {
  const child: ChildProcess = spawn(o.execPath, [o.entry], {
    // the 4th channel is an IPC pipe: stop() uses it to ask for a clean shutdown, which signals can't do on Windows
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: { ...process.env, ...o.env, ELECTRON_RUN_AS_NODE: '1', AGENT_OFFICE_PORT: String(o.port), AGENT_OFFICE_HOST: '127.0.0.1' },
  });
  const tail: string[] = [];
  const push = (line: string) => {
    tail.push(line);
    if (tail.length > TAIL_LINES) tail.shift();
    o.onLog?.(line);
  };
  lines(child.stdout, push);
  lines(child.stderr, push);

  let stopping = false;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (err) => {
      push(`spawn error: ${err.message}`);
      resolve({ code: null, signal: null });
    });
  });
  void exited.then(({ code, signal }) => {
    if (!stopping) o.onUnexpectedExit?.(code, signal);
  });

  const deadline = Date.now() + (o.healthTimeoutMs ?? 20_000);
  for (;;) {
    const state = await Promise.race([probeHealth(o.port, fetch, 800), exited.then(() => 'exited' as const)]);
    if (state === 'exited') throw new Error(`The server stopped while starting.\n${tail.join('\n')}`);
    if (state) break;
    if (Date.now() > deadline) {
      stopping = true;
      child.kill();
      throw new Error(`The server did not answer on port ${o.port} in time.\n${tail.join('\n')}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    port: o.port,
    pid: child.pid,
    async stop(graceMs = 3000) {
      stopping = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (child.connected) child.send('shutdown');
        else child.kill();
      } catch {
        child.kill();
      }
      const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
      await exited;
      clearTimeout(timer);
    },
  };
}
