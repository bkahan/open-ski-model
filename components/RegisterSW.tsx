"use client";

// Tiny client component that registers the service worker. Mounted from
// the root layout. No UI. Only registers in production — dev gets the
// `disable` flag in next.config.mjs to avoid HMR weirdness.

import { useEffect } from "react";

export default function RegisterSW() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => {
        // Failure here just means offline won't work — not a hard error.
        console.warn("[sw] registration failed", err);
      });
  }, []);

  return null;
}
