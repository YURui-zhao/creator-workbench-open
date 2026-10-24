import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 支持 @/ 指向 src 目录
      '@': path.resolve(__dirname, 'src')
    }
  },
  server: {
    // 明确只监听本机 localhost，避免 host: '0.0.0.0' 导致绑定异常
    host: 'localhost',
    // 前端端口固定 5173
    port: 5173,
    // 若 5173 被占用，Vite 自动改用 5174 并在终端给出提示
    strictPort: false,
    // 不自动打开浏览器
    open: false,
    // Use polling because file-system watch events are unreliable in the current
    // local development environment, which can leave Vite module transforms stale
    // after source edits.
    watch: {
      usePolling: true,
      interval: 300
    },
    proxy: {
      // 将 /api 开头的请求代理转发到后端 3001 端口
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})
