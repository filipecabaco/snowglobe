# Build-time tools for snowglobe, so the host only needs Docker: snowglobe-vm (the armless arm64
# machine, natively, to boot the guest, snapshot it and run built sites) and the browser runtime
# that gets copied into every site. Runs on the host's native architecture.

# snowglobe-vm, from runtime/ (a Rust crate on the armless library, pinned in Cargo.lock)
# armless's native JIT (Cranelift) needs Rust 1.96
FROM rust:1.99-alpine3.22 AS runtime
RUN apk add --no-cache musl-dev git
WORKDIR /src
COPY runtime/ .
ENV CARGO_NET_GIT_FETCH_WITH_CLI=true
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && \
    cp target/release/snowglobe-vm /snowglobe-vm && strip /snowglobe-vm

FROM alpine:3.24.2

WORKDIR /tools

# The browser runtime, pinned and integrity-checked: armless (armless.js, armless.wasm,
# armless-smp.wasm) from its release, and xterm.js from npm
ADD --checksum=sha256:33d6c48fe179715d3203daa06802314feb7caa94b1933f14f5b0aacb8b9c0c3a \
    https://github.com/filipecabaco/armless/releases/download/armless-v0.7.0/armless-web.tar.gz /tmp/armless-web.tar.gz
ADD --checksum=sha256:908e66e04af6c8dc6b00dd3b54de088e2e81e5ed866284fd6c2fb3c2d1c7a3f6 \
    https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz /tmp/xterm.tgz
ADD --checksum=sha256:26003b4517a132b64e4ff228fd88a5fda3fff5e606c76093f6dcff772e9ecec0 \
    https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.11.0.tgz /tmp/addon-fit.tgz

# Everything a site serves besides the page itself and the guest's files
RUN mkdir -p site/armless site/xterm /tmp/x && \
    tar -xzf /tmp/armless-web.tar.gz -C /tmp/x && \
    cp /tmp/x/armless-web/armless.js /tmp/x/armless-web/armless.wasm /tmp/x/armless-web/armless-smp.wasm \
       /tmp/x/armless-web/LICENSE site/armless/ && \
    tar -xzf /tmp/xterm.tgz -C /tmp/x && cp /tmp/x/package/lib/xterm.js /tmp/x/package/css/xterm.css site/xterm/ && \
    rm -rf /tmp/x/package && \
    tar -xzf /tmp/addon-fit.tgz -C /tmp/x && cp /tmp/x/package/lib/addon-fit.js site/xterm/ && \
    rm -rf /tmp/x /tmp/*.tgz /tmp/*.tar.gz && \
    chmod -R a+rX site

COPY --from=runtime /snowglobe-vm /tools/snowglobe-vm

ENV HOME=/tmp

# Links the image releases publish (ghcr.io/filipecabaco/snowglobe-tools) to this repository
LABEL org.opencontainers.image.source="https://github.com/filipecabaco/snowglobe" \
      org.opencontainers.image.description="snowglobe's build tools: snowglobe-vm and the browser runtime" \
      org.opencontainers.image.licenses="MIT"
