/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

// COOP/COEP required for SharedArrayBuffer → threaded wasm codecs.
function crossOriginIsolation(): Plugin {
  const setHeaders = (res: { setHeader(name: string, value: string): void }) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  };
  return {
    name: 'cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        setHeaders(res);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        setHeaders(res);
        next();
      });
    },
  };
}

// `file_handlers.accept` — hand-mirrored from `EXTENSION_BY_MIME` /
// `MIME_BY_EXTENSION` in `src/lib/contracts/image.ts` (this file can't
// import app source: it's evaluated by Vite's own Node process, and a
// contracts typo shouldn't be able to break every agent's dev server).
// Keep in sync if that table changes.
const IMAGE_FILE_HANDLER_ACCEPT: Record<string, string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg', '.jpe'],
  'image/webp': ['.webp'],
  'image/avif': ['.avif'],
  'image/jxl': ['.jxl'],
  'image/gif': ['.gif'],
  'image/bmp': ['.bmp'],
  'image/tiff': ['.tif', '.tiff'],
  'image/qoi': ['.qoi'],
  'image/heic': ['.heic'],
  'image/heif': ['.heif'],
  'image/svg+xml': ['.svg'],
};

/**
 * `package.json` is the single source of truth for the app version: this
 * `define` is what lets `src/lib/contracts/version.ts` hand it to the UI, and
 * `src-tauri/tauri.conf.json` points its own `version` at the same file. Read
 * as JSON rather than imported so this config keeps its "no app source"
 * property — package.json is metadata, not a module.
 */
const { version: APP_VERSION } = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

export default defineConfig({
  // The version is frozen into the bundle as a literal, so nothing has to
  // restate it. `src/lib/contracts/version.test.ts` asserts every surface that
  // carries a version still agrees with package.json.
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  // NOTE ($lib alias): tsconfig.json declares `paths: { "$lib/*": [...] }`
  // for editor/type-checking support, but Vite itself never learns about
  // path-mapping from tsconfig — it needs its own `resolve.alias`, which
  // was simply missing. Without this, `import ... from '$lib/...'` type-checks
  // but 404s at runtime. Added here since this file is otherwise off-limits
  // to every other agent this round; relative imports (`../../contracts`)
  // still work identically and remain valid after this change.
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
    },
  },
  plugins: [
    svelte(),
    crossOriginIsolation(),
    VitePWA({
      // Custom `fetch` handler needed for the share-target POST intercept
      // (src/lib/shell/sw.ts) — `generateSW`'s declarative config can't
      // express "read a multipart body, cache a file, redirect".
      strategies: 'injectManifest',
      srcDir: 'src/lib/shell',
      filename: 'sw.ts',
      injectManifest: {
        // Shell only: JS/CSS/HTML/icons/manifest. Codec wasm is
        // deliberately excluded (see sw.ts) and runtime-cached instead —
        // it's large and only some codecs get used per session.
        //
        // `avif` is here for one file, `public/demo/demo-hdr.avif`: the sample
        // cards have to keep working with the network off like the rest of the
        // shell, and without this extension the HDR card would be the only one
        // that 404s offline.
        globPatterns: ['**/*.{js,css,html,ico,png,jpg,jpeg,svg,avif,webmanifest}'],
        // Codec-sized JS stays out of the shell precache — sw.ts runtime-caches
        // it in the wasm tier on first HEIC decode instead.
        globIgnores: [
          '**/heic-decode-*.js',
          // Tauri-only chunks: reachable solely behind the isTauri() dynamic
          // import, dead weight for every web visitor's precache.
          '**/tauri-*.js',
          '**/core-*.js',
          '**/event-*.js',
          '**/dist-js-*.js',
        ],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      // We register manually via `virtual:pwa-register/svelte` in
      // `sw-registration.svelte.ts` (mounted through `UpdateToast.svelte`,
      // which drives the update-prompt UI) — don't also auto-inject a
      // registration script into index.html.
      injectRegister: false,
      registerType: 'prompt',
      manifest: {
        name: 'Pinch',
        short_name: 'Pinch',
        description:
          'Client-side image compression: AVIF, JPEG XL, WebP and more. Compare, batch, share presets. Nothing leaves your device.',
        lang: 'en',
        start_url: '/',
        id: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#FBF7EB',
        theme_color: '#141414',
        categories: ['photo', 'productivity', 'utilities'],
        icons: [
          // SVG first — crisp at every size, and the surfaces that understand
          // it stop here. The PNGs below are rasterised from these exact two
          // files by `scripts/generate-assets.mjs`, for the install surfaces
          // that still ignore SVG icons.
          { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          {
            src: '/icons/icon-maskable.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        // OS "Share to Pinch" — see sw.ts's fetch handler + share-target.ts.
        share_target: {
          action: '/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            files: [{ name: 'image', accept: ['image/*'] }],
          },
        },
        // OS "Open with Pinch" — consumed via window.launchQueue in share-target.ts.
        file_handlers: [{ action: '/', accept: IMAGE_FILE_HANDLER_ACCEPT }],
      },
    }),
  ],
  // `src-tauri/tauri.conf.json` hardcodes `devUrl: http://localhost:5173`, and
  // Tauri waits for exactly that URL before opening the window. Vite's default
  // is already 5173, but it silently walks to 5174 when the port is taken —
  // which would leave `npm run tauri:dev` hanging on an empty window. Failing
  // loudly on a busy port is the better outcome. No effect on `npm run dev`
  // beyond that: same port, same everything.
  server: {
    port: 5173,
    strictPort: true,
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: [
      '@jsquash/avif',
      '@jsquash/jpeg',
      '@jsquash/jxl',
      '@jsquash/oxipng',
      '@jsquash/png',
      '@jsquash/qoi',
      '@jsquash/webp',
      '@jsquash/resize',
    ],
  },
  build: {
    target: 'es2022',
  },
  test: {
    // Default include, minus anything the agent harness drops into .claude/
    // (a stray worktree there once doubled the whole suite) and the Tauri
    // crate's target directory.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', '**/src-tauri/**'],
  },
});
