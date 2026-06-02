import { defineConfig } from "vite";

// Relative base so the bundle works at a domain root (soft.oje.studio) or any
// sub-path (project Pages) without reconfiguration.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
    assetsDir: "assets",
  },
});
