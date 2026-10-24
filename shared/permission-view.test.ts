// Permission request titles and argument previews (P7-01).
import { describe, expect, it } from 'vitest';
import { cutBlock, permissionView, relPath } from './permission-view';

describe('permissionView', () => {
  it('CLI-style titles with paths relative to the project', () => {
    expect(permissionView('Bash', { command: 'npm test\necho done' }).title).toBe('Bash(npm test)');
    expect(permissionView('Edit', { file_path: 'C:\\code\\shop\\src\\app.ts', old_string: 'a', new_string: 'b' }, 'c:/code/shop').title).toBe('Edit(src/app.ts)');
    expect(permissionView('WebFetch', { url: 'https://example.com/x' }).title).toBe('WebFetch(https://example.com/x)');
    expect(permissionView('mcp__github__create_issue', { title: 'x' }).title).toBe('mcp__github__create_issue');
  });

  it('previews keep line breaks and are masked', () => {
    const v = permissionView('Edit', { file_path: '/p/a.ts', old_string: 'const k = 1;\nfoo()', new_string: 'const k = "sk-proj-0123456789abcdefghij";' });
    expect(v.input).toContain('- const k = 1;\n- foo()\n+ const k =');
    expect(v.input).not.toContain('0123456789abcdefghij');
    expect(permissionView('mcp__x__y', { a: 1 }).input).toBe('{\n  "a": 1\n}');
    expect(permissionView('Read', {}).input).toBeUndefined();
  });

  it('cuts long blocks', () => {
    expect(cutBlock('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(relPath('/a/b/c', '/a/b/')).toBe('c');
    expect(relPath('/elsewhere/c', '/a/b')).toBe('/elsewhere/c');
  });
});
