#!/bin/bash
  SUDO=""
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    SUDO=sudo
  fi

  # zsh (CI's node-tests lane). In a cached environment, dpkg stopped at a
  # conffile prompt with no input and left zsh and zsh-common unpacked but not
  # configured, a state `command -v zsh` accepts. The package repair (the
  # same lines as PACKAGE_REPAIR in cloud-validation-host.mjs, which cloud
  # validation also runs before any lane) finishes any interrupted
  # configuration keeping existing conffiles and requires no package partly
  # installed; then zsh and zsh-common must both be configured.
  ZSH_OK="$(printf 'install ok installed\ninstall ok installed')"
  zsh_state() { dpkg-query -W -f='${Status}\n' zsh zsh-common 2>/dev/null; }
  partly() {
    dpkg-query -W -f='${Status} ${binary:Package}\n' \
      | awk 'NF && ($2 != "ok" || ($3 != "installed" && $3 != "config-files" && $3 != "not-installed")) { print $4 ":" $3 }'
  }
  dpkg-query -W >/dev/null || { echo "dpkg-query failed" >&2; exit 1; }
  $SUDO env DEBIAN_FRONTEND=noninteractive dpkg --force-confdef \
    --force-confold --configure -a </dev/null \
    || { echo "dpkg --configure -a failed" >&2; exit 1; }
  [ -z "$(partly)" ] \
    || { echo "dpkg left packages partly installed: $(partly | tr '\n' ' ')" >&2; exit 1; }
  if [ "$(zsh_state)" != "$ZSH_OK" ]; then
    $SUDO apt-get update </dev/null || { echo "apt update failed" >&2; exit 1; }
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y \
      -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
      zsh </dev/null || { echo "zsh install failed" >&2; exit 1; }
  fi
  [ "$(zsh_state)" = "$ZSH_OK" ] \
    || { echo "zsh is not configured: $(zsh_state | tr '\n' ' ')" >&2; exit 1; }

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
