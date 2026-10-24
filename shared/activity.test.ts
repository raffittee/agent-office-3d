// Ported from habblaud shared/activity.test.ts (MIT, © 2026 Márcio Junior)
import { describe, expect, it } from 'vitest';
import { SPECIAL, describeCommand, describeJob, describePrompt, maskSecrets, shellWords, splitShell, truncate, basename } from './activity';
import { claudeJob, describeClaudeTool, describeClaudeWaitingFor } from './tools/claude-code';

describe('describeCommand', () => {
  it('only the first line decides (heredocs do not confuse it)', () => {
    expect(describeCommand("cat > /tmp/x/notes.md <<'EOF'\nrun vitest later\nEOF").text).toBe('Writing notes.md');
    expect(describeCommand("cat <<'EOF' > server/README.md\n# x\nEOF").text).toBe('Writing README.md');
    expect(describeCommand("python3 - <<'EOF'\nimport os\nEOF").text).toBe('Running a Python script');
    expect(describeCommand("node -e 'console.log(1)'").text).toBe('Running a Node script');
  });

  it('common commands', () => {
    expect(describeCommand('npx vitest run server').text).toBe('Running tests');
    expect(describeCommand('cd /x && git commit -m "feat"').text).toBe('Committing');
    expect(describeCommand('node scripts/shot.mjs http://x out.png').text).toBe('Running shot.mjs');
    expect(describeCommand('tail -n 20 server.log').text).toBe('Reading server.log');
    expect(describeCommand('tee -a log.txt').text).toBe('Writing log.txt');
  });
});

describe('describeCommand (real cases)', () => {
  const t = (cmd: string, desc?: string) => describeCommand(cmd, desc).text;

  it('first line with a real command; prefixes and assignments do not count', () => {
    expect(t('S=/tmp/x\nnode scripts/shot.mjs x $S/a.png', 'Screenshot real-data UI on port 4763')).toBe('Running shot.mjs');
    expect(t('AGENT_OFFICE_PORT=1 nohup npx tsx server/index.ts --dev > /tmp/s.log 2>&1 &', 'Start real-data server')).toBe('Running index.ts');
    expect(t('set -e\nexport A=1\n# comment\nnpm test')).toBe('Running tests');
    expect(t('sleep 5 && curl -s localhost:4771/')).toBe('Testing the local server (:4771/)');
    expect(t('(cd client && npm test)')).toBe('Running tests');
    expect(t('bash -c "npm run build"')).toBe('Building the project');
    // A command substitution is part of the assignment, not a command.
    expect(t('S=/tmp/x; NOW=$(date +%s); echo "{\\"a\\":$((NOW+1))}" | HOME=$S node scripts/statusline-tap.mjs; ls $S')).toBe('Running statusline-tap.mjs');
  });

  it('readers are cut at the first |, ; or &&', () => {
    expect(t('sed -n 1,80p rug.ts', 'Read art rug implementation')).toBe('Reading rug.ts');
    expect(t("sed -n '140,700p' server/sources/transcript.ts")).toBe('Reading transcript.ts');
    expect(t('cat a.ts b.ts | head -700')).toBe('Reading a.ts and b.ts');
    expect(t('cat a.ts b.ts c.ts')).toBe('Reading a.ts and 2 more');
    expect(t('head -30 x.ts; ls | head')).toBe('Reading x.ts');
    expect(t("awk '{print $1}' data.csv")).toBe('Reading data.csv');
    expect(t('tail -f /tmp/server.log')).toBe('Following server.log');
    expect(t('wc -l server/*.ts shared/*.ts scripts/*')).toBe('Counting lines in 3 files');
    expect(t('echo "---"; tail -n 20 server.log')).toBe('Reading server.log');
  });

  it('processes, network, search and edits', () => {
    expect(t('pkill -f "vite.*4771"', 'Stop preview')).toBe('Stopping a process');
    expect(t('ps aux | grep vite')).toBe('Checking processes');
    expect(t('lsof -i :4771')).toBe('Checking what uses port 4771');
    expect(t('curl -s localhost:4763/api/snapshot | jq .rev')).toBe('Testing the local API (:4763/api/snapshot)');
    expect(t('curl http://127.0.0.1:4747/api/health')).toBe('Testing the local API (:4747/api/health)');
    expect(t('curl -o out.png -sS https://www.example.com/x.png')).toBe('Calling example.com');
    expect(t('grep "a\\|b" file.ts')).toBe('Searching for “a | b”');
    expect(t('sed -i "" "s/a/b/" src/x.ts')).toBe('Editing x.ts');
    expect(t('echo "hi" > out.txt')).toBe('Writing out.txt');
    expect(t('npx tsc --noEmit -p server/tsconfig.json')).toBe('Checking types (TypeScript)');
    expect(t('VITE_PORT=4771 nohup npx vite --config vite.config.ts --strictPort > x.log 2>&1 &')).toBe('Starting the dev server');
    expect(t('git -C /x status --short')).toBe('Checking git status');
    expect(t('npm run docker:up -- --no-build')).toBe('Running the docker:up script');
  });

  it('loops: the body decides', () => {
    expect(t('for f in a.ts b.ts; do wc -l $f; done')).toBe('Counting lines');
    expect(t('for f in *.ts\ndo\n  cat $f\ndone')).toBe('Reading a file');
  });

  it('an unrecognized command uses the description, else a generic text', () => {
    expect(t('ffmpeg -i a.mp4 b.gif', 'Convert the video to a gif')).toBe('Convert the video to a gif');
    const plain = describeCommand('ffmpeg -i a.mp4 b.gif');
    expect(plain.text).toBe('Running ffmpeg');
    expect(plain.detail).toBe('ffmpeg -i a.mp4 b.gif');
    expect(t('$(weird) | x')).toBe('Running a terminal command');
  });

  it('PowerShell commands (Claude Code on Windows)', () => {
    expect(t('Get-Content -Path src\\app.ts -Tail 20')).toBe('Reading app.ts');
    expect(t('Get-ChildItem -Recurse -Filter *.ts')).toBe('Exploring folders');
    expect(t("Set-Content -Path notes.md -Value 'x'")).toBe('Writing notes.md');
    expect(t('Stop-Process -Id 123 -Force')).toBe('Stopping a process');
    expect(t('Invoke-WebRequest -Uri http://127.0.0.1:4848/api/health')).toBe('Testing the local API (:4848/api/health)');
    expect(t('Select-String -Pattern TODO -Path *.ts')).toBe('Searching the code');
    expect(t('Set-Location C:\\x; npm test')).toBe('Running tests');
    expect(t('pwsh -NoProfile -Command "npm run build"')).toBe('Building the project');
  });
});

describe('secrets are masked', () => {
  it('commands with tokens, passwords and keys', () => {
    const d = describeCommand('curl -sS -H "Authorization: Bearer FAKE_TOKEN_123" https://api.example.com/v1');
    expect(d.text).toBe('Calling api.example.com');
    expect(d.detail).toBe('curl -sS -H "Authorization: ***" https://api.example.com/v1');
    expect(describeCommand('curl -u admin:s3cr3t https://x.com/api').detail).toBe('curl -u admin:*** https://x.com/api');
    expect(describeCommand('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 gh pr list').detail).toBe('GITHUB_TOKEN=*** gh pr list');
    expect(describeCommand('psql "postgres://user:pa55word@db.host:5432/app"').detail).toBe('psql "postgres://user:***@db.host:5432/app"');
    expect(maskSecrets('x sk-ant-api03-abcdefghijklmnop y')).toBe('x sk-*** y');
    expect(maskSecrets('Bearer abcdef123456')).toBe('Bearer ***');
    expect(maskSecrets('curl "https://x.com/?token=abc&x=1" --password hunter2')).toBe('curl "https://x.com/?token=***&x=1" --password ***');
    expect(maskSecrets('{"password": "x", "max_tokens": 100}')).toBe('{"password": "***", "max_tokens": 100}');
    expect(maskSecrets('AKIAABCDEFGHIJKLMNOP eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f')).toBe('AKIA*** eyJ***');
    expect(describePrompt('use the key sk-proj-0123456789abcdef to test').detail).toBe('use the key sk-*** to test');
  });

  it('the fake key captured in the Gemini fixtures', () => {
    expect(maskSecrets('API_KEY=sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE\n')).toBe('API_KEY=***\n');
    expect(maskSecrets('x-goog-api-key: AIzaSyD-abcdefghijklmnopqrstuvwxyz012345')).toBe('x-goog-api-key: ***');
  });

  it('webhooks and npm_/hf_ tokens (the secret goes, the host stays)', () => {
    // Built in parts: the whole URL in source would trip GitHub's push protection.
    const slack = ['https://hooks.slack.com/services', 'T00000000', 'B00000000', 'X'.repeat(24)].join('/');
    expect(maskSecrets(`curl -X POST ${slack}`)).toBe('curl -X POST https://hooks.slack.com/services/***');
    expect(maskSecrets('https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz-_0123456789')).toBe('https://discord.com/api/webhooks/***');
    expect(maskSecrets('https://discordapp.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz-_0123456789')).toBe('https://discordapp.com/api/webhooks/***');
    expect(maskSecrets('curl https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX/sendMessage')).toBe('curl https://api.telegram.org/bot***/sendMessage');
    expect(maskSecrets('use npm_1234567890abcdef1234567890abcdef1234 in ci')).toBe('use npm_*** in ci');
    expect(maskSecrets('key hf_abcdefghijklmnopqrstuvwxyz01234567 here')).toBe('key hf_*** here');
  });

  it('ordinary text mentioning npm or hf is not a secret', () => {
    const s = 'run npm test and npm run build; the hf model from huggingface uses npm_config_cache';
    expect(maskSecrets(s)).toBe(s);
  });

  it('shell words and segments', () => {
    expect(shellWords(`a 'b c' "d \\"e\\"" f\\ g ''`)).toEqual(['a', 'b c', 'd "e"', 'f g', '']);
    expect(splitShell('a && b | c; d & e 2>&1 || f "x|y" $(g; h)')).toEqual(['a', 'b', 'c', 'd', 'e 2>&1', 'f "x|y" $(g; h)']);
    expect(shellWords('X=$(date +%s) y `a b` z')).toEqual(['X=$(date +%s)', 'y', '`a b`', 'z']);
  });
});

describe('helpers', () => {
  it('truncate and basename', () => {
    expect(truncate('a  b\n c', 10)).toBe('a b c');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
    expect(basename('C:\\Users\\dev\\code\\project\\')).toBe('project');
    expect(basename('/a/b.ts')).toBe('b.ts');
  });
});

describe('activities', () => {
  it('TodoWrite ignores items that are not objects and tolerates tasks without a status', () => {
    expect(describeClaudeTool('TodoWrite', { todos: [null] })).toEqual({ kind: 'plan', icon: '🗒️', text: 'Updating the task list' });
    expect(
      describeClaudeTool('TodoWrite', {
        todos: [null, undefined, 'invalid', 42, false, { content: 'No status' }, { content: 'Ready', status: 'completed' }, { content: 'Pending', status: 'pending' }],
      }).detail,
    ).toBe('1/3 done');
  });

  it('tools and specials', () => {
    expect(describeClaudeTool('Agent', { description: 'Review the code', subagent_type: 'Explore' })).toMatchObject({ kind: 'delegate', text: 'Delegating: Review the code' });
    expect(SPECIAL.rejected('Write').text).toBe('You declined: Write');
    expect(SPECIAL.cleared().kind).toBe('compact');
    expect(describeClaudeWaitingFor('worker request')).toBe('approve a worker request');
    expect(describeClaudeWaitingFor(undefined)).toBe('answer in the terminal');
  });
});

describe('jobs', () => {
  it('job label: the description (masked) or the command summary; the command masked in the detail', () => {
    expect(claudeJob('Bash', { command: 'vendor/bin/phpunit', description: 'Run the full suite in groups with phpunit' })).toEqual({
      label: 'Run the full suite in groups with phpunit',
      command: 'vendor/bin/phpunit',
      kind: 'shell',
    });
    expect(claudeJob('Bash', { command: 'GITHUB_TOKEN=ghp_0123456789abcdefghij npm run build' })).toEqual({
      label: 'Building the project',
      command: 'GITHUB_TOKEN=*** npm run build',
      kind: 'shell',
    });
    expect(claudeJob('Bash', { command: 'x', description: 'Deploy with --token abc123def456 to production of a very important service' }).label).toBe(
      'Deploy with --token *** to production of a ve…',
    );
    expect(claudeJob('Monitor', { description: 'errors in deploy.log', command: 'tail -f deploy.log' })).toMatchObject({ label: 'errors in deploy.log', kind: 'monitor' });
    expect(claudeJob('Monitor', { ws: { url: 'wss://events.example.com/stream' } })).toEqual({
      label: 'Listening to events.example.com',
      command: 'wss://events.example.com/stream',
      kind: 'monitor',
    });
    expect(describeJob('ping -n 4 127.0.0.1', 'Wait a bit')).toEqual({ label: 'Wait a bit', command: 'ping -n 4 127.0.0.1', kind: 'shell' });
  });

  it('wait bubble and job end (markers for the world), always within 46 characters with the whole duration', () => {
    expect(SPECIAL.waitingShell('Run the suite')).toMatchObject({ kind: 'wait', icon: '⏳', text: 'Waiting for the shell: Run the suite', tool: 'JobWait' });
    expect(SPECIAL.waitingShell('Build', 3).text).toBe('Waiting for 3 shells: Build');
    expect(SPECIAL.waitingShell(undefined).text).toBe('Waiting for the shell');
    const ok = SPECIAL.jobDone('Run the full suite in groups with phpunit', 'ok', 482_000, 'vendor/bin/phpunit');
    expect(ok).toEqual({ kind: 'run', icon: '✅', text: 'Shell finished: Run the full suite… (8min 2s)', detail: 'vendor/bin/phpunit', tool: 'JobDone' });
    expect(ok.text.length).toBeLessThanOrEqual(46);
    expect(SPECIAL.jobDone('Migration', 'failed')).toEqual({ kind: 'run', icon: '❌', text: 'Shell failed: Migration', tool: 'JobDone', error: true });
    expect(SPECIAL.jobDone('Migration', 'killed')).toMatchObject({ icon: '🛑', text: 'Shell stopped: Migration', error: true });
  });
});

describe('AskUserQuestion in the office', () => {
  it('carries the full questions, with options, to the "Needs you" card', () => {
    const d = describeClaudeTool('AskUserQuestion', {
      questions: [
        {
          question: 'Which database?',
          header: 'Database',
          multiSelect: false,
          options: [{ label: 'Postgres', description: 'Relational, already used in the project' }, { label: 'SQLite' }],
        },
        { question: 'Which tests to run?', multiSelect: true, options: [{ label: 'Unit' }, { label: 'E2E' }] },
      ],
    });
    expect(d).toMatchObject({ kind: 'ask', text: 'Asking you a question', detail: 'Which database?' });
    expect(d.questions).toEqual([
      {
        index: 0,
        question: 'Which database?',
        header: 'Database',
        options: [
          { index: 0, label: 'Postgres', description: 'Relational, already used in the project' },
          { index: 1, label: 'SQLite' },
        ],
      },
      { index: 1, question: 'Which tests to run?', multiSelect: true, options: [{ index: 0, label: 'Unit' }, { index: 1, label: 'E2E' }] },
    ]);
  });

  it('masks secrets and skips invalid entries', () => {
    const d = describeClaudeTool('AskUserQuestion', {
      questions: [null, { question: '' }, { question: 'Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789?', options: [{ label: '' }, { label: 'Yes' }] }],
    });
    expect(d.questions).toHaveLength(1);
    expect(d.questions![0]!.question).not.toContain('abcdefghijklmnop');
    // Positions are those of the original (answers go back by them), counting the invalid ones.
    expect(d.questions![0]!.index).toBe(2);
    expect(d.questions![0]!.options).toEqual([{ index: 1, label: 'Yes' }]);
  });

  it('without valid questions, the field is absent', () => {
    expect(describeClaudeTool('AskUserQuestion', {}).questions).toBeUndefined();
  });
});
