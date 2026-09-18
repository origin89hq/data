import { fileURLToPath } from "node:url";
import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const worker = "http://localhost:8790";

/**
 * The site is a plain single-page build served by the Worker's asset store. It talks to the same
 * public endpoints as anybody else — `/` for the index, `/v1/*` for the tables, `/logos/*` for the
 * marks — so nothing it shows is a copy of a number held somewhere in this repo.
 *
 * The runs page is a second entry, so the public page's bundle does not carry it. The Worker
 * serves it at `/ops`, to members only.
 */
export default defineConfig({
  plugins: [
    react(),
    tailwind(),
    {
      name: "ops-history-fallback",
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url && /^\/ops(?:[/?]|$)/.test(request.url)) {
            const url = new URL(request.url, "http://localhost");
            request.url = `/ops.html${url.search}`;
          }
          next();
        });
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rolldownOptions: {
      input: {
        site: fileURLToPath(new URL("index.html", import.meta.url)),
        ops: fileURLToPath(new URL("ops.html", import.meta.url)),
        spike: fileURLToPath(new URL("ops-spike.html", import.meta.url)),
      },
    },
  },
  // In development the Worker is the API; without this every fetch would hit Vite instead. The
  // runs page's routes want a session: sign in at the Worker's /auth/login first, and the cookie
  // it sets for localhost comes along.
  server: {
    proxy: Object.fromEntries(
      [
        "/manifest.json",
        "/v1",
        "/logos",
        "/auth",
        "/state",
        "/runs",
        "/supervision",
        "/activity",
        "/releases",
        "/release-compare",
        "/archive",
        "/approve",
        "/maker",
        "/run",
      ].map((path) => [path, worker]),
    ),
  },
});
