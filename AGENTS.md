# AGENTS.md

Instructions for AI coding agents working in this repository. Humans should read
[CONTRIBUTING.md](./CONTRIBUTING.md) and [docs/architecture.md](./docs/architecture.md)
instead — this file is the short, load-bearing subset plus the traps that are not
obvious from reading the code.

## What this is

Pinch: client-side image compression. Codecs are WebAssembly ([jSquash](https://github.com/jamsinclair/jSquash))
running in the browser, nothing is ever uploaded. Svelte 5 + Vite, shipped as a
PWA at <https://pinch.rama.app> and as a Tauri 2 macOS app.

The GitHub repo is named `squish`; the product, the npm package and the Cargo
crate are all `pinch`. Both names are correct in their own context — don't
"fix" one to match the other. (The service worker cache names in
`src/lib/shell/sw.ts` still say `squish-*`; that is a known leftover.)

## Commands

```sh
npm run dev        # vite, http://localhost:5173
npm run check      # svelte-check, strict — must be clean
npm test           # vitest run, 440+ tests — must be clean
npm run build      # production build + service worker
npm run preview    # serve the build with the right headers
npm run tauri:dev  # native window against the dev server
npm run tauri:build

node scripts/generate-assets.mjs [icons|og|demo|hdr|shots|macos]   # binary assets
npm run release <major|minor|patch|x.y.z> [--dry-run]          # cut a version
```

`npm run check` and `npm test` are the gate. Run both before claiming anything
works.

## There is no formatter or linter

**Do not run Prettier, ESLint, or any other formatter.** There is no config for
either one, they are not in `devDependencies`, and no npm script invokes them.

Running `npx prettier --write` reformats roughly 97 unrelated files (~5,000 line
changes), destroys the diff, and cannot even parse `.svelte` files because
`prettier-plugin-svelte` is not installed. If you have a "format the code"
instruction from anywhere else, it does not apply here. Match the surrounding
style by hand: 2-space indent, single quotes, trailing commas, ~100 columns.

## Hard rules

- **The `contracts/` boundary.** `src/lib/contracts/` is the dependency-free
  source of truth — encoder ids, option shapes, MIME tables, job state. Feature
  directories (`codecs/ state/ compare/ options/ matrix/ batch/ presets/ edit/
  settings/ shell/ metrics/ home/ ui/`) must not reach into each other's
  internals; go through `contracts/` or the feature's `index.ts`.
- **Svelte 5 runes only.** `$state` / `$derived` / `$effect`, in `*.svelte.ts`
  files. `svelte/store` is not used and must not be introduced.
- **Strict TypeScript.** `noUncheckedIndexedAccess` is on. No `any`, no
  non-null assertions (`!`), no `@ts-ignore`.
- **Tests are logic-only vitest**, `*.test.ts` beside the source it covers.
  There is no component/DOM harness and no browser automation — don't add one
  without being asked.
- **COOP/COEP.** Dev, preview and production all send
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. Without them there is no
  `SharedArrayBuffer` and therefore no threaded AVIF / JPEG XL / OxiPNG. Don't
  remove them to make an embed work.

## The version number

`package.json` is the single source of truth. **Never type a version into a
component, a config or a doc.**

- UI reads `APP_VERSION` from `$lib/contracts` (injected by `vite.config.ts`)
- `src-tauri/tauri.conf.json` sets `version` to the *path* `../package.json`
- `src-tauri/Cargo.toml` and the lockfiles are rewritten by `scripts/release.mjs`

`src/lib/contracts/version.test.ts` fails the suite if any surface drifts, or if
someone replaces the Tauri path with a literal. To bump, use `npm run release`;
see the Releases section of CONTRIBUTING.md.

## Generated assets — regenerate, never hand-edit

`scripts/generate-assets.mjs` renders these through headless Chrome:

- `public/demo/demo-gradient.jpg`, `demo-poster.png`, `demo-hdr.avif`
- `public/icons/*.png`, `public/favicon.ico`, `src-tauri/icons/*`
- `public/og.png`
- `docs/media/home.png`, `docs/media/editor.png`

Two properties matter. **Output is committed**, so a change here is a binary
diff that wants justifying. And **the run is deterministic** — the grain is
seeded, the fonts are inlined — so running a target twice must produce
byte-identical files. If a second run produces a diff, that is a bug, not noise.

`public/demo/demo-vector.svg` is hand-authored source, not generated, and
deliberately contains no `<text>`: an SVG rendered through `<img>` cannot reach
the page's `@font-face`, so type inside it would fall back off-brand.

## Design system

Colours, spacing, radii, type and easing are CSS custom properties in
`src/app.css` `:root`. Use the tokens; never a raw hex. `src/lib/ui/` holds the
shared primitives (`PillButton`, `Chip`, `BrandDot`, `Ticker`, `Popover`, the
Editorial* form controls) — reach for one before writing new chrome, and check
`src/lib/ui/foundations.test.ts`, which asserts that accents resolve to tokens.

## Commits and PRs

Conventional Commits — `type(scope): subject`, lowercase, imperative, no
trailing period. Write a real body explaining why, what you measured, and what
you rejected; `git log` here is a design record. Mark breaking changes with
`feat!:` or a `BREAKING CHANGE:` footer.

Add a line to `## [Unreleased]` in `CHANGELOG.md` for anything a user would
notice. Keep PRs to one change. State how you verified it — there is no
screenshot bot.
