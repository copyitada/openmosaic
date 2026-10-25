import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The preview origin(s) allowed to reach the dev server. Supplied at runtime so
// no environment-specific hostname is baked into the repo. Vite also honours
// __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS, this is the explicit belt-and-braces.
const extraHosts = (process.env.PREVIEW_HOST ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean)

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: extraHosts.length > 0 ? extraHosts : undefined,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
