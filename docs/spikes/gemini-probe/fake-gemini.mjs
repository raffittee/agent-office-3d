// Throwaway P0-04 probe: a local stand-in for the Gemini API so the real CLI (and its hooks) can run offline.
// Usage: node fake-gemini.mjs <port> <requests.jsonl> [script.json]
// The script maps a scenario keyword (found in the first user prompt) to a list of model turns; each turn is either
// {"call": {"name", "args"}} (one function call), {"calls": [...]} (parallel calls) or {"text": "..."}.
import http from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';

const [port, reqLog, scriptPath] = process.argv.slice(2);
const script = scriptPath ? JSON.parse(readFileSync(scriptPath, 'utf8')) : {};

function firstUserText(contents) {
  let last = '';
  for (const c of contents ?? []) {
    if (c.role !== 'user') continue;
    for (const p of c.parts ?? []) if (typeof p.text === 'string' && /SCENARIO/.test(p.text)) last = p.text;
  }
  return last;
}

/** How many model turns have already happened in this conversation (= the next script step). */
function stepOf(contents) {
  // Count model turns after the last plain-text user prompt (a new prompt restarts the scenario's script... per prompt).
  let lastPrompt = -1;
  (contents ?? []).forEach((c, i) => {
    if (c.role === 'user' && (c.parts ?? []).some((p) => typeof p.text === 'string' && /SCENARIO/.test(p.text))) lastPrompt = i;
  });
  return (contents ?? []).slice(lastPrompt + 1).filter((c) => c.role === 'model').length;
}

function respond(body) {
  const json = body.generationConfig?.responseMimeType === 'application/json' || body.generationConfig?.responseJsonSchema || body.generationConfig?.responseSchema;
  const usage = { promptTokenCount: 1200, candidatesTokenCount: 34, cachedContentTokenCount: 800, thoughtsTokenCount: 0, totalTokenCount: 1234 };
  if (json) {
    const text = JSON.stringify({ reasoning: 'stub', next_speaker: 'user', model_choice: 'flash', complexity_reasoning: 'stub', complexity_score: 1 });
    return { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }], usageMetadata: usage, modelVersion: 'stub-model' };
  }
  const prompt = firstUserText(body.contents);
  const key = Object.keys(script).find((k) => prompt.includes(`SCENARIO ${k}:`));
  const turns = key ? script[key] : [];
  const step = stepOf(body.contents);
  const turn = turns[step] ?? { text: `Done (stub, step ${step}).` };
  const calls = turn.calls ?? (turn.call ? [turn.call] : null);
  const parts = calls ? calls.map((c) => ({ functionCall: c })) : [{ text: turn.text }];
  return { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }], usageMetadata: usage, modelVersion: 'stub-model' };
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      appendFileSync(reqLog, JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url, body }) + '\n');
      if (req.url.includes(':countTokens')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ totalTokens: 1000 }));
      }
      const out = respond(body);
      if (req.url.includes(':streamGenerateContent')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify(out)}\r\n\r\n`);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      }
    });
  })
  .listen(Number(port), '127.0.0.1');
