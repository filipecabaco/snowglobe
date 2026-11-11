# Rust: jtab, a CLI that renders JSON as tables, built with clap, serde_json and comfy-table.
# Cross-compiled for 64-bit ARM musl on the build machine's own architecture with Rust's bundled
# linker, so building it needs no emulation.
FROM --platform=$BUILDPLATFORM rust:1.98-slim AS build
RUN rustup target add aarch64-unknown-linux-musl
WORKDIR /src
COPY jtab ./
RUN RUSTFLAGS="-C linker=rust-lld" cargo build --release --locked --target aarch64-unknown-linux-musl

FROM alpine:3.24.2
COPY --from=build /src/target/aarch64-unknown-linux-musl/release/jtab /usr/local/bin/jtab

ENV LANG=C.UTF-8 PS1='\w $ '
WORKDIR /root
CMD ["/bin/sh"]

LABEL snowglobe.title="Rust + clap in the browser" \
      snowglobe.ready="~ $ " \
      snowglobe.exercise='["echo '"'"'[{\"name\":\"Rust\",\"year\":2015,\"typing\":\"static\"},{\"name\":\"Python\",\"year\":1991,\"typing\":\"dynamic\"},{\"name\":\"Go\",\"year\":2009,\"typing\":\"static\"}]'"'"' | jtab --where typing=static --columns name,year --sort year -r", "echo '"'"'[{\"lang\":\"rust\",\"stars\":5},{\"lang\":\"go\",\"stars\":4}]'"'"' | jtab --sort stars", "echo [] | jtab", "jtab --help"]'
