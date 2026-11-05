import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor', test: /node_modules/, maxSize: 750000 },
            { name: 'app', test: /[\\/]src[\\/]/, maxSize: 750000 },
          ],
        },
      },
    },
  },
  server: {
    // dev 环境将 /api 代理到 NestJS 后端（:3000），避免跨域（§6.1 实装注记）
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
