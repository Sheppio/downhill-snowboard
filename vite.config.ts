import { defineConfig } from "vite";

// `base` must match the GitHub Pages sub-path (https://<user>.github.io/downhill-snowboard/).
// Overridable so the same build can be deployed elsewhere: BASE_PATH=/ npm run build
export default defineConfig({
  base: process.env.BASE_PATH || "/downhill-snowboard/",
  server: {
    host: true, // listen on the LAN so a phone can reach the dev server
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2048, // Babylon is large by nature; the warning is noise here
  },
});
