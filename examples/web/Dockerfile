# web: a machine for building web pages. Node from Alpine's packages, and a React app in /root/app
# (Vite, React and supabase-js already installed, pinned by its lockfile), so a page builds with no
# network. At boot `serve --watch` builds it, serves it on the machine's network address (where the
# agent page's preview reaches it), and builds it again on every change to its sources.
FROM alpine:3.24.2

RUN apk add --no-cache nodejs npm

WORKDIR /root/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY app/vite.config.js app/index.html app/.env ./
COPY app/src ./src
# The app builds (checked here; the machine builds it again at boot)
RUN npx vite build --logLevel warn && rm -rf dist
COPY --chmod=755 serve.mjs /usr/local/bin/serve
COPY --chmod=755 start.sh /usr/local/bin/web-demo

RUN printf '%s\n' \
      '' \
      '  A React app in /root/app (Vite, React, supabase-js), on the supabase machine'"'"'s notes table.' \
      '  It is served on 0.0.0.0:4173 and rebuilt on every change to src/ (serve --watch dist 4173,' \
      '  its log in /tmp/serve.log). Try:' \
      '' \
      '    sed -i "s/<h1>Notes/<h1>My notes/" src/App.jsx   # the preview reloads with it' \
      '    wget -qO- 127.0.0.1:4173/__build                  # how the last build went' \
      '    npm run build                                     # a one-off build into dist/' \
      '' \
      '  Servers must listen on 0.0.0.0 (vite preview --host 0.0.0.0), not localhost.' \
      '' > /etc/motd-web

ENV LANG=C.UTF-8 PATH=/root/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin PS1='\w $ '
CMD ["/usr/local/bin/web-demo"]

# One of the agent page's machines (/agent/ on the demo site): agents change the app here and see it
# rebuilt in the page's preview. The network is on so the preview can reach its server (and the
# machine can fetch through the browser, as the page's own requests). agent-watch: the directory
# whose changes the agent page shows after each command (a diff of the files a command changed)
LABEL snowglobe.title="React + Vite in the browser" \
      snowglobe.memory="640" \
      snowglobe.network="fetch" \
      snowglobe.ready="~/app $ " \
      snowglobe.agent="true" \
      snowglobe.agent-purpose="Build web apps: a React app on Supabase, rebuilt and served on port 4173 as it changes (Vite, Node)" \
      snowglobe.agent-sample="cd /root/app && sed -i 's/<h1>Notes/<h1>My notes/' src/App.jsx" \
      snowglobe.agent-watch="/root/app" \
      snowglobe.agent-exposed-to='["https://chatgpt.com"]' \
      snowglobe.exercise='["node -e \"console.log(6 * 7)\"", "wget -qO- 127.0.0.1:4173/__build", "ls src"]'
