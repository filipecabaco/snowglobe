# An Ollama model on your GPU

A chat with a model from Ollama's library, in the browser tab, its layers on the visitor's GPU.

- **The model** is pulled from registry.ollama.ai when the site is built (`MODEL`, default
  `smollm2:135m`), into Ollama's own layout under `/root/.ollama/models`. The guest fetches its
  file from the site the first time it loads it.
- **llama.cpp's server** runs it, built with armless's WebGPU backend for guests
  (armless's `gpu/guest`): its GPU work goes to the page's WebGPU through armless-gpu.js, or, run
  natively (`snowglobe run`), to the host's GPU through wgpu.
- **ollama-compat** answers Ollama's REST API in front of it (`/api/chat`, `/api/generate`,
  `/api/tags`, `/api/show`, `/api/ps`, `/api/version`, and OpenAI's `/v1/...`) on port 11434, and
  gives the terminal `ollama run`'s chat. It is not Ollama: it uses Ollama's registry and API with
  llama.cpp underneath, because Ollama's own build has no WebGPU backend.

```sh
snowglobe build examples/ollama    # another model: change ARG MODEL in the Dockerfile
snowglobe serve dist
```

The chat waits at its prompt in the snapshot; the model loads, and the GPU is connected, with the
first message. A browser without WebGPU (or a GPU without `shader-f16`, which llama.cpp's WebGPU
backend needs) runs it on the emulated CPU instead: it still answers, much more slowly.

The guest has no network: it reaches the GPU and nothing else.

Natively, `snowglobe run dist` chats in the terminal, on the host's GPU (through wgpu: Vulkan,
Metal or DX12); `snowglobe run dist --name ol --detach --fork` then `snowglobe sh ol
'ollama-compat run smollm2:135m "Hi"'` asks it from a script, each in a fresh copy of the machine.

Measured with smollm2:135m on a machine with no GPU (Mesa's lavapipe, software Vulkan, as the
GPU): 2.4 tokens/s through the browser's code path (armless.wasm and armless-gpu.js, with Dawn as
WebGPU), 1.2 natively, against 0.37 on the CPU alone.

Models are kept small by the guest's memory (`snowglobe.memory`, at most 4 GB, and less in a
browser tab) and the download: a few hundred MB is a reasonable model for a page.
