import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true, // listen on 127.0.0.1 and ::1 (and LAN), so "localhost" always resolves
    port: 5173,
    open: true,
  },
});
