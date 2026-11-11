#!/bin/bash
# The guest's console runs this as root; the stack runs as supa (Postgres refuses root)
if [ "$(id -u)" = 0 ]; then
  # A start that fails is reported on the kernel's console too (below), which a build's log shows
  chmod o+w /dev/ttyS0 2>/dev/null
  exec su supa -s /bin/bash -c "cd ~/app && exec /usr/local/bin/supabase-demo"
fi

echo "Starting Supabase's stack: Postgres, PostgREST, Auth and Realtime ..."
# The services are launched here directly, the way the Supabase CLI launched them when the image was
# built (capture.sh wrote down each one's command, directory and environment in ~/stack), rather
# than by the CLI: it would stay running beside them (a Bun process and a supervisor per service,
# about 120 MB of the guest's memory, and so of the snapshot). What it did besides starting them is
# done by others: Postgres listens on the TCP port the services connect to (the CLI carried that
# port to Postgres's Unix socket), and nginx is the API gateway (see capture.sh). Nothing restarts
# a service that stops once this script is done, as the CLI would; and supabase status doesn't see
# this stack (the CLI's own record of it says stopped): ~/.stack-env has its URLs and keys.
st=$HOME/stack
. "$HOME/.stack-env"
db_port=${DB_URL##*:}
db_port=${db_port%%/*}

# One service: in a session of its own (so a Ctrl-C at the prompt never reaches it), with exactly
# the environment the CLI gave it, its output in ~/stack/logs
declare -A pid
launch() {
  local env cmd
  mapfile -d '' env <"$st/$1.env"
  mapfile -d '' cmd <"$st/$1.cmd"
  (cd "$(cat "$st/$1.cwd")" && exec setsid env -i "${env[@]}" "${cmd[@]}") </dev/null >>"$st/logs/$1.log" 2>&1 &
  pid[$1]=$!
}
launch_gateway() {
  setsid nginx -c "$st/nginx.conf" -e "$st/logs/nginx.log" </dev/null >>"$st/logs/nginx.log" 2>&1 &
  pid[nginx]=$!
}
# Why a service didn't come up: on the terminal, and on the console (the terminal isn't in a
# build's log)
report() {
  { echo "supabase-demo: $1:"; tail -n 30 "$st/logs/$2.log"; } 2>/dev/null | tee -a /dev/ttyS0 2>/dev/null
}

launch postgres
for i in $(seq 600); do pg_isready -q -h 127.0.0.1 -p "$db_port" && break; sleep 0.5; done
pg_isready -q -h 127.0.0.1 -p "$db_port" || { report "Postgres didn't start" postgres; exit 1; }
launch rest
launch auth
launch realtime
launch_gateway

# Up when the gateway answers for each of them. A slow machine (the build's emulated boot) gets
# minutes, and a service that stops on the way (Realtime giving up on a database that's still
# warming up, say) is started again, up to three times
ready() {
  curl -fsS -o /dev/null -m 10 -H "apikey: $ANON_KEY" "$API_URL/rest/v1/" &&
    curl -fsS -o /dev/null -m 10 "$API_URL/auth/v1/health" &&
    curl -fsS -o /dev/null -m 10 "$API_URL/realtime/v1/api/ping"
}
declare -A starts
up=
for i in $(seq 300); do
  ready 2>/dev/null && { up=1; break; }
  for s in rest auth realtime nginx; do
    kill -0 "${pid[$s]}" 2>/dev/null && continue
    starts[$s]=$((${starts[$s]:-1} + 1))
    [ "${starts[$s]}" -le 3 ] || break 2
    report "$s stopped, starting it again (start ${starts[$s]} of 3)" "$s"
    if [ "$s" = nginx ]; then launch_gateway; else launch "$s"; fi
  done
  sleep 1
done
# Never reach the prompt (and so the snapshot) without the stack
if [ -z "$up" ]; then
  echo "Supabase's stack didn't start."
  for s in postgres rest auth realtime nginx; do report "$s's log" "$s"; done
  exit 1
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
# The watch's end doesn't stop what it started in Realtime: the app's tenant stays connected, its
# change poller asking Postgres for new rows ten times a second (about a tenth of a CPU, idle,
# in the guest). Realtime's reload of the tenant stops it all; a visitor's first watch starts it
# again, with its code already loaded by the warm-up.
curl -sS -o /dev/null -X POST -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  "$API_URL/realtime/v1/api/tenants/realtime-dev/reload"
psql "$DB_URL" -qc "delete from auth.users where email = 'warmup@example.com'; truncate notes restart identity" >/dev/null 2>&1

export PS1='\u:\w$ '
export PS1
exec bash --norc -i
