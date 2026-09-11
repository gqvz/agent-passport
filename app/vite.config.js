import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // @worldcoin/idkit-core loads its sibling idkit_wasm_bg.wasm via
    // `new URL(...)`; prebundling drops it (wasm 404 → "application/wasm"
    // MIME error → widget never renders). Load it from source instead.
    exclude: ["@worldcoin/idkit", "@worldcoin/idkit-core"],
    // qrcode is CJS and imported by idkit's QR component; prebundle the exact
    // deep path so vite provides a `default` export (CJS→ESM interop).
    include: ["qrcode/lib/core/qrcode.js"],
  },
});