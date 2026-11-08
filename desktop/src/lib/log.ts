// A small log file for the app itself (starting and stopping the server, errors). Never conversation content: the
// server's own lines (which never contain any) and the app's lifecycle events are all that go in.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

const MAX_BYTES = 512 * 1024;

export function createLogger(file: string, now: () => Date = () => new Date()): Logger {
  let ready = false;
  const write = (level: string, message: string) => {
    try {
      if (!ready) {
        mkdirSync(dirname(file), { recursive: true });
        ready = true;
      }
      try {
        if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
      } catch {
        // no file yet
      }
      appendFileSync(file, `${now().toISOString()} ${level} ${message.replace(/\r?\n/g, ' | ')}\n`);
    } catch {
      // logging never stops the app
    }
  };
  return { info: (m) => write('INFO', m), error: (m) => write('ERROR', m) };
}
