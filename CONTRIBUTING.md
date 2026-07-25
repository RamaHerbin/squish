# Contributing to Pinch

Pinch is a client-side image compression PWA — Svelte 5 (runes) + TypeScript
strict, built on Vite. Everything runs in the browser: there is no backend to
stand up, no API keys, no accounts. `npm install` and a browser are the whole
setup.

## Setup

```sh
npm install
npm run dev        # dev server, http://localhost:5173
```

The dev server (and `npm run preview`) sends
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` on every response. Those headers
enable `SharedArrayBuffer`, which the threaded wasm codecs (AVIF, JPEG XL,
OxiPNG) need. If you serve the app through anything else — a different dev
proxy, a static file server for a manual check — those two headers have to be
present or the threaded codecs silently fall back to single-threaded (or
fail).

Before opening a PR, both of these must be clean:

```sh
npm run check       # svelte-check, strict — types across .ts and .svelte
npm test             # vitest run
```

Other scripts:

```sh
npm run build        # production build + service worker (vite-plugin-pwa)
npm run preview      # serve the production build locally
```

## Project map

`src/lib/contracts/` is the source of truth. It holds the shared types —
encoder options, job/worker messages, preset shapes, batch types — and only
tiny, dependency-free pure helpers. Nothing in `contracts/` imports a runtime
dependency, so the same types can be pulled into the main thread, a worker, or
a test without dragging wasm along. Everything else imports *from*
`contracts/`; `contracts/` imports from nothing feature-specific. If you're
not sure where a type belongs, it probably belongs here.

Feature code lives in its own directory under `src/lib/`:

- `codecs/` — the worker bridge, the encoder/decoder registry, the codec
  worker itself, HDR handling
- `state/` — app-level and per-session reactive state (`.svelte.ts` files),
  the processing engine, settings persistence, the result cache
- `compare/` — the reveal-compare canvas and shared pan/zoom
- `options/` — the encoder toolbar, the advanced-settings drawer, per-codec
  option field descriptors
- `matrix/` — the codec comparison matrix (encoder × quality grid)
- `batch/` — the batch queue, worker pool, ZIP export, thumbnails
- `presets/` — the preset library (IndexedDB) and the shareable URL/JSON
  encoding
- `edit/` — rotate/crop before compressing
- `settings/` — user-facing app settings
- `shell/` — app shell, PWA/service-worker registration, tabs
- `metrics/` — SSIM computation (runs in a worker)
- `home/` — the intro/drop-zone view

A feature directory should not reach into another feature directory's
internals — go through `contracts/` (types) or a feature's own `index.ts`
(public surface) instead.

State is Svelte 5 runes only — `$state`, `$derived`, `$effect` — including in
plain `.ts` files (named `*.svelte.ts` when they use runes, by Svelte
convention). `svelte/store` is not used anywhere in the codebase and new code
shouldn't introduce it. TypeScript is strict (`strict: true`,
`noUncheckedIndexedAccess: true` in `tsconfig.json`) — no `any` as an escape
hatch, no non-null assertions to silence the indexed-access checks.

## Adding an encoder

Encoders are wired in four places, in order:

1. **`src/lib/contracts/codecs.ts`** — add the id to the `EncoderId` union and
   to the `ENCODER_IDS` array (this controls the `<select>` order), and add
   the encoder's option shape plus its entry in `DEFAULT_ENCODER_OPTIONS`. If
   it's wasm-backed, add it to `WorkerEncoderId` / `WORKER_ENCODER_IDS` too.
2. **`src/lib/codecs/registry.ts`** — add the metadata entry to
   `ENCODER_REGISTRY`: `label`, `mimeType`, `extension`, `defaultOptions`,
   `lossy`, `supportsAlpha`, `usesWorker`. This is plain data — the UI reads
   it to populate the encoder `<select>`, name output files, and decide
   whether to show an alpha warning. It must not import any codec
   implementation.
3. **`src/lib/codecs/codec.worker.ts`** — if the encoder is wasm-backed, add a
   `case` to the `encodeImage` switch, following the existing pattern: a
   memoised `loadOnce('enc:<id>', () => import('@jsquash/<pkg>/encode'))`
   loader, called lazily so selecting one codec never downloads another's
   wasm.
4. **`src/lib/options/advanced.ts`** — add a `case` to the columns switch (see
   `mozjpegColumns`, `avifColumns`, etc. for the pattern) that maps the
   encoder's option fields onto the advanced drawer's field descriptors
   (`select` / `slider` / `checkbox`). This is what makes the encoder's knobs
   show up in the advanced-settings drawer — metadata alone only gets it into
   the `<select>`.

Browser-native encoders (`browser-png`, `browser-jpeg`, `browser-webp`) skip
step 3 and resolve through `src/lib/codecs/browser-encoders.ts` (canvas
`toBlob`/`convertToBlob`) instead.

## Tests

Tests are `vitest`, logic-only — no component/DOM rendering harness, no
browser automation. A `*.test.ts` file sits next to the source it covers
(e.g. `src/lib/codecs/codecs.test.ts` next to `src/lib/codecs/`,
`src/lib/contracts/contracts.test.ts` next to `src/lib/contracts/`). The suite
is 400+ tests and growing; run `npm test` before every PR.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):
`type(scope): subject`, subject in lowercase, imperative, no trailing period.

Types in use: `feat`, `fix`, `chore`, `style`, `revert`, `docs`, `refactor`,
`perf`, `test`, `ci`. Scopes are the feature they touch — `(codecs)`, `(batch)`,
`(pwa)`, `(ui)`, `(demo)`, `(ci)` — and are optional on changes that genuinely
cut across everything.

Two things worth knowing:

- **Bodies carry the reasoning.** The subject says what changed; the body says
  why, what you measured, and what you rejected. `git log` here reads as a
  design record, and that is deliberate — wrap at 72 columns and write prose.
- **Breaking changes are marked**, either `feat!:` or a `BREAKING CHANGE:`
  footer. That is what turns a release into a major bump, so it is the one
  convention that changes a version number.

Nothing enforces this — there is no commitlint and no hook. It holds because
people follow it.

## Releases

Pinch ships on two clocks, and only one of them is versioned.

**The web app deploys continuously.** Vercel's Git integration builds every push
to `main`; there is no version gate, no tag, no changelog entry. `ci.yml`
deliberately has no deploy step so the two never fight (see `docs/deploy.md`).

**A `v*` tag is a milestone.** It builds the macOS DMG through
`.github/workflows/macos.yml` and opens a draft GitHub Release whose body is the
CHANGELOG section for that version. It does not affect the web app at all.

Versions follow [SemVer](https://semver.org/spec/v2.0.0.html) and the changelog
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

### The version lives in one place

`package.json` is the only file a human edits. Everything else derives from it:

| Surface | How it gets the version |
| --- | --- |
| The UI (footer ticker, Settings → About) | `APP_VERSION` from `$lib/contracts`, frozen in by the `define` block in `vite.config.ts` |
| The macOS bundle, the DMG filename, **App → About Pinch** | `src-tauri/tauri.conf.json`, whose `version` is the *path* `../package.json` |
| `src-tauri/Cargo.toml`, both lockfiles | rewritten by `scripts/release.mjs` |

So never type a version number into a component, a config or a doc.
`src/lib/contracts/version.test.ts` runs in CI and fails the suite if any of
those surfaces drifts — including if someone replaces the Tauri indirection with
a literal.

### Cutting one

1. **Keep `## [Unreleased]` current as you go.** Add to it in the PR that
   changes behaviour, not in a scramble at release time. `scripts/release.mjs`
   refuses to run if that section is empty, so a release without notes is
   impossible by construction.
2. From a clean, up-to-date `main`:

   ```sh
   npm run release minor             # major | minor | patch | an explicit x.y.z
   npm run release minor -- --dry-run   # see what it would do first
   ```

   Note the `--` before `--dry-run`: without it npm recognises the flag as one of
   its own and swallows it. The script also reads npm's `npm_config_dry_run`, so
   the shorter spelling is safe too, but `--` is the form to teach.

   It checks the preconditions, runs `check` and `test`, bumps `package.json`
   (and the lockfile) plus the Cargo crate, promotes `## [Unreleased]` to a
   dated heading with its link reference, then commits `chore(release): vX.Y.Z`
   and creates an annotated tag carrying the notes. If anything fails part-way,
   every file it had rewritten is restored.
3. It stops there on purpose. Read the diff, then push `main` and the one tag —
   an explicit refspec, because `--follow-tags` would also publish any other
   stray local `v*` tag and start a second release build:

   ```sh
   git push origin main vX.Y.Z
   ```
4. The macOS workflow verifies the tag matches `package.json`, re-runs
   `check`/`test`, builds the universal DMG and opens a **draft** release.
   Review the download and the notes, then publish it.

macOS builds are unsigned and un-notarised, and the Tauri updater is not
enabled, so a new version means downloading a new DMG. `macos.yml` documents the
exact secrets that would change that.

## Opening a PR

- Keep PRs small and focused on one change. A PR that touches an encoder's
  metadata, its worker case, and its advanced-drawer fields together is fine —
  that's one feature. A PR that also refactors an unrelated module is not.
- `npm run check` and `npm test` must both be green.
- Describe what changed and why in the PR description; link the issue it
  closes, if any.
- Add a line to `## [Unreleased]` in `CHANGELOG.md` if the change is one a user
  would notice.
- If you're adding or changing behavior a reader can see, say how you
  verified it (which codec/image/browser you tried it against) — there's no
  CI screenshot bot here to do that for you.
