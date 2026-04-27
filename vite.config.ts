import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Tauri dev server port
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Watch the Tauri src dir too
      ignored: ['**/src-tauri/**'],
    },
  },
  // Prevent vite from obscuring Rust errors
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-jszip': ['jszip'],
        },
      },
    },
  },
})
