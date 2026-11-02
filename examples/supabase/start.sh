#!/bin/bash
# The guest's console runs this as root; the stack runs as supa (Postgres refuses root)
if [ "$(id -u)" = 0 ]; then
  exec su supa -s /bin/bash -c "cd ~/app && exec /usr/local/bin/supabase-demo"
fi
export SUPABASE_EXPERIMENTAL_STACK=1 SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 CI=1

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
# curl with the service role's key, for the REST API
sb-auth() { curl -sS -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" "$@"; }
export -f sb-auth

# Warm everything a visitor's first commands go through, so it's done in the snapshot rather than
# on their clock: a first signup loads Auth's sign-up path (bcrypt, JWT signing) and opens its
# database connections; a first insert fills PostgREST's schema cache and plans the row level
# security policies; notes' first run reads Bun in. A throwaway user does all of it, then it's
# removed and the counter reset, so visitors start from an empty app.
curl -sS -o /dev/null "$API_URL/auth/v1/health"
curl -sS -o /dev/null -H "apikey: $ANON_KEY" "$API_URL/rest/v1/"
notes signup warmup@example.com warmup-password >/dev/null 2>&1 &&
  notes add warming up >/dev/null 2>&1 && notes ls >/dev/null 2>&1 && notes search up >/dev/null 2>&1 &&
  notes login warmup@example.com warmup-password >/dev/null 2>&1
notes logout >/dev/null 2>&1
psql "$DB_URL" -qc "delete from auth.users where email = 'warmup@example.com'; truncate notes restart identity" >/dev/null 2>&1


cat <<'MOTD'

  Supabase's local stack, running natively in this machine: Postgres, PostgREST and Auth.
  notes is a small app on it, run by Bun: Auth for users, the Data API for notes, row level
  security keeping each user's notes their own. Try:

    notes signup ada@example.com lovelace-1815
    notes add first program, for the analytical engine
    notes search engine
    notes ls
    notes signup grace@example.com hopper-1906 && notes ls     # Grace can't see Ada's notes
    psql "$DB_URL" -c "select email from auth.users"
    sb-auth "$API_URL/rest/v1/notes" | jq                     # the service role sees them all
    supabase stack status

MOTD
export PS1='\u:\w$ '
export PS1
exec bash --norc -i
