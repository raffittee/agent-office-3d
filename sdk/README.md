# Agent Office SDKs

Small emitters that let **any agent** (built on the Gemini API, OpenAI, Ollama, LangGraph, your own loop…) show up
in the office. Each one is a single file with no dependencies: copy it into your project.

| Language | File | Needs |
| --- | --- | --- |
| TypeScript / JavaScript | [`ts/agent-office.ts`](ts/agent-office.ts) | Node ≥ 18, Bun or Deno (`fetch`) |
| Python | [`python/agent_office.py`](python/agent_office.py) | Python ≥ 3.8, standard library only |

Both post `AgentEvent`s ([`shared/agent-event.schema.json`](../shared/agent-event.schema.json)) to
`http://127.0.0.1:4848/api/events` (`AGENT_OFFICE_PORT` changes the port). Your agent appears as
`custom:<name>` in the room of its working folder.

- **They never get in the way.** Reporting never throws or blocks. If the office isn't running, events are dropped.
- **Heartbeat.** Every 30 s, so a quiet agent stays visible. The process id is sent too, so a crash is noticed.
- **Privacy.** The office masks secrets and truncates text before showing anything, but only send what you want to
  see. Tool inputs are shown as a short description (a file name, a command), never as contents.

## TypeScript

```ts
import { AgentOffice } from './agent-office';

const office = new AgentOffice({ name: 'my-agent' }); // cwd defaults to process.cwd()
await office.sessionStart({ title: 'Fix the parser', model: 'gpt-5-mini' });

office.turnStart('Why does the parser test fail?'); // working
const text = await office.tool('read_file', { path: 'src/parser.ts' }, () => readFile('src/parser.ts', 'utf8'));
office.usage({ in: 1200, out: 80 }); // tokens since the last report

const sub = office.subagent({ role: 'reviewer', title: 'Review the fix' }); // a smaller character
await sub.tool('run_command', { command: 'npm test' }, () => runTests());
sub.end(); // walks its result over to the parent, then leaves

office.waiting('question', 'Keep the old API?'); // raises its hand until the next event
office.turnEnd(); // idle: it may wander to the coffee machine
await office.close(); // leaves, turning off the lights
```

Also: `toolStart`/`toolEnd` (manual), `jobStart`/`jobEnd` (a dev server or a long build left running), `tasks([...])`.

## Python

```python
from agent_office import AgentOffice

office = AgentOffice(name="my-agent")
office.session_start(title="Fix the parser", model="gemini-2.5-flash")
office.turn_start("Why does the parser test fail?")
with office.tool("read_file", {"path": "src/parser.py"}):
    text = open("src/parser.py").read()
office.usage(tokens_in=1200, tokens_out=80)
sub = office.subagent(role="reviewer", title="Review the fix")
with sub.tool("run_command", {"command": "pytest"}):
    run_tests()
sub.end()
office.turn_end()
office.close()
```

## Tool names

Any name works. The office guesses a description from common words (`read`, `write`, `edit`, `search`, `shell`,
`run`, `fetch`, `test`…) and common input fields (`path`, `file_path`, `command`, `cmd`, `query`, `url`).
`run_command` with `{"command": "npm test"}` shows "Running tests", for example.

## Examples

Both examples are complete agent loops with two read-only tools (`list_files`, `read_file`) inside the current
folder:

- [`python/examples/gemini_agent.py`](python/examples/gemini_agent.py) uses the **Gemini API**
  (`GEMINI_API_KEY`):

  ```sh
  GEMINI_API_KEY=... python sdk/python/examples/gemini_agent.py "What does this project do?"
  ```

- [`ts/examples/openai-agent.ts`](ts/examples/openai-agent.ts) uses an **OpenAI-compatible** endpoint. The default is
  a local **Ollama** (`ollama pull llama3.2`):

  ```sh
  npx tsx sdk/ts/examples/openai-agent.ts "What does this project do?"
  OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_API_KEY=... OPENAI_MODEL=gpt-5-mini npx tsx sdk/ts/examples/openai-agent.ts
  ```

`test/sdk.test.ts` runs both SDKs and both examples against the real ingest endpoint and stub model servers.
