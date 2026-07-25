# Security Policy

## Scope

Pinch is a client-side-only app: a static site plus WebAssembly codecs that
run entirely in your browser. There is no server, no API, no database, and no
account — images and settings never leave your device (see the
[README](./README.md) and [FAQ](./docs/FAQ.md)). That shrinks the attack surface a lot,
but it doesn't remove it:

- The app parses untrusted, attacker-controllable input by design — any image
  file a user opens, and any preset a user imports from a link or a `.json`
  file someone else made.
- Several codecs run as WebAssembly compiled from C/C++/Rust. A memory-safety
  bug in a wasm codec is a real, in-scope class of issue, even though it's
  upstream (in [jSquash](https://github.com/jamsinclair/jSquash) or
  [libheif](https://github.com/strukturag/libheif) via
  [heic-decode](https://github.com/catdad-experiments/heic-decode)) rather
  than in this repository's own code.
- The service worker and PWA install/update path is part of the trusted
  computing base of the app.

## What counts as a vulnerability here

Reports in scope include, non-exhaustively:

- **XSS or code execution** triggered by a crafted image file, filename, or a
  preset (either the URL-fragment token or an imported `.json` file) — e.g. if
  decoded/parsed data ends up somewhere it can execute as script or HTML.
- **Wasm memory-safety issues** reachable from user-supplied image bytes or
  encoder options — crashes are annoying, but an exploitable
  out-of-bounds read/write in a codec is a real report.
- **Preset token abuse** — the preset URL token is untrusted input decoded
  client-side (decompressed, then parsed as JSON); a token engineered to
  cause a decompression bomb, resource exhaustion, or to smuggle unexpected
  values past validation into app state is in scope.
- **Service worker / cache poisoning** issues that could let a malicious
  response persist or serve stale/attacker-controlled content offline.

Out of scope: there is no backend to attack (there isn't one), and reports
that require the user to already have run arbitrary code on their own
machine (e.g. "if you have filesystem write access, you can modify the
installed PWA's files") aren't actionable here.

## Reporting a vulnerability

Please use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
for this repository (the "Report a vulnerability" button under the repo's
**Security** tab) rather than opening a public issue. Include:

- The version/commit you tested against (or the deployed URL + date)
- Browser and OS
- Steps to reproduce, and if relevant, a minimal image/preset file that
  triggers it
- What you expected vs. what happened

Please do not open a public issue for a suspected vulnerability until it's
been triaged.

## Response expectations

This is a solo-maintained, spare-time project — there's no security team and
no SLA. I'll do my best to acknowledge a report within a reasonable time and
fix confirmed issues as quickly as I reasonably can, but "best-effort" is the
honest description. If an issue turns out to be in an upstream dependency
(jSquash, libheif/heic-decode, a browser itself), I'll help route it there
too.
