#!/bin/sh
# The API first, then a shell. The snapshot is taken at the shell's prompt, once the API answers,
# so visitors (and jobs) restore a server that is already up and warm. When the shell exits, the
# console starts this again; the server is still running by then.
if ! wget -q -O /dev/null http://127.0.0.1:8080/items 2>/dev/null; then
  /app/bin/crud daemon
  until wget -q -O /dev/null http://127.0.0.1:8080/items 2>/dev/null; do sleep 0.2; done
  # A first round, so the snapshot holds a server whose code paths have run, then the rows it
  # made deleted: the API starts empty
  crud-bench 50 >/dev/null
  for id in $(wget -q -O - http://127.0.0.1:8080/items | grep -o '"id":[0-9]*' | cut -d: -f2); do
    ab -q -n 1 -m DELETE "http://127.0.0.1:8080/items/$id" >/dev/null 2>&1
  done
fi
echo "crud API on http://127.0.0.1:8080/items (crud-bench N to drive it)"
exec /bin/sh -l
