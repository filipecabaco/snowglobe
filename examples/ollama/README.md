# Ollama on your GPU

Ollama itself, the official release unchanged, in the browser tab, its models on the visitor's
GPU. The site carries no model: the visitor pulls one at a shell prompt.

```
$ ollama pull hf.co/bartowski/SmolLM2-135M-Instruct-GGUF
$ ollama run hf.co/bartowski/SmolLM2-135M-Instruct-GGUF
```

- **Ollama** is its `ollama-linux-arm64` release (`OLLAMA_VERSION`). It runs llama.cpp's
  `llama-server` and loads a GPU backend from each directory under `lib/ollama`; this example
  adds one, `lib/ollama/webgpu/libggml-webgpu.so`: llama.cpp's WebGPU backend, built from the
  llama.cpp version that release pins (`LLAMA_CPP`, its `LLAMA_CPP_VERSION`) against armless's
  guest WebGPU (`gpu/guest`), whose GPU work goes to the page's WebGPU (natively, to wgpu).
  Ollama's own device discovery finds it (`OLLAMA_LLM_LIBRARY=webgpu` skips the CUDA probes).
- **Its server starts with the first `ollama` command** (`ollama.sh`, read by the shell as
  `$ENV`): Ollama finds its devices once, when it starts, and the GPU is only there once the
  page runs the machine, after the snapshot (which is taken at the shell's prompt).
- **Models** come with `ollama pull hf.co/OWNER/REPO[:QUANT]` (Q4_K_M unless said) from Hugging
  Face's registry for Ollama, which lets browsers in: the guest's HTTPS goes through armless's
  proxy (`HTTPS_PROXY=http://proxy.internal:3128`) and out as the page's fetch(). Behind a
  proxy Ollama leaves names to it, so its checks on where a registry's redirect resolves to stay
  on and pass. Ollama's own registry doesn't let browsers in, so its library names
  (`qwen3:0.6b`) can't be pulled in a page. Models to pull:
  [huggingface.co/models?library=gguf](https://huggingface.co/models?library=gguf&sort=downloads).
- **The guest is Alpine** (snowglobe's boot is BusyBox's init) with Debian's glibc under
  `/usr/glibc` for Ollama, as in `examples/supabase`.

```sh
snowglobe build examples/ollama
snowglobe serve dist
```

`MEMORY` (1536 MB) and `GPU_MEMORY` (4096 MB) size the machine: a model's weights go to the
GPU, and a pulled model's file lives in the machine's filesystem (in the tab, and in its saves).
Downloads go through the emulated network, at a few MB/s. A browser without WebGPU (or a GPU
without `shader-f16`, which llama.cpp's WebGPU backend needs) runs the model on the emulated CPU.
