# Agent Office

A 3D office in your browser that shows, live, what your AI coding agents are doing (Claude Code, Gemini CLI, Codex
and your own agents). This is the release package: everything is built, nothing else to download.

You need **Node.js 22.12 or newer** ([nodejs.org](https://nodejs.org)).

## Install

**Windows** (PowerShell, in this folder):

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1          # add -AddToPath for the agent-office command
```

**Linux and macOS** (in this folder):

```sh
./install.sh
```

Both copy the package to a fixed folder (Windows: `%LOCALAPPDATA%\AgentOffice`; Linux and macOS:
`~/.local/share/agent-office`), so you can upgrade later by unpacking a newer package and running its installer.
Your own data in `~/.agent-office` is never touched.

Or skip the installer and run it from here: `node bin/agent-office.mjs start --open`.

## Use

```sh
agent-office start --open          # the office, at http://127.0.0.1:4848
agent-office start --demo          # simulated agents, to look around
agent-office hooks install --provider gemini-cli     # optional: watch Gemini CLI (>= 0.65)
agent-office hooks install --provider codex          # optional: live Codex activity
agent-office usage install                            # optional: Claude Code plan-usage bars
agent-office hooks uninstall --all                    # undo every hook
```

Claude Code needs nothing installed: the office reads its folders (read-only).

Approving permission requests and sending messages from the office are **off by default** and need
`AGENT_OFFICE_INTERACTIVE=1`. Read `docs/interactive.md` first. The threat model is in `docs/security.md`.

## Uninstall

```sh
./install.sh --uninstall                                         # Linux and macOS
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall    # Windows
```

This removes the hooks, the command, the shortcut and the install folder.

## Claude Code messages plugin (optional)

```sh
claude plugin marketplace add <install folder>
claude plugin install agent-office-messages@agent-office
```

## Verify the download

The release page lists a `SHA256SUMS` file. Check your download against it, for example with
`sha256sum -c SHA256SUMS --ignore-missing` or `Get-FileHash <file>`.

MIT licensed. Third-party notices are in `NOTICE.md` and `ASSETS.md`.
