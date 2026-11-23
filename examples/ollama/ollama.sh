# Read by the interactive shell ($ENV). Ollama's server starts with the first `ollama` command,
# in the page, not before the snapshot: it finds its devices once, when it starts, and the GPU
# (the visitor's WebGPU) is only there once the page runs the machine.
ollama() {
    if ! wget -q -O /dev/null http://127.0.0.1:11434/ 2>/dev/null && [ "$1" != serve ]; then
        echo "(starting Ollama's server, which looks for the GPU first)" >&2
        /usr/bin/ollama serve >/tmp/ollama.log 2>&1 &
        until wget -q -O /dev/null http://127.0.0.1:11434/ 2>/dev/null; do sleep 0.2; done
    fi
    /usr/bin/ollama "$@"
}
