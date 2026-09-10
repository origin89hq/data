import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

/**
 * The site is a plain single-page build served by the Worker's asset store. It talks to the same
 * public endpoints as anybody else — `/` for the index, `/v1/*` for the tables, `/logos/*` for the
 * marks — so nothing it shows is a copy of a number held somewhere in this repo.
 */
export default defineConfig({
  plugins: [react(), tailwind()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  // In development the Worker is the API; without this every fetch would hit Vite instead.
  server: { proxy: { "/v1": "http://localhost:8790", "/logos": "http://localhost:8790" } },
});
