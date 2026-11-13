#!/bin/sh
# Points the tools image at another armless, for benchmarking it: snowglobe-vm built on that
# commit (the snapshots), and the browser runtime (armless.js, armless.wasm, armless-smp.wasm)
# compiled from it instead of downloaded from a release.
#
#   bench/use-armless.sh REF     a branch, tag or full commit of github.com/filipecabaco/armless
#
# Edits internal/tools (Dockerfile, runtime/Cargo.toml and Cargo.lock) in place; `git diff` is
# the change, and builds of snowglobe after it embed the edited image. Needs git, python3 and
# Docker (Cargo.lock is updated in a Rust container).
set -eu
ref=${1:?usage: bench/use-armless.sh REF}
repo=https://github.com/filipecabaco/armless
here=$(cd "$(dirname "$0")/.." && pwd)
tools="$here/internal/tools"

# The commit: fetching it works for branches, tags and full commit ids alike
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git -C "$tmp" init -q
git -C "$tmp" fetch -q --depth 1 "$repo" "$ref"
sha=$(git -C "$tmp" rev-parse 'FETCH_HEAD^{commit}')
echo "armless $ref is $sha"

python3 - "$tools" "$sha" <<'PY'
import re, sys
tools, sha = sys.argv[1], sys.argv[2]

cargo = f"{tools}/runtime/Cargo.toml"
text = open(cargo).read()
# armless and armless-user (user mode) are pinned together
text, n = re.subn(r'(armless(?:-user)? = \{ git = "https://github.com/filipecabaco/armless", )(?:tag|rev|branch) = "[^"]*"', rf'\1rev = "{sha}"', text)
if n < 1:
    sys.exit(f"{cargo}: no armless dependency to repin")
open(cargo, "w").write(text)

docker = f"{tools}/Dockerfile"
text = open(docker).read()
stage = f"""# armless's browser runtime, compiled from {sha} (bench/use-armless.sh)
FROM rust:1.99-alpine3.22 AS web
RUN apk add --no-cache git clang lld llvm musl-dev && \\
    rustup target add wasm32-unknown-unknown && rustup component add rust-src
RUN git init -q /armless && cd /armless && \\
    git fetch -q --depth 1 https://github.com/filipecabaco/armless {sha} && git checkout -q FETCH_HEAD && \\
    sh build-wasm.sh && SMP=1 sh build-wasm.sh && \\
    mkdir -p /out/armless-web && cp js/armless.js build/armless.wasm build/armless-smp.wasm LICENSE /out/armless-web/ && \\
    tar -C /out -czf /armless-web.tar.gz armless-web

"""
text, n = re.subn(r"\nFROM alpine:", "\n" + stage + "FROM alpine:", text, count=1)
if n != 1:
    sys.exit(f"{docker}: no final stage to put the runtime build before")
text, n = re.subn(r"ADD --checksum=sha256:[0-9a-f]+ \\\n\s*https://github.com/filipecabaco/armless/releases/download/[^\s]+ /tmp/armless-web.tar.gz",
                  "COPY --from=web /armless-web.tar.gz /tmp/armless-web.tar.gz", text)
if n != 1:
    sys.exit(f"{docker}: no armless-web download to replace")
open(docker, "w").write(text)
PY

docker run --rm -v "$tools/runtime:/src" -w /src -e CARGO_NET_GIT_FETCH_WITH_CLI=true rust:1.99-alpine3.22 \
    sh -c 'apk add --no-cache -q git && cargo update -q -p armless'
grep -A1 '^name = "armless"' "$tools/runtime/Cargo.lock"
