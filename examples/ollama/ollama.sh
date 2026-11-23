# Read by the interactive shell ($ENV). Ollama's server starts with the first `ollama` command,
# in the page, not before the snapshot: it finds its devices once, when it starts, and the GPU
# (the visitor's WebGPU) is only there once the page runs the machine.
ollama() {
    if ! wget -q -O /dev/null http://127.0.0.1:11434/ 2>/dev/null && [ "$1" != serve ]; then
        echo "(starting Ollama's server, which looks for the GPU first)" >&2
        /usr/bin/ollama serve >/tmp/ollama.log 2>&1 &
        # Until it has found its devices (its "inference compute" lines), not just until it answers
        until grep -q 'inference compute' /tmp/ollama.log 2>/dev/null && wget -q -O /dev/null http://127.0.0.1:11434/ 2>/dev/null; do
            sleep 0.2
        done
        if grep -q 'library=WebGPU' /tmp/ollama.log; then
            echo "(it found the GPU)" >&2
        else
            echo "(no GPU found: models run on the emulated CPU)" >&2
        fi
        # A new server's first TLS handshake runs its crypto code cold on the emulated CPU, which
        # can take longer than Go allows one (10 s); the next is quick. Before a first pull (or run,
        # which pulls), one handshake that can fail: a manifest of no repository, through the proxy
        case "$1" in pull | run)
            echo "(warming up HTTPS)" >&2
            /usr/bin/ollama pull hf.co/ggml-org/snowglobe-warm-up >/dev/null 2>&1
            ;;
        esac
    fi
    /usr/bin/ollama "$@"
}
