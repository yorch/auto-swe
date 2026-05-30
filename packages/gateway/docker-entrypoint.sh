#!/bin/sh
set -e

# Apply pending migrations, with a timeout so a hung DB doesn't block boot
# forever. The Prisma 7 CLI binary lives at `node_modules/prisma/build/index.js`
# (called explicitly rather than via the `.bin/prisma` shim because Yarn 4's
# node-modules linker creates the shim as a symlink that Docker COPY can
# dereference inconsistently between host filesystems). Run from
# packages/shared/ so the local prisma.config.ts (with its relative
# `src/prisma/{schema.prisma,migrations}` paths) resolves correctly.
#
# The `|| { ... exit 1; }` guard is needed because `set -e` does not always
# abort on the exit status of the left side of `||` — a silent timeout would
# otherwise look like success.
echo "Running database migrations..."
cd /app/packages/shared
timeout 120 node /app/node_modules/prisma/build/index.js migrate deploy || {
  echo "ERROR: Database migrations failed or timed out after 120 seconds"
  exit 1
}
cd /app

# Hand off to the container command (CMD / compose `command`).
exec "$@"
