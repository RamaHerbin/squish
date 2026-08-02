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

Three things worth knowing:

- **Bodies carry the reasoning.** The subject says what changed; the body says
  why, what you measured, and what you rejected. `git log` here reads as a
  design record, and that is deliberate — wrap at 72 columns and write prose.
- **Breaking changes are marked**, either `feat!:` or a `BREAKING CHANGE:`
  footer.
- **The type is the release.** `feat`, `fix`, `perf` and `revert` are what
  release-please turns into a version bump and a changelog line; `docs`,
  `chore`, `refactor`, `test`, `build`, `ci` and `style` are invisible to it and
  release nothing. Calling a fix a `chore` does not make it tidier, it makes it
  unreleased.

No commitlint and no hook enforce the shape of the subject. What does have
teeth is the type, and only after the fact: get it wrong and the change ships
under the wrong number, or does not ship at all.

## Releases

Pinch ships on two clocks, and only one of them is versioned.

**The web app deploys continuously.** Vercel's Git integration builds every push
to `main`; there is no version gate, no tag, no changelog entry. `ci.yml`
deliberately has no deploy step so the two never fight (see `docs/deploy.md`).

**A `v*` tag is a milestone.** It builds the macOS DMG through
`.github/workflows/macos.yml` and attaches it to a draft GitHub Release whose
body is the CHANGELOG section for that version. It does not affect the web app
at all.

Versions follow [SemVer](https://semver.org/spec/v2.0.0.html), and
[release-please](https://github.com/googleapis/release-please) derives them from
the commit log: `feat` bumps the minor, `fix`, `perf` and `revert` the patch,
and every other type releases nothing at all.

Pinch is pre-1.0, so `bump-minor-pre-major` is on and a breaking change bumps
the minor rather than the major. Reaching `1.0.0` should be a decision, not the
side effect of one `feat!:`.

### The version lives in one place

`package.json` is the source of truth, and nobody types into it by hand either.
Everything else derives from it:

| Surface | How it gets the version |
| --- | --- |
| The UI (footer ticker, Settings → About) | `APP_VERSION` from `$lib/contracts`, frozen in by the `define` block in `vite.config.ts` |
| The macOS bundle, the DMG filename, **App → About Pinch** | `src-tauri/tauri.conf.json`, whose `version` is the *path* `../package.json` |
| `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `.release-please-manifest.json` | rewritten by release-please, per the `extra-files` list in `release-please-config.json` |

So never type a version number into a component, a config or a doc.
`src/lib/contracts/version.test.ts` runs in CI and fails the suite if any of
those surfaces drifts — including if someone replaces the Tauri indirection with
a literal. Those checks run on the release pull request too, so a file that
release-please has been told to forget goes red before the tag exists.

One entry in that config needs explaining, because JSON cannot carry a comment.
`Cargo.lock` pins every transitive dependency at its own version and only one of
those entries is ours, so its updater selects by name:

```
$.package[?(@.name.value=='pinch')].version
```

`.value` is not a typo. release-please parses TOML into a tree where every leaf
is `{start, end, value}` — byte offsets, so it can rewrite one value in place
without reformatting the file — and the filter runs against that tree, not
against the plain document. Written the obvious way the filter matches nothing,
release-please logs a warning rather than failing, and `Cargo.lock` would be
left behind at the old version. The Cargo.lock assertion in `version.test.ts`
exists for exactly that failure.

### Cutting one

1. **Nothing to do as you go.** Write good Conventional Commit subjects and
   bodies; that is the input. `CHANGELOG.md` has no `Unreleased` section any
   more, and editing it in a feature PR only creates a conflict with the release
   PR.
2. release-please keeps a pull request titled **chore(main): release x.y.z**
   open on `main`, rebuilding it on every push. It carries the bumped files and
   a CHANGELOG section drafted from the commit subjects.
3. **Rewrite that section before merging.** The generated bullets are raw
   material — a list of subjects with commit links. The changelog here is an
   editorial document, grouped by theme, written for someone deciding whether to
   care about this version. Push your edit onto the release branch; release-please
   preserves it unless new commits land on `main`, in which case re-apply.
4. Merge it. That commits the bump, creates the `vX.Y.Z` tag and opens a
   **draft** GitHub Release. Draft releases normally have no tag until they are
   published, so `force-tag-creation` is on — without it the tag would never
   exist and the macOS build would never start.
5. The macOS workflow verifies the tag matches `package.json`, re-runs
   `check`/`test`, builds the universal DMG, attaches it to that draft release
   and replaces the body with your edited CHANGELOG section. Review the download,
   then publish it.

macOS builds are unsigned and un-notarised, and the Tauri updater is not
enabled, so a new version means downloading a new DMG. `macos.yml` documents the
exact secrets that would change that.

### `RELEASE_PLEASE_TOKEN`

Refs pushed by `GITHUB_TOKEN` deliberately do not trigger workflows, which would
break the chain above in two places: the release PR would get no CI, and the tag
would never reach `macos.yml`, leaving a draft release with nothing to download.
So `release.yml` authenticates with a repository secret named
`RELEASE_PLEASE_TOKEN` — a fine-grained personal access token scoped to this
repository with **Contents: read and write** and **Pull requests: read and
write**.

It falls back to `GITHUB_TOKEN` when the secret is absent, and logs a warning
saying so. A release cut that way is recoverable: dispatch `macos.yml` by hand
once the tag exists.

`release-please-config.json` also carries `last-release-sha`, pointing at the
`v0.1.0` commit. `v0.1.0` was tagged before any of this existed and has no
GitHub Release, so without it release-please would look past the tag and read
the whole history as unreleased. It can be dropped once a release it did create
is the most recent one.

## Opening a PR

- Keep PRs small and focused on one change. A PR that touches an encoder's
  metadata, its worker case, and its advanced-drawer fields together is fine —
  that's one feature. A PR that also refactors an unrelated module is not.
- `npm run check` and `npm test` must both be green.
- Describe what changed and why in the PR description; link the issue it
  closes, if any.
- Leave `CHANGELOG.md` alone. release-please writes it from your commit
  subjects, so a change a user would notice needs a `feat:` or `fix:` subject
  that reads well on its own — not a changelog edit.
- If you're adding or changing behavior a reader can see, say how you
  verified it (which codec/image/browser you tried it against) — there's no
  CI screenshot bot here to do that for you.
