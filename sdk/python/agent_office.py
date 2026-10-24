"""Agent Office SDK for Python (P5-02). One file, standard library only: copy it next to your agent.

    from agent_office import AgentOffice

    office = AgentOffice(name="my-agent")
    office.session_start(title="Refactor the parser")
    office.turn_start("Fix the failing test")
    with office.tool("read_file", {"path": "src/parser.py"}):
        text = open("src/parser.py").read()
    office.turn_end()
    office.close()

Events go to http://127.0.0.1:<port>/api/events (AGENT_OFFICE_PORT, default 4848), batched by a background thread.
Reporting never raises and never blocks the agent: if the office isn't running, events are dropped. A heartbeat
every 30 s keeps the session visible while the agent is quiet. The protocol is `AgentEvent`
(shared/agent-event.schema.json in the Agent Office repository). Python 3.8+.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, List, Optional

__all__ = ["AgentOffice", "Subagent"]

_SLUG = re.compile(r"^[a-z0-9][a-z0-9._-]{0,39}$")
_MAX_BATCH = 100


class AgentOffice:
    """Reports what one agent (and its subagents) is doing."""

    def __init__(
        self,
        name: str,
        cwd: Optional[str] = None,
        session: Optional[str] = None,
        account: str = "default",
        url: Optional[str] = None,
        heartbeat_s: float = 30.0,
        report_pid: bool = True,
        on_error: Optional[Callable[[BaseException], None]] = None,
    ) -> None:
        if not _SLUG.match(name):
            raise ValueError(f'AgentOffice: name must be a slug (lowercase letters, digits, ".", "_", "-"), got "{name}"')
        self.provider = f"custom:{name}"
        self.session = session or str(uuid.uuid4())
        self.account = account if _SLUG.match(account or "") else "default"
        self.cwd = cwd if cwd is not None else os.getcwd()
        port = os.environ.get("AGENT_OFFICE_PORT", "4848")
        self.url = (url or f"http://127.0.0.1:{port}").rstrip("/")
        self.pid = os.getpid() if report_pid else None
        self.on_error = on_error or (lambda err: None)
        self.model: Optional[str] = None
        self._queue: List[Dict[str, Any]] = []
        self._lock = threading.Lock()
        self._post_lock = threading.Lock()  # one batch at a time, in order
        self._wake = threading.Event()
        self._closed = False
        self._seq = 0
        self._heartbeat_s = heartbeat_s
        self._last_beat = time.monotonic()
        self._worker = threading.Thread(target=self._run, name="agent-office", daemon=True)
        self._worker.start()

    # ------------------------------------------------------------ the session

    def session_start(self, title: Optional[str] = None, model: Optional[str] = None, git_branch: Optional[str] = None) -> None:
        if model:
            self.model = model
        extra: Dict[str, Any] = {}
        if title:
            extra["title"] = title
        if git_branch:
            extra["gitBranch"] = git_branch
        self.emit("session.start", **extra)
        self.flush()

    def close(self) -> None:
        """The agent is done: reports it, flushes and stops the background thread."""
        self.emit("session.end")
        self.flush()
        self._closed = True
        self._wake.set()

    def turn_start(self, prompt: Optional[str] = None, agent: Optional[str] = None) -> None:
        self.emit("turn.start", agent=agent, **({"prompt": prompt} if prompt else {}))

    def turn_end(self, agent: Optional[str] = None) -> None:
        self.emit("turn.end", agent=agent)

    # ------------------------------------------------------------ tools

    def tool_start(self, name: str, input: Optional[Dict[str, Any]] = None, agent: Optional[str] = None) -> str:
        tool_id = self._next("t")
        tool: Dict[str, Any] = {"id": tool_id, "name": name}
        if input is not None:
            tool["input"] = input
        self.emit("tool.start", agent=agent, tool=tool)
        return tool_id

    def tool_end(self, tool_id: str, ok: Optional[bool] = None, error: Optional[str] = None, name: str = "tool", agent: Optional[str] = None) -> None:
        tool: Dict[str, Any] = {"id": tool_id, "name": name}
        if ok is not None:
            tool["ok"] = ok
        if error:
            tool["error"] = error[:200]
        self.emit("tool.end", agent=agent, tool=tool)

    @contextmanager
    def tool(self, name: str, input: Optional[Dict[str, Any]] = None, agent: Optional[str] = None) -> Iterator[str]:
        """`with office.tool("read_file", {...}):` — start, then end (ok, or the exception's type)."""
        tool_id = self.tool_start(name, input, agent)
        try:
            yield tool_id
        except BaseException as err:
            self.tool_end(tool_id, ok=False, error=type(err).__name__, name=name, agent=agent)
            raise
        self.tool_end(tool_id, ok=True, name=name, agent=agent)

    # ------------------------------------------------------------ states

    def waiting(self, reason: str, text: Optional[str] = None, agent: Optional[str] = None) -> None:
        """The agent needs the user: 'permission', 'question' or 'input'. Cleared by the next tool or turn event."""
        w: Dict[str, Any] = {"reason": reason}
        if text:
            w["text"] = text
        self.emit("waiting", agent=agent, waiting=w)

    def usage(self, tokens_in: int = 0, tokens_out: int = 0, cached: int = 0, model: Optional[str] = None, agent: Optional[str] = None) -> None:
        """Tokens used since the last report (deltas, not totals)."""
        if model:
            self.model = model
        self.emit("usage", agent=agent, tokens={"in": tokens_in, "out": tokens_out, "cached": cached})

    def tasks(self, items: List[Dict[str, Any]], agent: Optional[str] = None) -> None:
        """The task list: [{"id", "title", "status": "pending" | "in_progress" | "completed"}]."""
        self.emit("tasks", agent=agent, tasks=items)

    def job_start(self, label: Optional[str] = None, command: Optional[str] = None, agent: Optional[str] = None) -> str:
        job_id = self._next("j")
        job: Dict[str, Any] = {"id": job_id}
        if label:
            job["label"] = label
        if command:
            job["command"] = command
        self.emit("job.start", agent=agent, job=job)
        return job_id

    def job_end(self, job_id: str, ok: Optional[bool] = None, agent: Optional[str] = None) -> None:
        job: Dict[str, Any] = {"id": job_id}
        if ok is not None:
            job["ok"] = ok
        self.emit("job.end", agent=agent, job=job)

    # ------------------------------------------------------------ subagents

    def subagent(self, role: Optional[str] = None, title: Optional[str] = None, parent: Optional[str] = None) -> "Subagent":
        sub_id = self._next("sub-")
        info: Dict[str, Any] = {}
        if role:
            info["role"] = role
        if title:
            info["title"] = title
        extra: Dict[str, Any] = {"subagent": info}
        if parent:
            extra["parentAgent"] = parent
        self.emit("subagent.start", agent=sub_id, **extra)
        return Subagent(self, sub_id)

    # ------------------------------------------------------------ plumbing

    def emit(self, type: str, agent: Optional[str] = None, **fields: Any) -> None:
        ev: Dict[str, Any] = {"v": 1, "provider": self.provider, "account": self.account, "session": self.session, "at": int(time.time() * 1000), "type": type}
        ev.update(fields)
        if agent:
            ev["agent"] = agent
        if self.cwd:
            ev["cwd"] = self.cwd
        if self.pid is not None:
            ev["pid"] = self.pid
        if self.model and "model" not in ev:
            ev["model"] = self.model
        with self._lock:
            self._queue.append(ev)
        self._wake.set()

    def flush(self, timeout: float = 2.0) -> None:
        """Posts what's queued now (from the caller's thread). Never raises."""
        with self._post_lock:
            while True:
                with self._lock:
                    batch, self._queue = self._queue[:_MAX_BATCH], self._queue[_MAX_BATCH:]
                if not batch:
                    return
                self._post(batch, timeout)

    def _next(self, prefix: str) -> str:
        with self._lock:
            self._seq += 1
            return f"{prefix}{self._seq}"

    def _post(self, batch: List[Dict[str, Any]], timeout: float = 1.5) -> None:
        req = urllib.request.Request(f"{self.url}/api/events", data=json.dumps(batch).encode("utf-8"), headers={"content-type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                res.read()
        except urllib.error.HTTPError as err:
            self.on_error(err)
        except Exception as err:  # the office isn't running, or the network said no: drop the batch
            self.on_error(err)

    def _run(self) -> None:
        while not self._closed:
            self._wake.wait(timeout=1.0)
            self._wake.clear()
            if self._closed:
                return
            time.sleep(0.05)  # gather a batch
            if self._heartbeat_s > 0 and time.monotonic() - self._last_beat >= self._heartbeat_s:
                self._last_beat = time.monotonic()
                self.emit("heartbeat")
            self.flush()


class Subagent:
    """A subagent's handle: the same calls, filed under it."""

    def __init__(self, office: AgentOffice, sub_id: str) -> None:
        self.office = office
        self.id = sub_id

    def turn_start(self, prompt: Optional[str] = None) -> None:
        self.office.turn_start(prompt, agent=self.id)

    def turn_end(self) -> None:
        self.office.turn_end(agent=self.id)

    def tool_start(self, name: str, input: Optional[Dict[str, Any]] = None) -> str:
        return self.office.tool_start(name, input, agent=self.id)

    def tool_end(self, tool_id: str, ok: Optional[bool] = None, error: Optional[str] = None, name: str = "tool") -> None:
        self.office.tool_end(tool_id, ok, error, name, agent=self.id)

    def tool(self, name: str, input: Optional[Dict[str, Any]] = None):  # type: ignore[no-untyped-def]
        return self.office.tool(name, input, agent=self.id)

    def waiting(self, reason: str, text: Optional[str] = None) -> None:
        self.office.waiting(reason, text, agent=self.id)

    def usage(self, tokens_in: int = 0, tokens_out: int = 0, cached: int = 0, model: Optional[str] = None) -> None:
        self.office.usage(tokens_in, tokens_out, cached, model, agent=self.id)

    def end(self, ok: bool = True) -> None:
        """Done: the subagent walks its result over to its parent, then leaves."""
        self.office.emit("subagent.end", agent=self.id, **({} if ok else {"subagent": {"ok": False}}))
