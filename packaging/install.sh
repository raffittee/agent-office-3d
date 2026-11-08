#!/bin/sh
# Installs (or upgrades, or removes) Agent Office from this folder on Linux and macOS.
#
#   ./install.sh                          install to ~/.local/share/agent-office, command in ~/.local/bin
#   ./install.sh --prefix DIR --bin-dir DIR
#   ./install.sh --uninstall              remove the hooks, the command and the install folder
#
# Needs Node.js 22.12 or newer. Your own data (~/.agent-office) is never touched.
set -eu

fail() { echo "install: $*" >&2; exit 1; }

here=$(cd "$(dirname "$0")" && pwd)
prefix="${AGENT_OFFICE_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-office}"
bindir="${AGENT_OFFICE_BIN_DIR:-$HOME/.local/bin}"
action=install

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) [ $# -ge 2 ] || fail "--prefix needs a folder"; prefix=$2; shift 2 ;;
    --bin-dir) [ $# -ge 2 ] || fail "--bin-dir needs a folder"; bindir=$2; shift 2 ;;
    --uninstall) action=uninstall; shift ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown option $1 (try --help)" ;;
  esac
done

is_ours() { [ -f "$1/package.json" ] && grep -q '"name": "agent-office"' "$1/package.json"; }

if [ "$action" = uninstall ]; then
  if [ -e "$prefix" ] && ! is_ours "$prefix"; then fail "$prefix is not an Agent Office install: not removing it"; fi
  if [ -f "$prefix/bin/agent-office.mjs" ] && command -v node >/dev/null 2>&1; then
    node "$prefix/bin/agent-office.mjs" hooks uninstall --all || true
  fi
  if [ -L "$bindir/agent-office" ]; then rm -f "$bindir/agent-office"; fi
  if [ -e "$prefix" ]; then rm -rf "$prefix"; fi
  echo "Agent Office removed. Its data in ~/.agent-office was kept."
  exit 0
fi

command -v node >/dev/null 2>&1 || fail "Node.js 22.12 or newer is required (https://nodejs.org)."
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' \
  || fail "Node.js 22.12 or newer is required (found $(node -v))."
is_ours "$here" || fail "run this script from the unpacked Agent Office folder"

if [ "$prefix" = "$here" ]; then fail "the install folder can't be the folder you are installing from"; fi
if [ -e "$prefix" ] && ! is_ours "$prefix"; then fail "$prefix exists and is not an Agent Office install: choose another --prefix"; fi

parent=$(dirname "$prefix")
mkdir -p "$parent" "$bindir"
new="$prefix.new.$$"
old="$prefix.old.$$"
rm -rf "$new"
cp -R "$here" "$new"
chmod +x "$new/bin/agent-office.mjs" "$new/install.sh"
# swap in place so hooks and the plugin keep pointing at the same path across upgrades
if [ -e "$prefix" ]; then mv "$prefix" "$old"; fi
mv "$new" "$prefix"
rm -rf "$old"
ln -sf "$prefix/bin/agent-office.mjs" "$bindir/agent-office"

echo "Installed Agent Office $(node "$prefix/bin/agent-office.mjs" version) in $prefix"
case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "Add $bindir to your PATH to use the 'agent-office' command." ;;
esac
cat <<MSG

Next:
  agent-office start --open                                      run the office
  agent-office hooks install --provider gemini-cli               (optional) watch Gemini CLI
  agent-office hooks install --provider codex                    (optional) live Codex activity
  Claude Code needs nothing: the office reads its folders.
To upgrade, unpack the new version and run its install.sh again.
MSG
