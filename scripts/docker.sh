#!/bin/sh
# Runs a command (default: bun install + bun run check) in the same bun image CI uses, with git added.
# Runs as the calling user so node_modules and bun.lock stay owned by you.
set -eu
cd "$(dirname "$0")/.."
image=opencode-git-config-sync-test
printf 'FROM oven/bun:1.4.2\nRUN DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq git >/dev/null && rm -rf /var/lib/apt/lists/*\n' |
  docker build -q -t "$image" - >/dev/null
[ $# -gt 0 ] || set -- sh -c "bun install --frozen-lockfile && bun run check"
exec docker run --rm -t --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/work -w /work "$image" "$@"
