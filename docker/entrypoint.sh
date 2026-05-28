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
TOKEN="$(infisical login \
  --method=universal-auth \
  --client-id="$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID" \
  --client-secret="$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" \
  --domain="$INFISICAL_DOMAIN" \
  --plain --silent)"

if [ -z "$TOKEN" ]; then
  echo "[entrypoint] infisical login failed" >&2
  exit 1
fi

exec infisical run \
  --token="$TOKEN" \
  --domain="$INFISICAL_DOMAIN" \
  --projectId="$INFISICAL_PROJECT_ID" \
  --env="$INFISICAL_ENV" \
  --recursive \
  --silent \
  -- "$@"
