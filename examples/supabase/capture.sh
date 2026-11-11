#!/bin/bash
# Run once at image build time, while the Supabase CLI has the stack up: writes down how the CLI
# launched each service (its program, arguments, working directory and environment) and the keys
# and URLs it handed out, so that the guest's start (start.sh) can launch the same services with
# no CLI left running. Everything lands in ~/stack:
#   <service>.cmd, .env    the command line and environment, NUL-separated; .cwd, the directory
#   pg/                    Postgres's two config files, its socket, and the root key pgsodium reads
#   nginx.conf             the API gateway, routing paths the way the CLI's gateway does
#   ~/.stack-env           API_URL, DB_URL, ANON_KEY, ... for every shell (as supabase status --env)
set -euo pipefail
umask 077
st=$HOME/stack
mkdir -p "$st/pg" "$st/logs" "$st/nginx-tmp"

eval "$(supabase status --env </dev/null)"
port_of() { local p=${1##*:}; echo "${p%%/*}"; }
api_port=$(port_of "$API_URL")
db_port=$(port_of "$DB_URL")

# A process's environment as the CLI gave it, less what a shell sets on its own and any variable
# matching $2. (BusyBox's grep and sed have no NUL-separated mode, so bash does it.)
environ() {
  local vars v
  mapfile -d '' vars <"/proc/$1/environ"
  for v in "${vars[@]}"; do
    [[ $v =~ ^(PWD|OLDPWD|SHLVL|_)= ]] || { [ -n "${2:-}" ] && [[ $v =~ ^($2)= ]]; } || printf '%s\0' "$v"
  done
}
nul() { printf '%s\0' "$@"; }

# Postgres: the CLI runs it on a Unix socket only, from config it writes to /tmp at each start,
# and carries 127.0.0.1:$db_port to that socket itself. Here Postgres listens on that address
# directly, with the same settings, and the clients' rules for the socket apply to it too
# (supabase_admin trusted, everyone else by password, as through the CLI's proxy).
pg=$(pgrep -o -f '/\.postgres-portable-real')
mapfile -d '' argv </proc/$pg/cmdline
# Its arguments are the ones after the real program (the ones before are the bundled loader's);
# the port, addresses and config paths are replaced below
real= args=() run=
for ((i = 0; i < ${#argv[@]}; i++)); do
  if [ -z "$real" ]; then
    case ${argv[i]} in */.postgres-portable-real) real=${argv[i]} ;; esac
    continue
  fi
  case ${argv[i]} in
    -p) i=$((i + 1)) ;;
    -c) i=$((i + 1))
        case ${argv[i]} in
          unix_socket_directories=*) run=${argv[i]#*=} ;;
          listen_addresses=* | hba_file=* | config_file=*) ;;
          *) args+=(-c "${argv[i]}") ;;
        esac ;;
    *) args+=("${argv[i]}") ;;
  esac
done
[ -n "$real" ] && [ -f "$run/postgresql.conf" ] || { echo "capture: Postgres's command line isn't the expected one" >&2; exit 1; }
cp "$run/postgresql.conf" "$st/pg/postgresql.conf"
{ cat "$run/pg_hba.conf"; sed 's/^local all \([^ ]*\) /host all \1 127.0.0.1\/32 /' "$run/pg_hba.conf"; } >"$st/pg/pg_hba.conf"
key=$(tr '\0' '\n' </proc/$pg/environ | sed -n 's/^PGSODIUM_KEY_FILE=//p')
cp "$key" "$st/pg/pgsodium_root.key"
nul "$(dirname "$real")/postgres" "${args[@]}" -p "$db_port" -c listen_addresses=127.0.0.1 \
  -c "unix_socket_directories=$st/pg" -c "hba_file=$st/pg/pg_hba.conf" \
  -c "config_file=$st/pg/postgresql.conf" >"$st/postgres.cmd"
{ environ "$pg" PGSODIUM_KEY_FILE; nul "PGSODIUM_KEY_FILE=$st/pg/pgsodium_root.key"; } >"$st/postgres.env"
readlink "/proc/$pg/cwd" >"$st/postgres.cwd"

# PostgREST and Auth: their programs as the CLI started them (Auth through its bin/auth, which
# adds the memory settings the Dockerfile wrote beside it)
rest=$(pgrep -o -f '/bin/postgrest$')
nul "$(tr '\0' '\n' </proc/$rest/cmdline | head -1)" >"$st/rest.cmd"
environ "$rest" >"$st/rest.env"
readlink "/proc/$rest/cwd" >"$st/rest.cwd"
auth=$(pgrep -o -f '/bin/\.auth-wrapped$')
nul "$(dirname "$(tr '\0' '\n' </proc/$auth/cmdline | head -1)")/auth" >"$st/auth.cmd"
environ "$auth" >"$st/auth.env"
readlink "/proc/$auth/cwd" >"$st/auth.cwd"

# Realtime: what the CLI runs is the release's bin/server (bin/realtime start, which execs into the
# BEAM), so its environment is taken from beam.smp less what those scripts set themselves
# (RELEASE_*, the BEAM's paths, the options .runtime-env.sh exports), for them to set again
rt=$(pgrep -o -f '/\.beam\.smp-portable-real')
rt_root=$(tr '\0' '\n' </proc/$rt/environ | sed -n 's/^RELEASE_ROOT=//p')
nul "$rt_root/bin/server" >"$st/realtime.cmd"
{ environ "$rt" 'RELEASE_[A-Z_]+|ROOTDIR|BINDIR|EMU|PROGNAME|PHX_SERVER|TZDIR|ELIXIR_ERL_OPTIONS|PATH'
  nul "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"; } >"$st/realtime.env"
echo "$rt_root/bin" >"$st/realtime.cwd"

env_of() { tr '\0' '\n' <"$st/$1.env" | sed -n "s/^$2=//p"; }
rest_port=$(env_of rest PGRST_SERVER_PORT)
rest_admin_port=$(env_of rest PGRST_ADMIN_SERVER_PORT)
auth_port=$(env_of auth GOTRUE_API_PORT)
rt_port=$(env_of realtime PORT)
for p in rest_port rest_admin_port auth_port rt_port; do [ -n "${!p}" ] || { echo "capture: no $p" >&2; exit 1; }; done

# The API gateway: nginx, on the CLI's API address and on port 54321 of every address (the machine's
# network address, for the agent page's preview), routing the paths the CLI's gateway routes:
#  - /rest/v1 to PostgREST (and /graphql/v1 to its graphql function, /rest-admin/v1 to its admin port)
#  - /auth/v1 to Auth (its verify, callback and authorize pages passed on as they come)
#  - /realtime/v1 to Realtime's websocket (/socket), /realtime/v1/api to its HTTP API, both as the
#    tenant realtime-dev (Realtime finds the tenant in the Host header)
# Like the CLI's, it swaps the new-style keys for the JWTs the services check: an apikey header of
# sb_publishable_... or sb_secret_... becomes Authorization: Bearer <anon or service_role JWT>
# (unless the request has an Authorization of its own that isn't such a key), and the same keys in
# Realtime's ?apikey= become the JWTs. Every answer allows any origin (browsers' CORS), and a
# preflight (OPTIONS) is answered here.
cat >"$st/nginx.conf" <<EOF
# Written by supabase-demo's capture.sh at image build time
daemon off;
master_process off;
worker_processes 1;
pid $st/nginx.pid;
error_log $st/logs/nginx.log warn;
events { worker_connections 256; }
http {
  access_log off;
  client_body_temp_path $st/nginx-tmp/body;
  proxy_temp_path $st/nginx-tmp/proxy;
  fastcgi_temp_path $st/nginx-tmp/fastcgi;
  uwsgi_temp_path $st/nginx-tmp/uwsgi;
  scgi_temp_path $st/nginx-tmp/scgi;
  client_max_body_size 0;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_request_buffering off;
  proxy_read_timeout 1h;
  proxy_send_timeout 1h;

  map \$http_apikey \$key_bearer {
    "$PUBLISHABLE_KEY" "Bearer $ANON_KEY";
    "$SECRET_KEY" "Bearer $SERVICE_ROLE_KEY";
    default \$http_apikey;
  }
  map \$http_authorization \$bearer {
    "" \$key_bearer;
    "~^Bearer sb_" \$key_bearer;
    default \$http_authorization;
  }
  map \$args \$realtime_args {
    "~^(?<a>(.*&)?apikey=)$PUBLISHABLE_KEY(?<b>&.*)?\$" "\${a}$ANON_KEY\$b";
    "~^(?<a>(.*&)?apikey=)$SECRET_KEY(?<b>&.*)?\$" "\${a}$SERVICE_ROLE_KEY\$b";
    default \$args;
  }
  map \$http_upgrade \$connection_upgrade { "" ""; default upgrade; }
  map \$http_access_control_request_headers \$cors_headers {
    "" "authorization,apikey,content-type";
    default \$http_access_control_request_headers;
  }
  map \$http_content_profile \$graphql_profile { "" graphql_public; default \$http_content_profile; }

  server {
    listen 127.0.0.1:$api_port;
    $([ "$api_port" = 54321 ] || echo "listen 54321;")

    proxy_set_header Host \$http_host;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-Proto http;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Port \$server_port;
    proxy_set_header X-Forwarded-Path \$uri;
    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Methods;
    proxy_hide_header Access-Control-Allow-Headers;
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Allow-Methods "GET,POST,PUT,PATCH,DELETE,OPTIONS" always;
    add_header Access-Control-Allow-Headers \$cors_headers always;
    if (\$request_method = OPTIONS) { return 204; }

    location / { return 404 "Not Found"; }

    location ~ ^/rest/v1(/.*)?\$ {
      proxy_set_header Authorization \$bearer;
      proxy_set_header X-Forwarded-Prefix /rest/v1/;
      rewrite ^/rest/v1/?(.*)\$ /\$1 break;
      proxy_pass http://127.0.0.1:$rest_port;
    }
    location ~ ^/graphql/v1(/.*)?\$ {
      proxy_set_header Authorization \$bearer;
      proxy_set_header Content-Profile \$graphql_profile;
      proxy_set_header X-Forwarded-Prefix /graphql/v1;
      rewrite ^/graphql/v1(.*)\$ /rpc/graphql\$1 break;
      proxy_pass http://127.0.0.1:$rest_port;
    }
    location ~ ^/rest-admin/v1(/.*)?\$ {
      proxy_set_header X-Forwarded-Prefix /rest-admin/v1/;
      rewrite ^/rest-admin/v1/?(.*)\$ /\$1 break;
      proxy_pass http://127.0.0.1:$rest_admin_port;
    }

    location ~ ^/auth/v1/(?<page>verify|callback|authorize)(/.*)?\$ {
      proxy_set_header X-Forwarded-Prefix /auth/v1/\$page;
      rewrite ^/auth/v1(/.*)\$ \$1 break;
      proxy_pass http://127.0.0.1:$auth_port;
    }
    location ~ ^/\.well-known/oauth-authorization-server(/.*)?\$ {
      proxy_set_header X-Forwarded-Prefix /.well-known/oauth-authorization-server;
      proxy_pass http://127.0.0.1:$auth_port;
    }
    location ~ ^/auth/v1(/.*)?\$ {
      proxy_set_header Authorization \$bearer;
      proxy_set_header X-Forwarded-Prefix /auth/v1/;
      rewrite ^/auth/v1/?(.*)\$ /\$1 break;
      proxy_pass http://127.0.0.1:$auth_port;
    }

    location ~ ^/realtime/v1/api(/.*)?\$ {
      proxy_set_header Host realtime-dev;
      proxy_set_header Authorization \$bearer;
      proxy_set_header X-Forwarded-Prefix /realtime/v1/api;
      rewrite ^/realtime/v1/api(.*)\$ /api\$1 break;
      proxy_pass http://127.0.0.1:$rt_port;
    }
    location ~ ^/realtime/v1(/.*)?\$ {
      proxy_set_header Host realtime-dev;
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection \$connection_upgrade;
      proxy_set_header X-Forwarded-Prefix /realtime/v1/;
      set \$args \$realtime_args;
      rewrite ^/realtime/v1(.*)\$ /socket\$1 break;
      proxy_pass http://127.0.0.1:$rt_port;
    }
  }
}
EOF

# The shell's variables. No SUPABASE_* variable of our own: the CLI reads every one as a config
# override (SUPABASE_API_PORT would be api.port), so a supabase command in such a shell would see
# the stack as changed.
for v in API_URL DB_URL ANON_KEY SERVICE_ROLE_KEY PUBLISHABLE_KEY SECRET_KEY; do printf "export %s='%s'\n" "$v" "${!v}"; done \
  >"$HOME/.stack-env"
echo "capture: postgres $db_port, rest $rest_port, auth $auth_port, realtime $rt_port, API $api_port"
