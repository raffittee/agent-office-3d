import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST, DEFAULT_PORT, loadConfig, parsePort } from './config';

describe('config', () => {
  it('defaults to a local bind on 4848', () => {
    expect(loadConfig({}, [])).toEqual({ host: DEFAULT_HOST, port: DEFAULT_PORT, dev: false });
    expect(DEFAULT_HOST).toBe('127.0.0.1');
  });

  it('reads the env and --dev', () => {
    expect(loadConfig({ AGENT_OFFICE_PORT: '5000', AGENT_OFFICE_HOST: 'localhost' }, ['--dev'])).toEqual({
      host: 'localhost',
      port: 5000,
      dev: true,
    });
  });

  it('rejects bad ports', () => {
    for (const bad of ['0', '65536', '12.5', 'abc', '-1']) expect(() => parsePort(bad)).toThrow();
    expect(parsePort('  ')).toBe(DEFAULT_PORT);
  });
});
