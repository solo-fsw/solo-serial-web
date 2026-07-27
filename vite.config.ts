import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // Deploying to https://solo-fsw.github.io/solo-serial-web/
  base: "/solo-serial-web/",

  build: {
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        console: resolve(__dirname, "console.html"),
      },
    },
  },
});
