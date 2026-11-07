# Supabase: the Supabase CLI's native local stack (Postgres, PostgREST and Auth as plain processes,
# no Docker) running inside the guest, with the API answering curl in the same shell.
#
# The stack's service builds are glibc programs (2.39 or newer) and this guest is Alpine (musl),
# so Debian's glibc comes along under /usr/glibc with a loader cache of its own: glibc programs
# find only glibc libraries there, while musl ignores both. Every service is downloaded at build
# time, so nothing has to come from GitHub at run time.

# The C library the services expect from the system (everything else ships with them)
FROM debian:13.6-slim AS glibc
RUN mkdir -p /out/usr/glibc/lib /out/etc && \
    cd /lib/aarch64-linux-gnu && \
    cp -L ld-linux-aarch64.so.1 libc.so.6 libdl.so.2 libm.so.6 libpthread.so.0 libresolv.so.2 librt.so.1 \
       /out/usr/glibc/lib/ && \
    echo /usr/glibc/lib > /out/etc/ld.so.conf && \
    ldconfig -r /out && \
    rm /out/etc/ld.so.conf

FROM alpine:3.24.2
COPY --from=glibc /out/usr/glibc /usr/glibc
COPY --from=glibc /out/etc/ld.so.cache /etc/ld.so.cache
# The services' loader path (musl's own is /lib/ld-musl-aarch64.so.1, so the two don't meet), and
# the merged-/usr shell paths their scripts start with
RUN ln -s /usr/glibc/lib/ld-linux-aarch64.so.1 /lib/ld-linux-aarch64.so.1 && \
    ln -s /bin/sh /usr/bin/sh

# What the stack's scripts need, and the C++ runtime the CLI (Bun) links against
# socat carries the API from the machine's network address to the stack (start.sh)
RUN apk add --no-cache bash tar curl jq postgresql-client libstdc++ libgcc socat && \
    ln -sf /bin/bash /usr/bin/bash

# The Supabase CLI: its linux-arm64-musl build, a single Bun-compiled binary, straight from npm's
# registry (no Node). It also runs notes: with BUN_BE_BUN=1 it is Bun. The package's other binary,
# supabase-go (the older Go CLI, for commands not yet moved over), isn't needed here.
ADD --checksum=sha256:e2ea546b73b7835234489beed4a90b9788cca81c4635781baab4ae689c766cc3 \
    https://registry.npmjs.org/@supabase/cli-linux-arm64-musl/-/cli-linux-arm64-musl-2.118.0-beta.90.tgz /tmp/cli.tgz
RUN tar -xzf /tmp/cli.tgz -C /tmp package/bin/supabase && \
    install -m 755 /tmp/package/bin/supabase /usr/local/bin/supabase && \
    rm -rf /tmp/package /tmp/cli.tgz

# Postgres won't run as root, and the CLI starts everything as whoever runs it
RUN adduser -D -s /bin/bash supa
USER supa
WORKDIR /home/supa/app
ENV SUPABASE_EXPERIMENTAL_STACK=1 SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 SUPABASE_NO_UPDATE_NOTIFIER=1
# The CLI saves this with the stack, and refuses a start asking for another: the first start (below)
# and the guest's (start.sh) must agree. Long, for a slow build machine's emulated start
ENV SUPABASE_DB_HEALTH_TIMEOUT=15m
RUN supabase init --yes >/dev/null && \
    supabase stack prepare --runtime native --capability database --capability rest --capability auth && \
    # Postgres ships every extension Supabase offers; drop the big ones this demo never loads (none
    # is preloaded, and the CLI only checks its own binaries): Wrappers, PostGIS and its geometry
    # libraries, PL/Perl, PGroonga, and the charset converters for iconv
    cd ~/.supabase/cache/stack/slim-services/postgres/*/linux-arm64 && \
    rm -rf lib/wrappers-*.so share/postgresql/extension/wrappers* \
           lib/postgis*.so lib/address_standardizer*.so lib/libgdal* lib/libSFCGAL* lib/libproj* lib/libgeos* \
           share/postgresql/extension/postgis* share/postgresql/extension/address_standardizer* \
           lib/perl5 lib/plperl*.so lib/libperl.so share/postgresql/extension/plperl* \
           lib/pgroonga*.so lib/libgroonga* share/postgresql/extension/pgroonga* \
           lib/gconv && \
    du -sh .

# notes, a small app on the stack: Auth for users, the Data API (PostgREST) for the notes, row
# level security in Postgres keeping each user's notes their own. The migration is applied when
# the stack starts.
COPY --chown=supa app/notes.ts ./
COPY --chown=supa app/supabase/migrations supabase/migrations
# The stack's first start (initdb, then the migrations) here, at native speed, and stopped with its
# data kept: the guest's boot only starts it again, rather than spending most of a minute
# emulating initdb. bash is PID 1 so that it reaps the stopped services (BusyBox sh doesn't, and
# the CLI won't call a stack stopped while its processes linger as zombies)
RUN ["bash", "-c", "CI=1 supabase stack start --runtime native --eager -x realtime -x storage -x functions -x studio -x mail -x analytics -x pooler </dev/null && supabase stack stop </dev/null"]

USER root
COPY --chmod=755 start.sh /usr/local/bin/supabase-demo
# Every login shell (an agent's commands too, as root) gets the stack's variables (API_URL, DB_URL,
# ANON_KEY, ...), which start.sh writes once the stack is up
RUN printf '%s\n' '# The local Supabase stack: API_URL, DB_URL, ANON_KEY, ... (written by supabase-demo)' \
      '[ -r /home/supa/.stack-env ] && . /home/supa/.stack-env' > /etc/profile.d/supabase.sh
RUN printf '#!/bin/sh\n# notes on the Bun inside the Supabase CLI\nBUN_BE_BUN=1 exec supabase run /home/supa/app/notes.ts "$@"\n' > /usr/local/bin/notes && \
    chmod 755 /usr/local/bin/notes
ENV LANG=C.UTF-8
CMD ["/usr/local/bin/supabase-demo"]

# The network is on so the API can be reached from outside the machine: the agent page's preview
# (and snowglobe run -p 54321:54321) connect to 54321 on its network address. It is also one of the
# agent page's machines (/agent/ on the demo site), where agents build apps on it
LABEL snowglobe.title="Supabase in the browser" \
      snowglobe.memory="640" snowglobe.cpus="2" \
      snowglobe.network="fetch" \
      snowglobe.agent="true" \
      snowglobe.agent-purpose="Supabase for web app building: Postgres, Auth and the Data API, with a preview" \
      snowglobe.agent-sample='psql "$DB_URL" -c "select now()"' \
      snowglobe.agent-exposed-to='["https://chatgpt.com"]' \
      snowglobe.ready="supa:~/app$ " \
      snowglobe.exercise='["notes signup ada@example.com lovelace-1815", "notes add first program, for the analytical engine", "notes search engine", "notes ls", "notes signup grace@example.com hopper-1906", "notes ls", "psql \"$DB_URL\" -c \"select u.email, count(n.id) from auth.users u left join notes n on n.user_id = u.id group by 1\""]'
