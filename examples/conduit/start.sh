#!/bin/bash
# The guest's console runs this as root; the stack runs as supa (Postgres refuses root)
if [ "$(id -u)" = 0 ]; then
  exec su supa -s /bin/bash -c "cd ~/app && exec /usr/local/bin/conduit-demo"
fi
export SUPABASE_EXPERIMENTAL_STACK=1 SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_NO_UPDATE_NOTIFIER=1 CI=1

echo "Starting Supabase's native stack: Postgres, PostgREST and Auth (no Docker) ..."
# --runtime native: plain processes, no Docker. --eager: every service is up before this returns
# (they're in the snapshot) and none is stopped when idle, so a visitor never waits for a restart.
# Postgres's first start was at image build time; this one only starts it again. A slow build
# machine still gets a long readiness wait (SUPABASE_DB_HEALTH_TIMEOUT, set in the Dockerfile so
# both starts agree), and a start that still gives up is resumed.
for attempt in 1 2 3; do
  supabase stack start --runtime native --eager \
    -x realtime -x storage -x functions -x studio -x mail -x analytics -x pooler </dev/null 2>&1 |
    grep -v -e "new version of Supabase CLI" -e "recommend updating"
  # API_URL, DB_URL, ANON_KEY, SERVICE_ROLE_KEY, ... for the shell (the stack picks its own ports)
  eval "$(supabase status --env </dev/null 2>/dev/null)"
  [ -n "$API_URL" ] && break
  echo "The stack isn't up yet (attempt $attempt of 3), starting it again ..."
done
# Never reach the prompt (and so the snapshot) without the stack
[ -n "$API_URL" ] || { echo "Supabase's stack didn't start."; exit 1; }
export API_URL DB_URL ANON_KEY SERVICE_ROLE_KEY PUBLISHABLE_KEY SECRET_KEY
# The same for every other shell (an agent's commands: /etc/profile.d/supabase.sh reads it)
{
  for v in API_URL DB_URL ANON_KEY SERVICE_ROLE_KEY PUBLISHABLE_KEY SECRET_KEY; do printf "export %s='%s'\n" "$v" "${!v}"; done
  echo "export SUPABASE_API_PORT=54321"
} > "$HOME/.stack-env"
BUN_BE_BUN=1 supabase run server.mjs > /tmp/conduit-server.log 2>&1 &
for attempt in $(seq 1 30); do
  curl -fsS http://127.0.0.1:4173/ >/dev/null && break
  sleep 1
done
curl -fsS http://127.0.0.1:4173/ >/dev/null || { cat /tmp/conduit-server.log; exit 1; }
echo 'Conduit is ready on port 4173. In the agent studio select conduit, then Open the app.'
export PS1='\u:\w$ '
exec bash --norc -i
