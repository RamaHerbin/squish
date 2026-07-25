/// <reference types="svelte" />
/// <reference types="vite/client" />

/**
 * The app version, frozen in at build time from `package.json` by the `define`
 * block in `vite.config.ts`. Read it through `APP_VERSION` in
 * `$lib/contracts/version` rather than touching the global directly.
 */
declare const __APP_VERSION__: string;
