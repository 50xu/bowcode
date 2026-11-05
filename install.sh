#!/usr/bin/env bash
set -euo pipefail

VERSION=''
PORT=3001
INSTALL_SERVICE=1

usage() {
  echo 'Usage: install.sh [--version vX.Y.Z] [--no-service] [--port N]'
}

while (($#)); do
  case "$1" in
    --version)
      if (($# < 2)) || [[ ! "$2" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
        usage >&2
        exit 1
      fi
      VERSION="$2"
      shift 2
      ;;
    --no-service)
      INSTALL_SERVICE=0
      shift
      ;;
    --port)
      if (($# < 2)) || [[ ! "$2" =~ ^[0-9]+$ ]] || ((10#$2 < 1 || 10#$2 > 65535)); then
        usage >&2
        exit 1
      fi
      PORT="$2"
      shift 2
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
done

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) echo 'Bowcode supports Linux and macOS only.' >&2; exit 1 ;;
esac

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 ||
   ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
  echo 'Node.js 22+ and npm are required. Install Node.js via nvm (https://github.com/nvm-sh/nvm), mise (https://mise.jdx.dev), or Homebrew (brew install node), then retry.' >&2
  exit 1
fi

BASE='https://github.com/50xu/bowcode/releases'
if [[ -n "$VERSION" ]]; then
  URL="$BASE/download/$VERSION/bowcode-${VERSION#v}.tgz"
else
  URL="$BASE/latest/download/bowcode.tgz"
fi

PREFIX=()
GLOBAL_PREFIX="$(npm prefix -g)"
if [[ ! -d "$GLOBAL_PREFIX" || ! -w "$GLOBAL_PREFIX" ]]; then
  PREFIX=(--prefix "$HOME/.local")
  echo "Global npm prefix is not writable; installing to $HOME/.local instead." >&2
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "Ensure $HOME/.local/bin is on your PATH (for example: export PATH=\"\$HOME/.local/bin:\$PATH\")." >&2 ;;
  esac
  export PATH="$HOME/.local/bin:$PATH"
fi

npm install -g ${PREFIX[@]+"${PREFIX[@]}"} "$URL" --allow-scripts=bowcode,bcrypt,better-sqlite3,node-pty --no-fund --no-audit

if ((INSTALL_SERVICE)); then
  bowcode service install --port "$PORT"
  HOST="$(hostname)"
  echo "Open http://$HOST:$PORT and create your account."
else
  echo "Start Bowcode with: bowcode start --port $PORT"
  echo "Then open http://$(hostname):$PORT and create your account."
fi

echo 'To update later, run: bowcode update'
