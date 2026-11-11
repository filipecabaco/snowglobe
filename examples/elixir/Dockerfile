# Elixir + Ecto + PostgreSQL: a Mix release and a Postgres server, both running in the tab.
# Postgres is Alpine's own package; Postgrex is pure Elixir, so nothing needs compiling.
FROM alpine:3.24.2 AS build
RUN apk add --no-cache elixir erlang28 git
ENV MIX_ENV=prod LANG=C.UTF-8
WORKDIR /src
RUN mix local.hex --force && mix local.rebar --force
COPY mix.exs mix.lock ./
COPY config config
RUN mix deps.get --only prod && mix deps.compile
COPY lib lib
RUN mix release --path /release

FROM alpine:3.24.2
RUN apk add --no-cache libstdc++ libgcc ncurses-libs zlib postgresql18 postgresql18-client

# A cluster made at build time, sized for a browser tab: small buffers, a handful of connections,
# and no durability work, since the disk is the visitor's memory and goes away with the tab
RUN install -d -o postgres -g postgres -m 700 /var/lib/postgresql/data && \
    su postgres -s /bin/sh -c "initdb -D /var/lib/postgresql/data -U postgres --auth=trust --encoding=UTF8 --no-locale" >/dev/null && \
    printf '%s\n' \
      "listen_addresses = ''" \
      "unix_socket_directories = '/run/postgresql'" \
      "max_connections = 10" \
      "shared_buffers = 16MB" \
      "dynamic_shared_memory_type = mmap" \
      "fsync = off" \
      "synchronous_commit = off" \
      "full_page_writes = off" \
      "wal_level = minimal" \
      "max_wal_senders = 0" \
      "autovacuum = off" \
      "jit = off" \
      >> /var/lib/postgresql/data/postgresql.conf

COPY --from=build /release /app
COPY start.sh /app/start.sh

# A browser tab is one node: without distribution the prompt is a plain iex(1)>
ENV LANG=C.UTF-8 HOME=/root RELEASE_DISTRIBUTION=none
WORKDIR /app
CMD ["/app/start.sh"]

# The BEAM starts one scheduler per CPU it sees: booting on the 2 CPUs it ships with keeps its
# scheduler view true
LABEL snowglobe.title="Elixir + Postgres in the browser" \
      snowglobe.ready="iex(1)> " \
      snowglobe.memory="640" snowglobe.cpus="2" snowglobe.build-cpus="2" \
      snowglobe.exercise='["PostgresTab.Repo.query!(\"SHOW server_version\").rows", "PostgresTab.sql(\"SELECT n, n * n AS square FROM generate_series(1, 5) AS n\")", "PostgresTab.sql(\"CREATE TABLE notes (id bigserial PRIMARY KEY, body text NOT NULL)\")", "PostgresTab.Repo.insert_all(\"notes\", [%{body: \"written in a browser tab\"}, %{body: \"and read back with Ecto\"}])", "import Ecto.Query; PostgresTab.Repo.all(from n in \"notes\", order_by: n.id, select: {n.id, n.body})", "h Ecto.Query.from"]'
