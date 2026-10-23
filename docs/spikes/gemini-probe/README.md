# Gemini CLI probe (P0-04 spike tools)

Throwaway tools that capture **real** Gemini CLI hook payloads and chat files without a Google account. The CLI runs
unmodified and the model is replaced by a local stub. Use them to re-verify
[`docs/providers/gemini-cli.md`](../../providers/gemini-cli.md) when the supported Gemini version changes. They are
not part of the build and have no tests.

| File | Purpose |
| --- | --- |
| `fake-gemini.mjs` | Stub of the Gemini API on `127.0.0.1`. Replies follow `script.json`: the scenario is picked by `SCENARIO <key>:` in the latest prompt, and each model turn is a function call, parallel calls or text. Logs every request. |
| `log-hook.mjs` | Hook command: appends the raw stdin payload (plus `ppid`) to `$PROBE_LOG`. Prints nothing, exits 0. Set `PROBE_PARENTS=1` to also record the parent process (Windows). |
| `tui-driver.mjs` | Drives the interactive TUI through `node-pty` (use the copy Gemini bundles: `node_modules/@lydell/node-pty`). Steps wait for screen text, then send keys. |
| `acp-driver.mjs` | Drives `gemini --acp` over JSON-RPC and answers permission requests (`allow` / `deny`). |
| `script.json`, `tui-steps2.json` | The scenarios used for the committed fixtures. |

## Recipe

1. Install the version under test somewhere disposable: `npm install --prefix <tmp>/gemini @google/gemini-cli@<version>`.
2. Make an isolated home, `<tmp>/home/.gemini/settings.json`:

   ```json
   {
     "security": { "auth": { "selectedType": "gemini-api-key" } },
     "hooks": {
       "SessionStart": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"<abs>/log-hook.mjs\"", "timeout": 10000 }] }]
     }
   }
   ```

   Repeat the `hooks` entry for `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool`,
   `Notification` and `PreCompress`. The matcher must be `"*"`, because session events compare it by exact string
   equality.
3. Start the stub: `node fake-gemini.mjs 4891 <tmp>/requests.jsonl script.json`.
4. From a scratch project folder, run with:

   ```sh
   GEMINI_CLI_HOME=<tmp>/home GEMINI_CLI_TRUST_WORKSPACE=true \
   GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:4891 GEMINI_API_KEY=stub-not-a-real-key \
   PROBE_LOG=<tmp>/hooks.jsonl \
   <tmp>/gemini/node_modules/.bin/gemini --approval-mode yolo -p "SCENARIO work: go"
   ```

   For the TUI: `node tui-driver.mjs <node-pty dir> <gemini.js> <screen.log> tui-steps2.json` (set
   `MSYS_NO_PATHCONV=1` in Git Bash so `/quit` isn't rewritten into a path).
5. Sanitize before committing: replace machine paths and names with `C:\Users\dev\…`, then check for leftovers with
   `grep -i -E '<your user name>|AppData'`.
