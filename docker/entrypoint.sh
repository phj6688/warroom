#!/bin/sh
# Bootstrap Infisical universal-auth, then exec the app with secrets injected as env.
set -e

# Read bootstrap creds from docker-compose secrets: mounts if not already set.
if [ -z "$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID" ] && [ -r /run/secrets/infisical_client_id ]; then
  INFISICAL_UNIVERSAL_AUTH_CLIENT_ID="$(cat /run/secrets/infisical_client_id)"
fi
if [ -z "$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" ] && [ -r /run/secrets/infisical_client_secret ]; then
  INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET="$(cat /run/secrets/infisical_client_secret)"
fi

: "${INFISICAL_DOMAIN:=http://infisical:8080}"
: "${INFISICAL_ENV:=prod}"

if [ -z "$INFISICAL_PROJECT_ID" ] || [ -z "$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID" ] || [ -z "$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" ]; then
  echo "[entrypoint] missing Infisical bootstrap. need: INFISICAL_PROJECT_ID + INFISICAL_UNIVERSAL_AUTH_CLIENT_ID + INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET (env or /run/secrets/infisical_client_{id,secret})" >&2
  exit 1
fi

# Exchange client-id/secret for an access token. --plain emits just the token.
# The token goes to `infisical run` through the environment, not argv, so it
# is not readable from /proc/<pid>/cmdline.
INFISICAL_TOKEN="$(infisical login \
  --method=universal-auth \
  --client-id="$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID" \
  --client-secret="$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" \
  --domain="$INFISICAL_DOMAIN" \
  --plain --silent)"

if [ -z "$INFISICAL_TOKEN" ]; then
  echo "[entrypoint] infisical login failed" >&2
  exit 1
fi

# The CLI prefers INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN over INFISICAL_TOKEN, so drop a stale inherited value.
unset INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN
export INFISICAL_TOKEN

# --log-level=info keeps the CLI from printing its environment (token included)
# when the app is run with LOG_LEVEL=debug. `env -u` keeps the token out of the
# app process, which only needs the injected secrets.
exec infisical run \
  --log-level=info \
  --domain="$INFISICAL_DOMAIN" \
  --projectId="$INFISICAL_PROJECT_ID" \
  --env="$INFISICAL_ENV" \
  --recursive \
  --silent \
  -- env -u INFISICAL_TOKEN -u INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN "$@"
