import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve("electron/shared"),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve("electron/main/index.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("electron/preload/index.ts"),
        },
      },
    },
  },
  renderer: {
    root: resolve("src"),
    resolve: {
      alias: {
        "@": resolve("src"),
        "@shared": resolve("electron/shared"),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/index.html"),
        },
      },
    },
  },
});
