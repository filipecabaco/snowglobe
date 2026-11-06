# Postgres for the todo fleet: a cluster made at build time with the todos table, listening on the
# guest's network for the app's machines (through the fleet's forwarded port).
FROM alpine:3.24.3
RUN apk add --no-cache postgresql18 postgresql18-client

# Small, and without durability work: the data lives in the machine's memory. Any client the
# forwarded port lets in is trusted: the port is the fleet's, on the host
RUN install -d -o postgres -g postgres -m 700 /var/lib/postgresql/data /run/postgresql && \
    su postgres -s /bin/sh -c "initdb -D /var/lib/postgresql/data -U postgres --auth=trust --encoding=UTF8 --no-locale" >/dev/null && \
    printf '%s\n' \
      "listen_addresses = '*'" \
      "unix_socket_directories = '/run/postgresql'" \
      "max_connections = 20" \
      "shared_buffers = 16MB" \
      "dynamic_shared_memory_type = mmap" \
      "fsync = off" \
      "synchronous_commit = off" \
      "full_page_writes = off" \
      "autovacuum = off" \
      "jit = off" \
      >> /var/lib/postgresql/data/postgresql.conf && \
    echo "host all all 0.0.0.0/0 trust" >> /var/lib/postgresql/data/pg_hba.conf
COPY schema.sql /schema.sql
RUN su postgres -s /bin/sh -c "pg_ctl -D /var/lib/postgresql/data -w -s start" && \
    psql -h /run/postgresql -U postgres -q -c 'CREATE DATABASE todo' && \
    psql -h /run/postgresql -U postgres -q -d todo -f /schema.sql && \
    su postgres -s /bin/sh -c "pg_ctl -D /var/lib/postgresql/data -w -s stop"
COPY start.sh /start.sh
CMD ["/start.sh"]

LABEL snowglobe.title="Postgres for the todo fleet" \
      snowglobe.ready="postgres ready on port 5432" \
      snowglobe.memory="384"
