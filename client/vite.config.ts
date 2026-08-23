import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Pinned + strict so the dev origin is always one the backend's
    // ALLOWED_ORIGINS trusts — silent port-drift breaks CORS.
    port: 4000,
    strictPort: true,
  },
})
