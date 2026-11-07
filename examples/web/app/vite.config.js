import { defineConfig } from "vite";

// base "./": the built page uses relative paths, so it works under any prefix (the agent page's
// preview serves it at /snowglobe/agent/preview/web/<port>/)
export default defineConfig({
  base: "./",
  server: { host: "0.0.0.0" },
  preview: { host: "0.0.0.0" },
});
