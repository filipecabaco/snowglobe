#!/bin/sh
# The app, then a shell. The snapshot is taken at the shell's prompt, once the app answers (its
# database comes when the fleet's db service is up: the pool keeps trying).
if ! wget -q -O /dev/null http://127.0.0.1:4000/ 2>/dev/null; then
  /app/bin/todo daemon
  until wget -q -O /dev/null http://127.0.0.1:4000/ 2>/dev/null; do sleep 0.2; done
fi
echo "todo app on port 4000"
exec /bin/sh -l
