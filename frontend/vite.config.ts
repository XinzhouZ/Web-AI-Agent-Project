import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 开发模式代理到 FastAPI（生产由 nginx 反代）
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
    },
  },
});
