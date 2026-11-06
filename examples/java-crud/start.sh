#!/bin/sh
# The API first, then a shell. The snapshot is taken at the shell's prompt, once the API answers,
# so visitors (and jobs) restore a server that is already up and warm. When the shell exits, the
# console starts this again; the server is still running by then.
if ! wget -q -O /dev/null http://127.0.0.1:8080/items 2>/dev/null; then
  mkdir -p /var/lib/crud
  java -XX:TieredStopAtLevel=1 -Xshare:auto -cp /app:/opt/lib/sqlite-jdbc.jar CrudServer 8080 /var/lib/crud/items.db \
    > /var/log/crud.log 2>&1 &
  until wget -q -O /dev/null http://127.0.0.1:8080/items 2>/dev/null; do sleep 0.2; done
  # A first round, so the snapshot holds a server whose code paths have run
  crud-bench 50 >/dev/null
fi
echo "crud API on http://127.0.0.1:8080/items (crud-bench N to drive it)"
exec /bin/sh -l
