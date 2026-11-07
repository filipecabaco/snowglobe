import { defineConfig } from "vite";

// base "./": the built page uses relative paths, so it works under any prefix (the agent page's
// preview serves it at /snowglobe/agent/preview/web/<port>/). JSX (.jsx) needs no plugin: Vite
// compiles it with React's automatic runtime. No dev server here: the preview has no WebSockets
// for Vite's hot reload, so `serve --watch` rebuilds on each change and the agent page reloads it.
export default defineConfig({
  base: "./",
  server: { host: "0.0.0.0" },
  preview: { host: "0.0.0.0" },
});
