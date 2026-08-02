/// <reference types="vitest/config" />
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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

/**
 * pdf.js's runtime data files.
 *
 * `pdfjs-dist` ships three directories that its worker fetches BY URL instead
 * of importing — `cmaps/` (the predefined CJK character maps), `wasm/` (the
 * JBIG2 and JPEG 2000 image decoders, plus qcms for ICC colour management) and
 * `iccs/` (the fallback CMYK profile). Nothing in the module graph references
 * them, so the bundler never sees them and nothing puts them in `dist/`.
 *
 * They land under `/assets/` on purpose, not a top-level `/pdfjs/`.
 * `vercel.json` rewrites `/((?!assets/).*)` to `index.html`, so a miss anywhere
 * else answers 200 `text/html` — exactly the mislabelled-body poisoning that
 * `src/lib/shell/sw.ts` documents at length and now guards against. Under
 * `/assets/` a miss is a 404, and the `immutable, max-age=1y` header already
 * declared for that prefix applies for free.
 *
 * The version segment is what makes `immutable` honest. These filenames are
 * fixed upstream (`pdf.worker.mjs` hardcodes `qcms_bg.wasm`), so they can't be
 * content-hashed like everything else under `/assets/`; without it a
 * `pdfjs-dist` upgrade would serve new bytes at a URL that both the browser and
 * the service worker had pinned for a year, to a freshly-hashed worker that no
 * longer matches them. The version is read out of the installed package, never
 * typed — same rule as the app's own.
 *
 * `src/lib/pdf/render.ts` builds the same URLs from pdf.js's own exported
 * `version`; `src/lib/shell/sw.ts` runtime-caches the `/assets/pdfjs/` prefix.
 */
const pdfjsRequire = createRequire(import.meta.url);
const PDFJS_ROOT = dirname(pdfjsRequire.resolve('pdfjs-dist/package.json'));
const { version: PDFJS_VERSION } = JSON.parse(
  readFileSync(join(PDFJS_ROOT, 'package.json'), 'utf8'),
) as { version: string };
const PDFJS_ASSET_DIR = `assets/pdfjs/${PDFJS_VERSION}`;

/** The three binaries `pdf.worker.mjs` actually fetches, by hardcoded name. */
const PDFJS_WASM_FILES = new Set(['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm']);

/**
 * What ships out of each directory — and what deliberately doesn't.
 *
 * `wasm/` is filtered down to those three. `quickjs-eval.*` (475 KB) is the
 * AcroForm scripting sandbox, dead unless `enableScripting` is set. The
 * `*_nowasm_fallback.js` pair (596 KB) is left out on a narrower argument than
 * "WebAssembly is unavailable, and in an app whose every codec is wasm it never
 * is" — that reading is wrong, and the code says so: `WasmImage
 * #instantiateWasm` catches *any* failure, a failed fetch included, and imports
 * the fallback from there. So the real exposure is a wasm file that cannot be
 * reached: an installed PWA taken offline before it ever fetched `openjpeg.wasm`
 * (it is runtime-cached, not precached) then opened on a JPEG 2000 scan, whose
 * images pdf.js would drop under `ignoreErrors`. That is one image class, in one
 * offline order, against 596 KB on a prefix pinned `immutable` for a year — so
 * the file stays out, and this paragraph is the note for whoever weighs it
 * again. The `LICENSE*` files travel with the binaries: the BSD terms ask for
 * the notice to accompany the binary, and 25 KB makes that literally true of the
 * deployed app rather than only of the repository.
 *
 * `standard_fonts/` (800 KB) is left out entirely. It substitutes the 14
 * standard PDF fonts when a document doesn't embed them, but `useSystemFonts`
 * already covers that in a browser — and both sides of the reveal render
 * through the same pdf.js, so any substitution is identical left and right and
 * cancels out of a comparison about image quality. CMaps are not the same
 * case: without one, text in a predefined CJK encoding doesn't substitute, it
 * disappears, and a blank page reads as a broken preview.
 */
const PDFJS_ASSET_SOURCES: ReadonlyArray<readonly [dir: string, keep: (file: string) => boolean]> =
  [
    ['cmaps', (file) => file.endsWith('.bcmap') || file.startsWith('LICENSE')],
    ['iccs', (file) => file.endsWith('.icc') || file.startsWith('LICENSE')],
    ['wasm', (file) => PDFJS_WASM_FILES.has(file) || file.startsWith('LICENSE')],
  ];

/**
 * `.bcmap` has no registered media type, so static hosts answer it with
 * `application/octet-stream` (the unknown-extension default). Dev says the same
 * thing rather than something friendlier, so that the admission guard in
 * `sw.ts` sees one content type per extension across dev, preview and prod.
 */
const PDFJS_CONTENT_TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.icc': 'application/vnd.iccprofile',
  '.bcmap': 'application/octet-stream',
};

/** `[public path below `PDFJS_ASSET_DIR`, absolute source path]`. */
function pdfjsAssetFiles(): Array<readonly [string, string]> {
  return PDFJS_ASSET_SOURCES.flatMap(([dir, keep]) =>
    readdirSync(join(PDFJS_ROOT, dir))
      .filter(keep)
      .map((file) => [`${dir}/${file}`, join(PDFJS_ROOT, dir, file)] as const),
  );
}

function pdfjsAssets(): Plugin {
  const files = pdfjsAssetFiles();
  return {
    name: 'pdfjs-assets',
    // Copied out of node_modules at build time rather than checked into
    // `public/`: that would be 2 MB of vendored binaries a human would then be
    // expected to re-vendor by hand on every upgrade, and `public/` is swept by
    // the precache globs besides.
    //
    // `writeBundle` and a plain copy, not `this.emitFile` — emitting them as
    // rollup assets works, but it also prints 180 lines of `.bcmap` into the
    // build report and buries the chunk sizes anyone actually reads. This hook
    // runs after the output directory has been emptied and before
    // vite-plugin-pwa builds the service worker in `closeBundle`, which is the
    // window the files have to exist in.
    writeBundle(options) {
      if (options.dir === undefined) return;
      for (const [url, source] of files) {
        const target = join(options.dir, PDFJS_ASSET_DIR, url);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      }
    },
    // `dist/` doesn't exist in dev, so serve the same URLs straight out of
    // node_modules — otherwise the PDF preview only works in a build. The path
    // comes from the table above and never from the request, so there is no
    // traversal to defend against.
    configureServer(server) {
      // Keyed on the public path, and the extension is read off that rather
      // than off the source path — an absolute path can pick up a dot from any
      // directory above node_modules, `cmaps/iccs/wasm` cannot.
      const byUrl = new Map(
        files.map(([url, source]) => {
          const dot = url.lastIndexOf('.');
          const type = dot === -1 ? undefined : PDFJS_CONTENT_TYPES[url.slice(dot)];
          const entry = { source, type: type ?? 'text/plain; charset=utf-8' };
          return [`/${PDFJS_ASSET_DIR}/${url}`, entry];
        }),
      );
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0];
        const file = path === undefined ? undefined : byUrl.get(path);
        if (file === undefined) {
          next();
          return;
        }
        res.setHeader('Content-Type', file.type);
        res.end(readFileSync(file.source));
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
  // Not an image — opening a PDF this way routes to the PDF view, not the editor.
  'application/pdf': ['.pdf'],
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
    pdfjsAssets(),
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
        // `avif` and `pdf` are here for one file each, `public/demo/demo-hdr.avif`
        // and `public/demo/demo-report.pdf`: the sample cards have to keep working
        // with the network off like the rest of the shell, and without these
        // extensions the HDR and PDF cards would be the only ones that 404 offline.
        globPatterns: ['**/*.{js,css,html,ico,png,jpg,jpeg,svg,avif,pdf,webmanifest}'],
        // Codec-sized JS stays out of the shell precache — sw.ts runtime-caches
        // it in the wasm tier on first HEIC decode instead.
        globIgnores: [
          // Hash-width pinned like `pdf-????????.js` below, and for the same
          // reason: `heic-to-*.js` would also swallow a future
          // `heic-to-anything-<hash>.js` app chunk out of the precache.
          '**/heic-to-????????.js',
          // pdf.js, same policy: a ~2 MB worker script plus a ~430 KB library
          // chunk, neither of which sits under the 5 MB cap for any better
          // reason than that it happens to. Both are dead weight for every
          // visitor who never opens a PDF, and `sw.ts` runtime-caches both.
          //
          // `pdf-????????.js` and not `pdf-*.js` deliberately: the loose form
          // would also swallow a future `pdf-job-<hash>.js`, and the two
          // failure directions are not symmetric. An app chunk quietly leaving
          // the precache breaks offline first use; a build whose hashes stop
          // being eight characters merely puts pdf.js back in the precache,
          // which costs bandwidth and nothing else.
          '**/pdf.worker*',
          '**/pdf-????????.js',
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
          'Client-side image and PDF compression: AVIF, JPEG XL, WebP and more. Compare, batch, share presets. Nothing leaves your device.',
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
            // PDFs are shareable too — `routePdfs()` in App.svelte already sends a
            // shared file to the PDF screen, and the service worker's intercept
            // stores whatever `File` arrives without looking at its type, so
            // `image/*` alone was the only thing turning the share sheet away.
            // The extension is listed beside the MIME because Android share
            // intents are not required to carry one.
            files: [{ name: 'image', accept: ['image/*', 'application/pdf', '.pdf'] }],
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
  // The jSquash wrappers import their `.wasm` directly, which esbuild's
  // dep-prebundler can't represent, so they have to stay out of it.
  //
  // `pdfjs-dist` deliberately is NOT in this list, having been checked rather
  // than assumed: esbuild prebundles it cleanly (a 759 KB dep, `version` and
  // `getDocument` intact), because it imports no wasm at all — every binary it
  // needs it fetches by URL from inside the worker. The worker script and the
  // data files never go through the prebundler either: one is a `?url` asset
  // and the others are served by `pdfjsAssets` above. Excluding it would only
  // cost a waterfall of ~200 unbundled ESM requests on the first PDF opened in
  // a cold dev server.
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
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', '**/src-tauri/**', '**/e2e/**'],
  },
});
