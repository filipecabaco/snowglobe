# Bun: a JavaScript prompt (repl.js) with a web server in the same process (Bun.serve on port 3000),
# and the network on. Bun is one program and repl.js needs no shell, so it can run with no guest
# kernel: CI builds it both ways (mise.toml's EXAMPLES: bun, and bun-nokernel with --kernel none) to
# see whether Bun, on JavaScriptCore, runs in armless at all and in its user mode. Not on the site yet.
#
#   snowglobe build examples/bun --out dist/bun [--kernel none]
#   snowglobe run dist/bun
#
# Bun's own build for arm64 Linux on musl (Alpine's libc), pinned and checked against the release's
# SHASUMS256.txt. It links libstdc++ and libgcc from Alpine. curl is only for the download.
FROM alpine:3.24.2

ARG BUN_VERSION=1.4.4
ARG BUN_SHA256=57f01b02ac7113c61c935f28f38c2eab849e3c970dab21f8b640a87b1ef65009
RUN apk add --no-cache libgcc libstdc++ && \
    apk add --no-cache --virtual .fetch curl && \
    curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-aarch64-musl.zip" && \
    echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - && \
    unzip -q /tmp/bun.zip -d /tmp && \
    mv /tmp/bun-linux-aarch64-musl/bun /usr/local/bin/bun && \
    rm -rf /tmp/bun.zip /tmp/bun-linux-aarch64-musl && \
    apk del .fetch && \
    bun --version

WORKDIR /app
COPY repl.js ./

ENV LANG=C.UTF-8
CMD ["bun", "/app/repl.js"]

# memory: with a kernel, 384 MB as the web image has. With none there is no kernel or init, and Bun is
# one process: it held 38 MB (rss-mb, the last exercise, with a kernel; armless's user mode reports its
# resident memory too, from armless 0.23.0: it prints 16 here: the pages the process touched), so 128 MB, which matters on a phone.
# The exercises run its server, its file API and a fetch through the network, so the files they read
# are in the snapshot's warm pack
LABEL snowglobe.title="Bun in the browser" \
      snowglobe.network="fetch" \
      snowglobe.memory="384" \
      snowglobe.nokernel-memory="128" \
      snowglobe.ready="Type JavaScript, or .help" \
      snowglobe.exercise='["Bun.version", "console.log(\"snowglobe-\" + 6 * 7)", "const r = await fetch(\"http://127.0.0.1:3000/hello\")", "await r.json()", "await Bun.write(\"/tmp/hello.txt\", \"hello from Bun\")", "await Bun.file(\"/tmp/hello.txt\").text()", "Bun.hash(\"snowglobe\")", "(await fetch(\"https://api.github.com/zen\")).status", "console.log(\"rss-mb\", Math.round(process.memoryUsage().rss / 1048576))"]'
