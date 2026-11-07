#!/bin/sh
# The web machine's console: the React app in /root/app is built and served on 0.0.0.0:4173 (where
# the agent page's preview reaches it), and built again on every change to its sources. The first
# build finishes before the prompt, so the machine's snapshot already serves the page.
# The same process is npm's registry on 127.0.0.1:4874 (/root/.npmrc), so npm install works in the browser.
cat /etc/motd-web
cd /root/app
serve --watch --registry 4874 dist 4173 >/tmp/serve.log 2>&1 &
i=0
until wget -qO- http://127.0.0.1:4173/__build 2>/dev/null | grep -q '"version":[1-9]'; do
  i=$((i + 1))
  if [ "$i" -gt 600 ]; then echo "The first build didn't finish: see /tmp/serve.log"; break; fi
  sleep 1
done
exec /bin/sh
