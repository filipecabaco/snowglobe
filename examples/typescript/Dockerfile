# TypeScript + Zod: the tsx REPL (TypeScript on Node, compiled by esbuild's arm64 binary) with Zod
# installed, and the network on: fetch() and WebSocket go out through the visitor's browser.
FROM alpine:3.24.2

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

ENV LANG=C.UTF-8 PATH=/app/node_modules/.bin:$PATH
CMD ["tsx"]

# Node's REPL greeting, not just "> ", which could appear in a command's own output
LABEL snowglobe.title="TypeScript + Zod in the browser" \
      snowglobe.network="fetch" \
      snowglobe.ready="Type \".help\" for more information." \
      snowglobe.exercise='["const { z } = await import(\"zod\")", "const User = z.object({ name: z.string().min(1), email: z.email() })", "User.parse({ name: \"Ada\", email: \"ada@example.com\" })", "User.safeParse({ name: \"\", email: \"nope\" }).error?.issues.map((i) => i.message)", "type User = z.infer<typeof User>", "const u: User = { name: \"Grace\", email: \"grace@example.com\" }; u", "z.array(z.coerce.number()).parse([\"1\", \"2\", \"3\"])", "(await (await fetch(\"https://api.github.com/repos/copy/v86\")).json()).full_name", "const ws = new WebSocket(\"wss://echo.websocket.org\"); ws.onmessage = (e) => console.log(\"<\", e.data)", "ws.send(\"hello from a sandboxed tab\")"]'
