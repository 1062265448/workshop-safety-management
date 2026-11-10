import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-dom/client', 'react-router'],
          'chart-vendor': ['recharts'],
          'spreadsheet-vendor': ['xlsx'],
          'document-vendor': ['mammoth'],
        },
      },
    },
  },
  server: {
    port: 7100,
    proxy: {
      '/api': 'http://localhost:3100',
      // 开发模式下照片经 Vite 代理到后端（生产模式由后端直接托管）
      '/uploads': 'http://localhost:3100',
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
