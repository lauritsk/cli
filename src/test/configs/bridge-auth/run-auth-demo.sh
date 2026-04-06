#!/bin/sh
set -eu

exec perl /workspaces/cli/src/test/configs/bridge-auth/auth-demo.pl "$@"
