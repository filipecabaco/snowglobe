# web: a machine for building web pages. Node from Alpine's packages, and a ready Vite project in
# /root/app with Vite, esbuild and supabase-js already installed (pinned by its lockfile), so a
# page builds with no network. `serve` serves what it built on the machine's network address, where
# the agent page's preview reaches it.
FROM alpine:3.24.2

RUN apk add --no-cache nodejs npm

WORKDIR /root/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY app/vite.config.js app/index.html ./
COPY app/src ./src
# The skeleton builds (checked here; its output is not kept)
RUN npx vite build --logLevel warn && rm -rf dist
COPY --chmod=755 serve.mjs /usr/local/bin/serve

RUN printf '%s\n' \
      '' \
      '  A Vite project in /root/app (vanilla JS), with supabase-js installed. Try:' \
      '' \
      '    npm run build                 # dist/, with relative paths (base: "./")' \
      '    serve dist 4173 &             # on 0.0.0.0:4173, for the agent page'"'"'s preview' \
      '' \
      '  Servers must listen on 0.0.0.0 (vite preview --host 0.0.0.0), not localhost.' \
      '' > /etc/motd-web

ENV LANG=C.UTF-8 PATH=/root/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin PS1='\w $ '
CMD ["/bin/sh", "-c", "cat /etc/motd-web; exec /bin/sh"]

# One of the agent page's machines (/agent/ on the demo site): agents write a page here, build it,
# serve it, and open it in the page's preview. The network is on so the preview can reach its
# servers (and the machine can fetch through the browser, as the page's own requests)
LABEL snowglobe.title="Node + Vite in the browser" \
      snowglobe.memory="640" \
      snowglobe.network="fetch" \
      snowglobe.ready="~/app $ " \
      snowglobe.agent="true" \
      snowglobe.agent-purpose="Build and serve web pages: Node with Vite and esbuild" \
      snowglobe.agent-sample="cd /root/app && npm run build && (serve dist 4173 >/tmp/serve.log 2>&1 &)" \
      snowglobe.agent-exposed-to='["https://chatgpt.com"]' \
      snowglobe.exercise='["node -e \"console.log(6 * 7)\"", "npm run build", "ls dist"]'
