import { defineConfig } from "tsup";

// Bundle the server and all workspace/pure-JS deps into one file. Only native
// modules stay external; the Docker image installs them separately.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Bundle everything except native modules (noExternal wins over external in tsup,
  // so the native ones are excluded from this pattern).
  noExternal: [/^(?!better-sqlite3(\/|$)).*/],
  external: ["better-sqlite3"],
  banner: {
    // Bundled CJS deps may use require/__dirname/__filename; provide them in ESM output.
    js: [
      "import { createRequire as __munyCreateRequire } from 'node:module';",
      "import { fileURLToPath as __munyFileURLToPath } from 'node:url';",
      "import { dirname as __munyDirname } from 'node:path';",
      "const require = __munyCreateRequire(import.meta.url);",
      "const __filename = __munyFileURLToPath(import.meta.url);",
      "const __dirname = __munyDirname(__filename);",
    ].join(" "),
  },
});
