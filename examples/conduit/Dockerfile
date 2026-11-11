# Conduit and Supabase in one ARM64 Linux guest. The native Supabase setup follows
# ../supabase/Dockerfile; keep the CLI and glibc versions in sync.
FROM node:24-alpine AS frontend
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/ ./
RUN npm run build

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
# Keep this package layer shared with the base Supabase example.
RUN apk add --no-cache bash tar curl jq postgresql-client libstdc++ libgcc socat && \
    ln -sf /bin/bash /usr/bin/bash

# The Supabase CLI: its linux-arm64-musl build, a single Bun-compiled binary, straight from npm's
# registry (no Node). It runs the static server with BUN_BE_BUN=1. Its other binary,
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

COPY --chown=supa app/supabase/migrations supabase/migrations
RUN ["bash", "-c", "CI=1 supabase stack start --runtime native --eager -x realtime -x storage -x functions -x studio -x mail -x analytics -x pooler </dev/null && supabase stack stop </dev/null"]
COPY --from=frontend --chown=supa /app/dist ./dist
USER root
COPY --chmod=755 start.sh /usr/local/bin/conduit-demo
COPY server.mjs /home/supa/app/server.mjs
RUN printf '%s\n' '[ -r /home/supa/.stack-env ] && . /home/supa/.stack-env' > /etc/profile.d/supabase.sh
ENV LANG=C.UTF-8
CMD ["/usr/local/bin/conduit-demo"]
LABEL snowglobe.title="Conduit + Supabase" \
      snowglobe.memory="768" snowglobe.cpus="2" \
      snowglobe.network="fetch" snowglobe.agent="true" \
      snowglobe.agent-purpose="Conduit blogging app and Supabase together; open port 4173 to use the app" \
      snowglobe.agent-sample='curl -s http://127.0.0.1:4173/ | head -c 200' \
      snowglobe.ready="supa:~/app$ " \
      snowglobe.exercise='["curl -s http://127.0.0.1:4173/ | head -c 200", "psql \"$DB_URL\" -c \"select count(*) from articles\""]'
