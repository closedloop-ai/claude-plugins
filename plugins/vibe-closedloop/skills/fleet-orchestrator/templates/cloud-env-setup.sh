#!/bin/bash
  SUDO=""
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    SUDO=sudo
  fi

  # zsh (CI's node-tests lane)
  if ! command -v zsh >/dev/null 2>&1; then
    $SUDO apt-get update || echo "apt update failed"
    $SUDO apt-get install -y zsh || echo "zsh install failed"
  fi

  # uv + Python 3.13 (Python lanes)
  if ! command -v uv >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | sh || echo "uv failed"
  fi
  export PATH="$HOME/.local/bin:$PATH"
  uv python install 3.13 || echo "python 3.13 failed"

  # Node 24 beside the default Node 22 (vibe-eval-t0 lane)
  N24="$HOME/.node24"
  BASE="https://nodejs.org/dist/latest-v24.x"
  if [ ! -x "$N24/bin/node" ]; then
    A=$(uname -m)
    [ "$A" = "x86_64" ] && A=x64
    [ "$A" = "aarch64" ] && A=arm64
    F=$(curl -fsSL "$BASE/SHASUMS256.txt" \
      | grep -o "node-v24[^ ]*-linux-$A.tar.xz" | head -1)
    if [ -n "$F" ]; then
      mkdir -p "$N24"
      curl -fsSL "$BASE/$F" -o /tmp/n24.tar.xz || echo "n24 dl failed"
      tar -xJf /tmp/n24.tar.xz -C "$N24" --strip-components=1 \
        || echo "n24 unpack failed"
    fi
  fi

  # Node 24 and the repo's pinned pnpm as the agent's defaults.
  # The agent's shell never reads .bashrc; its PATH has ~/.local/bin ahead of /opt/node22/bin.
  mkdir -p "$HOME/.local/bin"
  for b in node npm npx corepack; do
    ln -sf "$HOME/.node24/bin/$b" "$HOME/.local/bin/$b"
  done
  # The image's pnpm self-switch leaves pnpm 12 as an unrunnable placeholder that
  # turbo can't start ("Exec format error"); corepack installs a working one.
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  "$HOME/.node24/bin/corepack" enable --install-directory "$HOME/.local/bin" pnpm || echo "corepack failed"
  rm -rf "$HOME/.local/share/pnpm/.tools"
  # Install the shared browser required by the pinned browser lanes.
  $SUDO mkdir -p /opt/pw-browsers
  $SUDO env PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers PATH="$PATH" pnpm --package=playwright@1.65.0 dlx playwright install chromium || exit 1
  test -x /opt/pw-browsers/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell || exit 1
  exit 0
