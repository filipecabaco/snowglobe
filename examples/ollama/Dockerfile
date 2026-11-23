# Ollama's library models, chatting in the terminal, on the visitor's GPU. A model is pulled from
# registry.ollama.ai at build time (MODEL), and llama.cpp's server runs it, built with armless's
# WebGPU backend: the guest's GPU work goes to the page's WebGPU (armless-gpu.js), or natively to
# wgpu. ollama-compat answers Ollama's API in front of it (/api/chat, /api/generate, /api/tags…,
# on port 11434) and gives the terminal `ollama run`'s chat. It is not Ollama: see ollama-compat/.
#
# Everything is compiled on the build machine for 64-bit ARM, so building needs no emulation.
ARG MODEL=smollm2:135m

# llama.cpp, from llama-cpp-python's source package (pinned and checked), cross-compiled with Zig
# against armless's guest WebGPU header. Until armless releases it, from armless's branch.
FROM --platform=$BUILDPLATFORM python:3.13-alpine AS llama
RUN apk add --no-cache git cmake ninja llvm && pip install --no-cache-dir ziglang==0.17.1
ADD --checksum=sha256:bf4108fc76e933ea4969b61b1e281a2d232dd3e43361d1fdca5e2e029d62f729 \
    https://files.pythonhosted.org/packages/7f/9a/3ebc0b3ef42b8d9cc7d15dc9b147b3e8ce11bfdb61eb381c3eb7d9762373/llama_cpp_python-0.3.37.tar.gz /tmp/llama.tar.gz
ARG ARMLESS_REF=feat/webgpu-passthrough
RUN git clone --depth 1 --branch "$ARMLESS_REF" https://github.com/filipecabaco/armless /src/armless && \
    mkdir -p /src/llama && tar -xzf /tmp/llama.tar.gz -C /src/llama --strip-components=3 llama_cpp_python-0.3.37/vendor/llama.cpp && \
    /src/armless/gpu/guest/build-llama.sh /src/llama /out llama-server

# ollama-compat for the guest, and for this machine to pull the model with
FROM --platform=$BUILDPLATFORM golang:1.27.1-alpine AS compat
WORKDIR /src
COPY ollama-compat/go.mod ollama-compat/main.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o /ollama-compat-arm64 . && \
    CGO_ENABLED=0 go build -o /ollama-compat .
ARG MODEL
RUN OLLAMA_MODELS=/models /ollama-compat pull "$MODEL"

FROM alpine:3.24.2
COPY --from=llama /out/bin/llama-server /usr/local/bin/llama-server
COPY --from=compat /ollama-compat-arm64 /usr/local/bin/ollama-compat
COPY --from=compat /models /root/.ollama/models
ARG MODEL
ENV MODEL=$MODEL LANG=C.UTF-8 TERM=xterm-256color OLLAMA_HOST=0.0.0.0:11434
# The chat starts at its prompt, which is where the snapshot is taken: the model is loaded (and
# the GPU connected) with the first message, after the page has restored the machine
CMD ["/bin/sh", "-c", "exec ollama-compat run \"$MODEL\""]

# The GPU and no network: the guest reaches gpu.internal:7070 (answered in the page) and nothing
# else. The model's file comes from the site as the guest reads it, the first time it loads.
LABEL snowglobe.title="An Ollama model on your GPU" \
      snowglobe.ready=">>> " \
      snowglobe.gpu="on" \
      snowglobe.memory="1536"
