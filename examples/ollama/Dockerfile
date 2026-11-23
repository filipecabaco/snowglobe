# Ollama itself, the official release, in the browser tab, its models on the visitor's GPU.
#
# Nothing of Ollama's is changed. Ollama runs llama.cpp's llama-server and loads a GPU backend
# from each directory under lib/ollama (GGML_BACKEND_PATH, found by its device discovery); this
# adds one: llama.cpp's WebGPU backend, built from the llama.cpp Ollama pins, against armless's
# guest WebGPU (gpu/guest), whose GPU work goes to the page's WebGPU (or natively to wgpu).
#
# Models come with `ollama pull hf.co/OWNER/REPO[:QUANT]`, from Hugging Face's registry for
# Ollama, through the page's fetch() (the guest's HTTPS ends in the machine). Ollama's own
# registry doesn't allow browsers, so its library names can't be pulled in a page.
#
#   OLLAMA_VERSION   the Ollama release (linux-arm64)
#   LLAMA_CPP        the llama.cpp tag that release pins (its LLAMA_CPP_VERSION file)
#   MEMORY, GPU_MEMORY, TITLE

ARG OLLAMA_VERSION=v0.40.17
ARG LLAMA_CPP=b12257
ARG ARMLESS_REF=armless-v0.27.0
ARG MEMORY=1536
ARG GPU_MEMORY=4096
ARG TITLE="Ollama on your GPU"

# llama.cpp's WebGPU backend as a library Ollama loads (GGML_BACKEND_DL), for the glibc Ollama is
# built for (Debian 12's 2.36, which comes along below), cross-compiled with Zig; its WebGPU is
# armless's header
FROM --platform=$BUILDPLATFORM python:3.13-alpine AS webgpu
RUN apk add --no-cache git cmake ninja llvm && pip install --no-cache-dir ziglang==0.17.1
ARG LLAMA_CPP
ARG ARMLESS_REF
RUN git clone -q --depth 1 --branch "$ARMLESS_REF" https://github.com/filipecabaco/armless /src/armless && \
    git clone -q --depth 1 --branch "$LLAMA_CPP" https://github.com/ggml-org/llama.cpp /src/llama
RUN for t in cc c++; do \
      printf '#!/bin/sh\nexec python3 -m ziglang %s -target aarch64-linux-gnu.2.36 "$@"\n' "$t" > /usr/local/bin/zig-$t; \
    done && \
    printf '#!/bin/sh\nexec python3 -m ziglang ar "$@"\n' > /usr/local/bin/zig-ar && \
    printf '#!/bin/sh\nexec python3 -m ziglang ranlib "$@"\n' > /usr/local/bin/zig-ranlib && \
    chmod +x /usr/local/bin/zig-* && \
    cmake -S /src/llama -B /build -G Ninja \
      -DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=aarch64 \
      -DCMAKE_C_COMPILER=zig-cc -DCMAKE_CXX_COMPILER=zig-c++ -DCMAKE_AR=/usr/local/bin/zig-ar -DCMAKE_RANLIB=/usr/local/bin/zig-ranlib \
      -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON \
      -DGGML_NATIVE=OFF -DGGML_CPU=OFF -DGGML_OPENMP=OFF \
      -DGGML_WEBGPU=ON -DDawn_DIR=/src/armless/gpu/guest/cmake \
      -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
      -DLLAMA_BUILD_SERVER=OFF -DLLAMA_BUILD_TOOLS=OFF && \
    ninja -C /build ggml-webgpu && \
    mkdir -p /out && cp "$(find /build -name 'libggml-webgpu.so' | head -1)" /out/ && llvm-strip /out/libggml-webgpu.so

# The official release, without the CUDA libraries a browser can't use
FROM --platform=$BUILDPLATFORM alpine:3.24.2 AS ollama
RUN apk add --no-cache curl zstd tar
ARG OLLAMA_VERSION
RUN mkdir -p /opt/ollama && \
    curl -fsSL "https://github.com/ollama/ollama/releases/download/$OLLAMA_VERSION/ollama-linux-arm64.tar.zst" | zstd -d | tar -x -C /opt/ollama && \
    rm -rf /opt/ollama/lib/ollama/cuda_*

# Ollama is built for glibc and the guest is Alpine (BusyBox's init, which snowglobe's boot uses):
# Debian's glibc, with the C++ runtime Ollama links, comes along under /usr/glibc with a loader
# cache of its own, as in examples/supabase
FROM debian:12-slim AS glibc
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && \
    mkdir -p /out/usr/glibc/lib /out/etc && \
    cd /lib/aarch64-linux-gnu && \
    cp -L ld-linux-aarch64.so.1 libc.so.6 libdl.so.2 libm.so.6 libpthread.so.0 libresolv.so.2 librt.so.1 \
       libstdc++.so.6 libgcc_s.so.1 /out/usr/glibc/lib/ && \
    echo /usr/glibc/lib > /out/etc/ld.so.conf && \
    ldconfig -r /out && \
    rm /out/etc/ld.so.conf

FROM alpine:3.24.2
COPY --from=glibc /out/usr/glibc /usr/glibc
COPY --from=glibc /out/etc/ld.so.cache /etc/ld.so.cache
RUN ln -s /usr/glibc/lib/ld-linux-aarch64.so.1 /lib/ld-linux-aarch64.so.1 && apk add --no-cache ca-certificates
COPY --from=ollama /opt/ollama/ /usr/
COPY --from=webgpu /out/libggml-webgpu.so /usr/lib/ollama/webgpu/libggml-webgpu.so
# Ollama's server starts with the first `ollama` command (ollama.sh, which the shell reads as
# $ENV): in the page, where the GPU is, since Ollama finds its devices once, when it starts.
# Discovery probes only the WebGPU backend (the CPU is always there)
COPY ollama.sh /etc/profile.d/ollama.sh
ENV ENV=/etc/profile.d/ollama.sh OLLAMA_LLM_LIBRARY=webgpu OLLAMA_HOST=127.0.0.1:11434 HOME=/root LANG=C.UTF-8 TERM=xterm-256color
# HTTPS through armless's proxy (its web relay, proxy.internal:3128), as behind any proxy: the
# proxy resolves names, so Ollama's checks on what a registry's redirect resolves to (the
# machine's addresses for names are private ones) stay on and pass, with no --insecure
ENV HTTPS_PROXY=http://proxy.internal:3128 https_proxy=http://proxy.internal:3128 NO_PROXY=localhost,127.0.0.1,gpu.internal no_proxy=localhost,127.0.0.1,gpu.internal
# A shell; the snapshot is taken at its prompt, before Ollama has started
CMD ["/bin/sh", "-c", "PS1='$ ' exec /bin/sh -i"]

ARG MEMORY
ARG GPU_MEMORY
ARG TITLE
LABEL snowglobe.title="$TITLE" \
      snowglobe.ready="\$ " \
      snowglobe.network="fetch" \
      snowglobe.gpu="on" \
      snowglobe.memory="$MEMORY" \
      snowglobe.gpu-memory="$GPU_MEMORY"
