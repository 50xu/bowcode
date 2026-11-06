#!/usr/bin/env bash
set -euo pipefail

VERSION=''
CHANNEL='stable'
PORT=3001
INSTALL_SERVICE=1

usage() {
  echo 'Usage: install.sh [--version vX.Y.Z[-prerelease]] [--channel stable|beta] [--no-service] [--port N]'
}

while (($#)); do
  case "$1" in
    --version)
      if (($# < 2)) || [[ ! "$2" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
        usage >&2
        exit 1
      fi
      VERSION="$2"
      shift 2
      ;;
    --channel)
      if (($# < 2)) || [[ "$2" != stable && "$2" != beta ]]; then
        usage >&2
        exit 1
      fi
      CHANNEL="$2"
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
   ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 22) ? 0 : 1)' >/dev/null 2>&1; then
  echo 'Node.js 22.22+ (24 or 26 recommended) and npm are required. Install Node.js via nvm (https://github.com/nvm-sh/nvm), mise (https://mise.jdx.dev), or Homebrew (brew install node), then retry.' >&2
  exit 1
fi

BASE='https://github.com/50xu/bowcode/releases'
if [[ -n "$VERSION" ]]; then
  URL="$BASE/download/$VERSION/bowcode-${VERSION#v}.tgz"
elif [[ "$CHANNEL" == beta ]]; then
  VERSION="$(curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: bowcode-installer' \
    'https://api.github.com/repos/50xu/bowcode/releases?per_page=30' | node -e '
      let body = "";
      process.stdin.on("data", chunk => { body += chunk; });
      process.stdin.on("end", () => {
        try {
          const release = JSON.parse(body).find(item => !item.draft && /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item.tag_name));
          if (!release) process.exitCode = 1;
          else process.stdout.write(release.tag_name);
        } catch { process.exitCode = 1; }
      });
    ')" || { echo 'No beta release found.' >&2; exit 1; }
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
