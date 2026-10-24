"""A minimal agent loop on the Gemini API that reports to Agent Office (P5-02).

    export GEMINI_API_KEY=...           # https://aistudio.google.com/apikey
    python sdk/python/examples/gemini_agent.py "What does this project do?"

The model can call two read-only tools (list_files, read_file) inside the current folder. Each turn, tool call and
token count shows up in the office as a "custom:gemini-example" agent in this folder's room.
Optional: GEMINI_MODEL (default gemini-2.5-flash), GEMINI_API_BASE (a compatible endpoint, or a local stub in tests).
Standard library only.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from agent_office import AgentOffice  # noqa: E402

ROOT = Path.cwd().resolve()
API = os.environ.get("GEMINI_API_BASE", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

TOOLS = [
    {
        "functionDeclarations": [
            {"name": "list_files", "description": "List files in a folder of the project.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}},
            {"name": "read_file", "description": "Read a text file of the project.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
        ]
    }
]


def inside(path: str) -> Path:
    p = (ROOT / path).resolve()
    if p != ROOT and ROOT not in p.parents:
        raise ValueError("outside the project")
    return p


def run_tool(name: str, args: dict) -> str:
    if name == "list_files":
        return "\n".join(sorted(e.name + ("/" if e.is_dir() else "") for e in inside(args.get("path", ".")).iterdir())[:200])
    if name == "read_file":
        return inside(args["path"]).read_text(errors="replace")[:20_000]
    raise ValueError(f"unknown tool {name}")


def generate(contents: list, key: str) -> dict:
    req = urllib.request.Request(
        f"{API}/models/{MODEL}:generateContent",
        data=json.dumps({"contents": contents, "tools": TOOLS}).encode(),
        headers={"content-type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.loads(res.read())


def main() -> int:
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        print("Set GEMINI_API_KEY first.", file=sys.stderr)
        return 2
    question = " ".join(sys.argv[1:]) or "Summarize this project in three sentences."
    office = AgentOffice(name="gemini-example", cwd=str(ROOT))
    office.session_start(title=question[:80], model=MODEL)
    office.turn_start(question)
    contents = [{"role": "user", "parts": [{"text": question}]}]
    try:
        for _ in range(10):
            reply = generate(contents, key)
            meta = reply.get("usageMetadata", {})
            cached = meta.get("cachedContentTokenCount", 0)
            office.usage(meta.get("promptTokenCount", 0) - cached, meta.get("candidatesTokenCount", 0), cached)
            parts = reply["candidates"][0]["content"].get("parts", [])
            contents.append({"role": "model", "parts": parts})
            calls = [p["functionCall"] for p in parts if "functionCall" in p]
            if not calls:
                print("".join(p.get("text", "") for p in parts))
                break
            answers = []
            for call in calls:
                with office.tool(call["name"], call.get("args", {})):
                    try:
                        result = {"result": run_tool(call["name"], call.get("args", {}))}
                    except Exception as err:  # the model sees the error and can try again
                        result = {"error": str(err)}
                answers.append({"functionResponse": {"name": call["name"], "response": result}})
            contents.append({"role": "user", "parts": answers})
    finally:
        office.turn_end()
        office.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
