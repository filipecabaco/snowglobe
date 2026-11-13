#!/bin/bash
# The guest's console runs this as root; the stack runs as supa (Postgres refuses root)
if [ "$(id -u)" = 0 ]; then
  # A start that fails is reported on the kernel's console too (below), which a build's log shows
  chmod o+w /dev/ttyS0 2>/dev/null
  exec su supa -s /bin/bash -c "cd ~/app && exec /usr/local/bin/supabase-demo"
fi
export SUPABASE_EXPERIMENTAL_STACK=1 SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_NO_UPDATE_NOTIFIER=1 CI=1

echo "Starting Supabase's native stack: Postgres, PostgREST, Auth and Realtime (no Docker) ..."
# --runtime native: plain processes, no Docker. --eager: every service is up before this returns
# (they're in the snapshot) and none is stopped when idle, so a visitor never waits for a restart.
# --preparation on-demand: only the enabled services' downloads are wanted, and the image has them
# all (nothing is fetched at boot). The flags are the Dockerfile's first start's.
# Postgres's first start was at image build time; this one only starts it again. A slow build
# machine still gets a long readiness wait (SUPABASE_DB_HEALTH_TIMEOUT, set in the Dockerfile so
# both starts agree), and a start that still gives up is resumed.
for attempt in 1 2 3; do
  supabase stack start --runtime native --eager --preparation on-demand \
    -x storage -x functions -x studio -x mail -x analytics -x pooler </dev/null 2>&1 |
    grep -v -e "new version of Supabase CLI" -e "recommend updating" | tee "$HOME/.stack-start.log"
  # API_URL, DB_URL, ANON_KEY, SERVICE_ROLE_KEY, ... for the shell (the stack picks its own ports)
  eval "$(supabase status --env </dev/null 2>/dev/null)"
  [ -n "$API_URL" ] && break
  echo "The stack isn't up yet (attempt $attempt of 3), starting it again ..."
  # What failed, on the console too: the terminal above isn't in a build's log
  { echo "supabase-demo: stack start attempt $attempt of 3 failed:"; tail -n 40 "$HOME/.stack-start.log"; } \
    2>/dev/null >/dev/ttyS0
done
rm -f "$HOME/.stack-start.log"
# Never reach the prompt (and so the snapshot) without the stack
[ -n "$API_URL" ] || { echo "Supabase's stack didn't start."; exit 1; }
export API_URL DB_URL ANON_KEY SERVICE_ROLE_KEY PUBLISHABLE_KEY SECRET_KEY
# The same for every other shell (an agent's commands: /etc/profile.d/supabase.sh reads it). No
# SUPABASE_* variable of our own: the CLI reads every one as a config override (SUPABASE_API_PORT
# would be api.port), so a supabase command in such a shell would see the stack as changed.
for v in API_URL DB_URL ANON_KEY SERVICE_ROLE_KEY PUBLISHABLE_KEY SECRET_KEY; do printf "export %s='%s'\n" "$v" "${!v}"; done \
  > "$HOME/.stack-env"
# The API on the machine's network address too, at a fixed port, 54321 (Supabase's usual one): the
# stack picks its own ports, on 127.0.0.1, which nothing outside the machine reaches. The agent
# page's preview (and snowglobe run -p 54321:54321) connect there.
#  - Already answering on the network address (a stack that listens on 0.0.0.0:54321): nothing to do.
#  - The stack itself on 127.0.0.1:54321: a listener on 0.0.0.0:54321 can't be bound beside it, so
#    socat takes the network address alone.
#  - Otherwise socat listens on 0.0.0.0:54321. A socat that couldn't start says why.
api_port=${API_URL##*:}
api_port=${api_port%%/*}
net_ip=$(ip -4 -o addr show scope global 2>/dev/null | awk '{ sub(/\/.*/, "", $4); print $4; exit }')
expose_log="$HOME/.expose-54321.log"
if [ -n "$net_ip" ] && curl -fsS -o /dev/null -m 5 "http://$net_ip:54321/auth/v1/health" 2>/dev/null; then
  echo "The API already answers on $net_ip:54321" > "$expose_log"
else
  listen="TCP-LISTEN:54321,fork,reuseaddr"
  [ "$api_port" = 54321 ] && [ -n "$net_ip" ] && listen="$listen,bind=$net_ip"
  socat "$listen" "TCP:127.0.0.1:$api_port" </dev/null >"$expose_log" 2>&1 &
  expose_pid=$!
  sleep 1
  if ! kill -0 "$expose_pid" 2>/dev/null; then
    echo "Warning: the API couldn't be offered on port 54321 of the machine's network address" \
      "(the agent page's preview won't reach it): $(tail -n 3 "$expose_log")"
  fi
fi

# Warm everything a visitor's first commands go through, so it's done in the snapshot rather than
# on their clock: a first signup loads Auth's sign-up path (bcrypt, JWT signing) and opens its
# database connections; a first insert fills PostgREST's schema cache and plans the row level
# security policies; notes' first run reads Bun in; a first watch joins a Realtime channel and
# streams an insert. A throwaway user does all of it, then it's removed and the counter reset, so
# visitors start from an empty app.
curl -sS -o /dev/null "$API_URL/auth/v1/health"
curl -sS -o /dev/null -H "apikey: $ANON_KEY" "$API_URL/rest/v1/"
if notes signup warmup@example.com warmup-password >/dev/null 2>&1; then
  notes watch 60 >/dev/null 2>&1 &
  watch_pid=$!
  sleep 3
  notes add warming up >/dev/null 2>&1 && notes ls >/dev/null 2>&1 && notes search up >/dev/null 2>&1 &&
    notes login warmup@example.com warmup-password >/dev/null 2>&1
  sleep 2; kill "$watch_pid" 2>/dev/null; wait "$watch_pid" 2>/dev/null
fi
notes logout >/dev/null 2>&1
psql "$DB_URL" -qc "delete from auth.users where email = 'warmup@example.com'; truncate notes restart identity" >/dev/null 2>&1

export PS1='\u:\w$ '
export PS1
exec bash --norc -i
