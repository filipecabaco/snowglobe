# Supabase: the Supabase CLI's native local stack (Postgres, PostgREST, Auth and Realtime as plain
# processes, no Docker) running inside the guest, with the API answering curl in the same shell.
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
# socat carries the API from the machine's network address to the stack (start.sh), and the fleet
# page's two-sources template answers on a port of its own with it
RUN apk add --no-cache bash tar curl jq postgresql-client libstdc++ libgcc socat && \
    ln -sf /bin/bash /usr/bin/bash

# The Supabase CLI: its linux-arm64-musl build, a single Bun-compiled binary, straight from npm's
# registry (no Node). It also runs notes: with BUN_BE_BUN=1 it is Bun. The package's other binary,
# supabase-go (the older Go CLI, for commands not yet moved over), isn't needed here.
ADD --checksum=sha256:de5eda14b9603291fcabaf09e4cb5ccc207b0327dc21ba7258e160444d182ebe \
    https://registry.npmjs.org/@supabase/cli-linux-arm64-musl/-/cli-linux-arm64-musl-3.0.0.tgz /tmp/cli.tgz
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
# bash runs the steps below as PID 1, so that it reaps the stack's stopped services (BusyBox sh
# doesn't, and the CLI won't call a stack stopped while its processes linger as zombies)
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# The stack's services, downloaded once here: a throwaway first start, then the stack destroyed with
# the downloads kept. Only the services the start enables are fetched (the lock pins a dozen, 1.8 GB
# in all, which stack install would download; these four are about 520 MB before the trim).
# Then Postgres, which ships every extension Supabase offers: the big ones this demo never loads go
# (none is preloaded, and the CLI only checks its own binaries): Wrappers, PostGIS, pgRouting and
# their geometry libraries, PL/Perl, PGroonga, and the charset converters for iconv. 390 MB
# becomes 118. In the same step, so that the image never carries them.
# Realtime boots in interactive mode, loading its modules as they are first called rather than all
# of them up front: half the CPU to its listener (0.8 s natively becomes 0.4). The CLI gives a
# service 60 seconds from launch to bind its listener (fixed, no setting), and on a slow CI runner
# the guest's boot of the embedded release ran out of it on every attempt. The CLI passes its
# services none of its own environment and doesn't set RELEASE_MODE; the launcher reads this file.
RUN supabase init --yes >/dev/null && \
    CI=1 supabase stack start --runtime native --eager --preparation on-demand \
      -x storage -x functions -x studio -x mail -x analytics -x pooler </dev/null >/dev/null && \
    supabase stack stop </dev/null && supabase stack destroy --yes </dev/null && \
    realtime_env=$(echo ~/.supabase/cache/stack/slim-services/realtime/*/linux-arm64/*/bin/.runtime-env.sh) && \
    test -f "$realtime_env" && grep -q 'RELEASE_MODE:-"embedded"' "${realtime_env%/.runtime-env.sh}/realtime" && \
    echo 'export RELEASE_MODE="${RELEASE_MODE:-interactive}"' >> "$realtime_env" && \
    echo "export ELIXIR_ERL_OPTIONS='+fnu +S 1:1 +SDio 1 +sbwt none +sbwtdcpu none +sbwtdio none +Mea min +MMmcs 0 +MBacul 0'" >> "$realtime_env" && \
    auth_env=$(echo ~/.supabase/cache/stack/slim-services/auth/*/linux-arm64/*/bin/.runtime-env.sh) && \
    test -f "$auth_env" && \
    printf '%s\n' 'export GOMEMLIMIT=32MiB GOGC=25 GOMAXPROCS=1' >> "$auth_env" && \
    cd ~/.supabase/cache/stack/slim-services/postgres/*/linux-arm64/*/ && \
    test -x bin/postgres && \
    rm -rf lib/wrappers-*.so share/postgresql/extension/wrappers* \
           lib/postgis*.so lib/address_standardizer*.so lib/libgdal* lib/libSFCGAL* lib/libproj* lib/libgeos* \
           share/postgresql/extension/postgis* share/postgresql/extension/address_standardizer* \
           lib/libpgrouting* share/postgresql/extension/pgrouting* \
           lib/perl5 lib/plperl*.so lib/libperl.so share/postgresql/extension/plperl* \
           lib/pgroonga*.so lib/libgroonga* share/postgresql/extension/pgroonga* \
           lib/gconv && \
    du -sh ~/.supabase/cache/stack/slim-services/*

# notes, a small app on the stack: Auth for users, the Data API (PostgREST) for the notes, row
# level security in Postgres keeping each user's notes their own, Realtime streaming them as
# they're written (notes watch). The migrations are applied when the stack is first started.
COPY --chown=supa app/notes.ts ./
COPY --chown=supa app/supabase/migrations supabase/migrations
# The stack's first start (initdb, then the migrations) here, at native speed, and stopped with its
# data kept: the guest's boot only starts it again, rather than spending most of a minute
# emulating initdb. The flags are start.sh's: Postgres, PostgREST, Auth and Realtime.
RUN CI=1 supabase stack start --runtime native --eager --preparation on-demand \
      -x storage -x functions -x studio -x mail -x analytics -x pooler </dev/null && \
    supabase stack stop </dev/null
SHELL ["/bin/sh", "-c"]

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
# agent page's machines (/agent/ on the demo site), where agents build apps on it. 448 MB: the
# guest's RAM counts in the browser tab whether the stack uses it or not, and an iPhone gives a tab
# little. 384 MB was tried: the guest's OOM killer took out Realtime during boot and the first
# exercise. The stack (Realtime's BEAM is the biggest part, and the CLI keeps a Bun process per
# service) leaves room for the programs' pages and a couple of notes runs at once
# With no kernel (supabase-nokernel) 640: no page cache shares the programs' file pages between
# their processes, and at 512 PostgREST and Realtime run out of memory while they start
LABEL snowglobe.title="Supabase in the browser" \
      snowglobe.memory="448" snowglobe.nokernel-memory="640" snowglobe.cpus="2" \
      snowglobe.network="fetch" \
      snowglobe.agent="true" \
      snowglobe.agent-purpose="Supabase for web app building: Postgres, Auth and the Data API, with a preview" \
      snowglobe.agent-sample='psql "$DB_URL" -c "select now()"' \
      snowglobe.agent-exposed-to='["https://chatgpt.com"]' \
      snowglobe.ready="supa:~/app$ " \
      snowglobe.exercise='["notes signup ada@example.com lovelace-1815", "notes add first program, for the analytical engine", "notes search engine", "notes ls", "notes watch 6 & sleep 2; notes add live, by Realtime; wait", "notes signup grace@example.com hopper-1906", "notes ls", "psql \"$DB_URL\" -c \"select u.email, count(n.id) from auth.users u left join notes n on n.user_id = u.id group by 1\""]'
