import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const backend = process.env.EXIDRAW_BACKEND ?? "http://localhost:8080";

export default defineConfig({
  base: "/",
  plugins: [react()],
  define: {
    // Excalidraw checks this at runtime; it must be a literal "false" for React.
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  resolve: {
    // The workspace root hoists an older React for the server's tooling; make
    // sure the SPA, Excalidraw and react-router all share web/'s React 19.
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": backend,
      "/auth": backend,
      "/mcp": backend,
      "/healthz": backend,
      "/ws": { target: backend, ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
