import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': { target: 'http://localhost:3000', changeOrigin: true },
      '/workflow': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        bypass(req) {
          // `/workflow` is also a prefix of the editor route `/workflows/...`.
          if (req.url && req.url.startsWith('/workflows')) return '/index.html'
        },
      },
      '/user': { target: 'http://localhost:3000', changeOrigin: true },
      '/webhook': { target: 'http://localhost:3000', changeOrigin: true },
      '/runs': { target: 'http://localhost:3000', changeOrigin: true },
      '/jira': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
})
