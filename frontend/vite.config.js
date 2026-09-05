import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// SPA talking to PocketBase. In dev, /api is proxied to the local PB so the
// browser stays same-origin (no CORS config needed). Override at build time
// with VITE_PB_URL for a remote backend.
export default defineConfig({
  plugins: [svelte()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.VITE_PB_URL || "http://127.0.0.1:8090",
        changeOrigin: true
      }
    }
  },
  build: {
    target: "es2022",
    // Previews run behind Open WebUI's /proxy/<port>/ path — keep relative.
    assetsInlineLimit: 0
  }
});
