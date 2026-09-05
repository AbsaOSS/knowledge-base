#!/usr/bin/env bash
# Points the `npm ci` that follows at a private npm registry.
#
# Consuming repositories may run on runners inside a private network where
# registry.npmjs.org is unreachable and every package has to come from an
# internal mirror (a JFrog Artifactory npm remote, typically). The lockfiles in
# this repository resolve every package to registry.npmjs.org, and that is fine:
# npm's `replace-registry-host` (default `npmjs`) rewrites that host to the
# configured registry at fetch time, and the lockfile's integrity hashes still
# verify because the mirror serves the same tarballs. All that is missing is a
# way to say which registry — this script.
#
# Usage:  npm-registry.sh [DIR]
#
#   KB_NPM_REGISTRY   the registry URL. Empty: write nothing, so npm resolves
#                     the registry the ordinary way — registry.npmjs.org, or
#                     whatever the runner's own npm configuration says.
#   KB_NPM_TOKEN      optional bearer token for that registry.
#
# Writes DIR/.npmrc (default: the current directory), which npm reads as
# project-level config for anything installed from DIR. Project config layers
# on top of the runner's user and global config rather than replacing it, and
# it reaches no other step of the calling workflow.
#
# The token is written as a `${KB_NPM_TOKEN}` reference, which npm expands from
# the environment when it runs, so the secret never lands on disk. The step
# that runs `npm ci` must therefore carry KB_NPM_TOKEN in its environment.
set -euo pipefail

dir="${1:-.}"
registry="${KB_NPM_REGISTRY:-}"
token="${KB_NPM_TOKEN:-}"

if [ -z "$registry" ]; then
  exit 0
fi

# An .npmrc is line-oriented; anything that is not a single http(s) URL is
# either a typo or an attempt to smuggle a second setting in, and both should
# fail before npm sees them.
case "$registry" in
  *[[:space:]]*)
    echo "::error::npm-registry must be a single URL with no whitespace, got '$registry'"
    exit 1
    ;;
  http://*|https://*) ;;
  *)
    echo "::error::npm-registry must be an http(s) URL, got '$registry'"
    exit 1
    ;;
esac

# npm keys credentials by the registry URL without its scheme, trailing slash
# included, so normalise to exactly one.
registry="${registry%/}/"
auth_key="${registry#*:}"

{
  echo "registry=${registry}"
  if [ -n "$token" ]; then
    echo "${auth_key}:_authToken=\${KB_NPM_TOKEN}"
  fi
} > "${dir}/.npmrc"

if [ -n "$token" ]; then
  echo "npm installs from ${registry} (authenticated)"
else
  echo "npm installs from ${registry}"
fi
