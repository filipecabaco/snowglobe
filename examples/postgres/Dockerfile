# PostgreSQL in the browser: a real Postgres 18 server from Alpine's packages, with psql attached.
FROM alpine:3.24.2

RUN apk add --no-cache postgresql18 postgresql18-client

# A cluster made at build time, sized for a browser tab: small buffers, a handful of connections,
# and no durability work, since the disk is the visitor's memory and goes away with the tab.
# The seed data is loaded here too, so the snapshot has it
COPY seed.sql /tmp/seed.sql
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
      >> /var/lib/postgresql/data/postgresql.conf && \
    install -d -o postgres -g postgres /run/postgresql && \
    su postgres -s /bin/sh -c "pg_ctl -D /var/lib/postgresql/data -w -s start && \
      psql -q -h /run/postgresql -U postgres -f /tmp/seed.sql && \
      pg_ctl -D /var/lib/postgresql/data -w -s stop" && \
    rm /tmp/seed.sql

COPY psqlrc /root/.psqlrc
COPY start.sh /usr/local/bin/start-postgres

ENV LANG=C.UTF-8 HOME=/root
WORKDIR /root
CMD ["/usr/local/bin/start-postgres"]

LABEL snowglobe.title="PostgreSQL in the browser" \
      snowglobe.agent="true" \
      snowglobe.agent-purpose="PostgreSQL for database work: load CSV files and query them with psql." \
      snowglobe.agent-sample="psql -h /run/postgresql -U postgres -tAc 'select count(*) from planets'" \
      snowglobe.agent-exposed-to='["https://chatgpt.com"]' \
      snowglobe.ready="postgres=# " \
      snowglobe.exercise='["SELECT * FROM planets ORDER BY moons DESC LIMIT 3;", "SELECT kind, count(*), sum(moons) FROM planets GROUP BY kind;", "SELECT n, n * n AS square FROM generate_series(1, 5) AS n;", "SELECT name, moons, rank() OVER (ORDER BY moons DESC) FROM planets LIMIT 5;", "\\dt+"]'
