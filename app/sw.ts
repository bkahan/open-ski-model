// Service worker entry. Built by `@serwist/next` and emitted to /sw.js.
//
// We use the bundled `defaultCache` rules from @serwist/next which handle
// the things you usually want offline:
//   - JS/CSS chunks (precache; the App Router emits a manifest)
//   - Static images, fonts (cache-first)
//   - HTML navigations (network-first, fall back to precache)
//   - cross-origin scripts/styles (stale-while-revalidate)
//
// MapTiler tile requests are stale-while-revalidate by virtue of being
// cross-origin images. The /api/elevation route already returns
// `Cache-Control: max-age=60, s-maxage=3600`, so the browser cache layer
// handles its responses without the SW needing to touch them.

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: defaultCache,
});

serwist.addEventListeners();
