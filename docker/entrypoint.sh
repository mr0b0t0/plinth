#!/bin/sh
# Container entrypoint (docs/docker.md). With no arguments: set the instance up from the PLINTH_*
# environment variables if needed, then run it in the foreground; `docker stop` stops it cleanly.
# With arguments, they are a plinth command instead, e.g. `status` or `connect`.
set -eu

if [ "$#" -gt 0 ]; then
  exec plinth "$@"
fi

# configure.mjs prints the `plinth start` arguments, one per line.
args=$(node /app/docker/configure.mjs)
IFS='
'
# shellcheck disable=SC2086 # split on newlines into one argument per line
set -- $args
unset IFS
exec plinth "$@"
