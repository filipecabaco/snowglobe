#!/bin/sh
# Postgres, then a shell. The snapshot is taken at the shell's prompt, with the server up.
if ! pg_isready -q -h /run/postgresql; then
  install -d -o postgres -g postgres /run/postgresql
  su postgres -s /bin/sh -c "pg_ctl -D /var/lib/postgresql/data -l /run/postgresql/server.log -w -s start"
fi
echo "postgres ready on port 5432"
exec /bin/sh -l
