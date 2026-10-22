import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
  worker: {
    name: "clipdrop",
    compatibilityDate: "2025-09-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/worker.ts",
    observability: {
      enabled: true,
    },
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    },
    env: {
      ROOM: bindings.durableObject({
        worker: "clipdrop",
        exportName: "SessionRoom",
      }),
      GATE: bindings.durableObject({
        worker: "clipdrop",
        exportName: "RateGate",
      }),
      FILES: bindings.r2({ name: "clipdrop-files" }),
    },
    exports: {
      SessionRoom: exports.durableObject({ storage: "sqlite" }),
      RateGate: exports.durableObject({ storage: "memory" }),
    },
  },
});
