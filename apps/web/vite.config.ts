import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The version this UI was built as, to notice when the server has moved on. */
const version = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

const apiPort = process.env.MUNY_PORT ?? "8420";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __MUNY_UI_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    proxy: {
      "/api": `http://localhost:${apiPort}`,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
