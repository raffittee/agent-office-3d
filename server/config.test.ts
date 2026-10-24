import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST, DEFAULT_PORT, isLoopbackBind, isTruthy, loadConfig, parsePort } from './config';

describe('config', () => {
  it('defaults to a local bind on 4848 and ~/.agent-office', () => {
    const c = loadConfig({ HOME: '/home/dev' }, []);
    expect(c).toMatchObject({ host: DEFAULT_HOST, port: DEFAULT_PORT, dev: false, demo: false });
    expect(c.dataDir.replace(/\\/g, '/')).toMatch(/\/home\/dev\/\.agent-office$/);
    expect(c.allowedHosts.size).toBe(0);
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(c.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reads the environment and flags', () => {
    const c = loadConfig(
      { AGENT_OFFICE_PORT: '5000', AGENT_OFFICE_HOST: 'localhost', AGENT_OFFICE_DEMO: '1', AGENT_OFFICE_DATA_DIR: '/tmp/ao', AGENT_OFFICE_ALLOWED_HOSTS: 'my-pc.local:4848' },
      ['--dev'],
    );
    expect(c).toMatchObject({ host: 'localhost', port: 5000, dev: true, demo: true });
    expect(c.dataDir.replace(/\\/g, '/')).toMatch(/\/tmp\/ao$/);
    expect([...c.allowedHosts]).toEqual(['my-pc.local']);
    expect(loadConfig({}, ['--demo']).demo).toBe(true);
  });

  it('rejects bad ports', () => {
    for (const bad of ['0', '65536', '12.5', 'abc', '-1']) expect(() => parsePort(bad)).toThrow();
    expect(parsePort('  ')).toBe(DEFAULT_PORT);
  });

  it('truthy flags and loopback binds', () => {
    for (const v of ['1', 'true', 'YES', 'on']) expect(isTruthy(v)).toBe(true);
    for (const v of [undefined, '', '0', 'off', 'no']) expect(isTruthy(v)).toBe(false);
    for (const v of ['127.0.0.1', '127.5.5.5', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']) expect(isLoopbackBind(v)).toBe(true);
    for (const v of ['0.0.0.0', '::', '192.168.1.10', 'my-pc.local', undefined]) expect(isLoopbackBind(v)).toBe(false);
  });
});
