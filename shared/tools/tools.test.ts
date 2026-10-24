// Every tool seen in the real provider fixtures maps to the expected activity kind.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ActivityKind } from '../protocol';
import { describeGeminiTool, geminiJob } from './gemini-cli';
import { describeGenericTool, describeToolFor } from './index';

const fixtures = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));

function lines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('gemini-cli tool table', () => {
  const EXPECTED: Record<string, ActivityKind> = {
    read_file: 'read',
    replace: 'edit',
    write_file: 'write',
    run_shell_command: 'run',
    glob: 'search',
    grep_search: 'search',
    invoke_agent: 'delegate',
    list_directory: 'read',
    complete_task: 'communicate', // inside the subagent
  };

  it('maps every tool in the captured hook payloads', () => {
    const seen = new Set<string>();
    for (const f of readdirSync(join(fixtures, 'gemini-cli')).filter((f) => f.startsWith('hooks-'))) {
      for (const { payload } of lines(join(fixtures, 'gemini-cli', f)) as { payload: Record<string, unknown> }[]) {
        if (payload.hook_event_name !== 'BeforeTool') continue;
        const name = payload.tool_name as string;
        seen.add(name);
        const d = describeGeminiTool(name, payload.tool_input);
        expect(EXPECTED[name], `unexpected tool ${name}`).toBeDefined();
        expect(d.kind, name).toBe(EXPECTED[name]);
        expect(d.text.length).toBeLessThanOrEqual(46);
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('reads well', () => {
    expect(describeGeminiTool('read_file', { file_path: 'notes.txt' }).text).toBe('Reading notes.txt');
    expect(describeGeminiTool('replace', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }).text).toBe('Editing a.ts');
    expect(describeGeminiTool('list_directory', { dir_path: '.' }).text).toBe('Listing a folder');
    expect(describeGeminiTool('invoke_agent', { agent_name: 'codebase_investigator', prompt: 'Find X' }).text).toBe('Delegating to codebase investigator');
    expect(describeGeminiTool('google_web_search', { query: 'three.js instancing' }).text).toBe('Searching the web for “three.js instancing”');
    expect(describeGeminiTool('web_fetch', { prompt: 'Summarize https://example.com/docs please' }).text).toBe('Reading example.com');
    expect(describeGeminiTool('run_shell_command', { command: 'npm test' }).kind).toBe('test');
    expect(describeGeminiTool('mystery_tool', {}).text).toBe('Using mystery tool');
  });

  it('labels background jobs', () => {
    expect(geminiJob({ command: 'ping -n 4 127.0.0.1', description: 'Wait a bit', is_background: true })).toEqual({ label: 'Wait a bit', command: 'ping -n 4 127.0.0.1', kind: 'shell' });
  });

  it('masks the fake secret written by write_file', () => {
    const d = describeGeminiTool('run_shell_command', { command: 'echo API_KEY=sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE > .env' });
    expect(d.detail).not.toContain('FAKEFAKE');
  });
});

describe('claude-code tool table', () => {
  const OTHER_OK = new Set(['ToolSearch', 'Artifact', 'ReportFindings']);

  it('maps every tool used in the captured transcripts to a specific kind', () => {
    const seen = new Set<string>();
    for (const f of readdirSync(join(fixtures, 'claude-code')).filter((f) => f.startsWith('transcript-'))) {
      for (const r of lines(join(fixtures, 'claude-code', f))) {
        const content = (r.message as { content?: unknown } | undefined)?.content;
        if (!Array.isArray(content)) continue;
        for (const b of content as Record<string, unknown>[]) {
          if (b.type !== 'tool_use') continue;
          const name = b.name as string;
          seen.add(name);
          const d = describeToolFor('claude-code', name, b.input);
          if (!OTHER_OK.has(name)) expect(d.kind, name).not.toBe('other');
        }
      }
    }
    expect(seen.size).toBeGreaterThan(5);
    expect(describeToolFor('claude-code', 'PowerShell', { command: 'npm test' }).kind).toBe('test');
    expect(describeToolFor('claude-code', 'mcp__claude_ai_Claude_Docs__batch', {}).kind).toBe('mcp');
  });
});

describe('generic table (custom agents)', () => {
  it('guesses from common names and fields', () => {
    expect(describeGenericTool('read_file', { path: 'src/a.py' }).text).toBe('Reading a.py');
    expect(describeGenericTool('execute_shell', { command: 'pytest -q' }).kind).toBe('test');
    expect(describeGenericTool('web_search', { query: 'x' }).kind).toBe('search');
    expect(describeGenericTool('http_get', { url: 'https://x.dev' }).kind).toBe('web');
    expect(describeGenericTool('spawn_agent', {}).kind).toBe('delegate');
    expect(describeGenericTool('frobnicate', {}).text).toBe('Using frobnicate');
    expect(describeToolFor('custom:my-agent', 'write_file', { path: 'a.md' }).text).toBe('Writing a.md');
  });
});
