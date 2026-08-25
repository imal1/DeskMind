import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths. A packaged build is loaded from a custom protocol, not
  // from a web root, so absolute `/assets/...` references are one more thing that
  // can fail to resolve there.
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // cargo holds locks on files under target/ while it builds. Watching them
    // makes the Windows file watcher throw EBUSY and take the dev server down.
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "chrome105",
    minify: false,
    sourcemap: true,
  },
});
