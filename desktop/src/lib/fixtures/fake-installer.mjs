// A stand-in for scripts/hooks-install.mjs and usage-install.mjs: prints what the real ones print.
const [action, ...rest] = process.argv.slice(2);
const provider = rest[rest.indexOf('--provider') + 1];
if (process.env.FAKE_FAIL) {
  console.error('✗ ~/.gemini/settings.json: could not write (EACCES)');
  process.exit(1);
}
if (action === 'status') {
  if (provider === 'gemini-cli') console.log('• ~/.gemini/settings.json: installed for SessionStart, BeforeAgent');
  else if (provider === undefined) console.log('• ~/.claude/settings.json: installed');
  else console.log(`• ~/.${provider}/settings.json: not installed`);
} else {
  console.log(`✓ ${action} ${provider ?? 'usage'} ${rest.join(' ')}`);
}
