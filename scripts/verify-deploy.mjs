#!/usr/bin/env node
/**
 * Pinch — deployed-asset verifier.
 *
 *   node scripts/verify-deploy.mjs https://pinch.rama.app
 *   node scripts/verify-deploy.mjs https://pinch-abc123.vercel.app --dist dist
 *
 * Enumerates every worker script and every `.wasm` file in the local build,
 * fetches each one from a deployed origin, and asserts the three things that
 * have to be true *on the wire* for a threaded codec to start: HTTP 200, a
 * JavaScript or `application/wasm` content type (never `text/html`), and
 * `Cross-Origin-Embedder-Policy: require-corp`.
 *
 * ## Why this exists
 *
 * Every threaded wasm codec died in production while every single-threaded one
 * kept working: JPEG XL and AVIF raised `WorkerLoadError`, OxiPNG raised
 * `WorkerTimeoutError`, WebP and MozJPEG were fine.
 *
 * The chain: jSquash sees `SharedArrayBuffer` and picks its multi-threaded
 * build, whose emscripten glue spawns a dedicated worker from
 * `/assets/<codec>_mt.worker-<hash>.js`. In a cross-origin-isolated page a
 * browser refuses to create a worker whose *script response* does not carry a
 * compatible COEP header, and the refusal arrives as a bare `Event` — no
 * message, no filename. Emscripten rethrows that object, nothing catches it,
 * and `src/lib/codecs/bridge.ts` renders the only string a user ever sees:
 * "The codec worker failed to load (Uncaught [object Event])."
 *
 * The server was innocent. `curl` returned `require-corp` on those exact URLs
 * the whole time. What was broken were the *cached copies*: `/assets/(.*)` is
 * served `max-age=31536000, immutable`, those worker scripts are content-hashed
 * and their bytes had not changed for months, so their URLs never changed — and
 * browsers kept, for a year, a copy fetched before COOP/COEP shipped, with no
 * COEP header on it.
 *
 * Nothing in the existing gate could see that. A reload does not help (the
 * service worker re-ingests the poisoned copy out of the HTTP cache on every
 * precache install), and the Playwright e2e suite drives a fresh browser
 * against `vite preview`, which has no year-old cache to be wrong about. Only
 * long-returning visitors were affected, and only a request to the real deploy
 * can observe it — hence this script, and hence per-asset rather than one
 * `curl -I /`.
 *
 * The last check is the other half of the same failure mode: a missing
 * `/assets/*` path that answers `200 text/html` (an SPA rewrite shadowing the
 * filesystem) is how a hashed script URL ends up holding an HTML document in
 * the precache, and it fails just as opaquely.
 */

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const argv = process.argv.slice(2);
const distFlag = argv.indexOf('--dist');
const DIST = path.resolve(ROOT, distFlag === -1 ? 'dist' : (argv[distFlag + 1] ?? 'dist'));
// `--dist` takes a value, so its argument is skipped rather than mistaken for
// the URL — otherwise `--dist build https://…` would verify "build".
const positional = argv.filter(
  (arg, index) => !arg.startsWith('-') && (distFlag === -1 || index !== distFlag + 1),
);

const USAGE = 'Usage: node scripts/verify-deploy.mjs <base-url> [--dist dist]';

/** A deploy that has not answered in 20s is a failure worth reporting, not a hang. */
const TIMEOUT_MS = 20_000;

/** Enough parallelism to keep the run short, low enough not to look like a flood. */
const POOL = 6;

const JS_TYPE = /^(?:text|application)\/(?:x-)?(?:java|ecma)script\b/i;
const WASM_TYPE = /^application\/wasm\b/i;
const HTML_TYPE = /^text\/html\b/i;

function fail(message, hint) {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Fetch one URL and keep only its status and headers.
 *
 * `GET`, not `HEAD`: this check exists because a *browser* saw different
 * headers than `curl` did, so it asks the way a browser asks. The body is
 * cancelled as soon as the headers land, which is what keeps twenty
 * multi-megabyte wasm binaries from actually being downloaded.
 *
 * One retry on a transport error, a 5xx or a 429. What this hunts is
 * deterministic — a header is either configured or it is not — so a retry
 * cannot mask a real finding, and it stops an edge hiccup from crying wolf.
 */
async function probe(url, { redirect = 'follow' } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      const response = await fetch(url, { redirect, signal });
      await response.body?.cancel().catch(() => {});
      if ((response.status >= 500 || response.status === 429) && attempt === 0) {
        await sleep(1_000);
        continue;
      }
      return { status: response.status, headers: response.headers };
    } catch (error) {
      if (attempt === 0) {
        await sleep(1_000);
        continue;
      }
      return { error: error.message ?? String(error) };
    }
  }
}

/** Run `task` over `items` with a bounded number in flight; results in input order. */
async function mapPool(items, task) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(POOL, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The assets whose headers decide whether a codec runs at all: the worker
 * scripts (the emscripten pthread workers, the wasm-bindgen-rayon helper, and
 * this app's own `codec.worker` / `metrics.worker`) and every wasm binary they
 * instantiate. The rest of `/assets/` is loaded by the document itself, which
 * fails loudly and visibly rather than as a bare `Event`.
 */
function localAssets() {
  const dir = path.join(DIST, 'assets');
  const relative = path.relative(ROOT, dir);
  if (!fs.existsSync(dir)) {
    fail(
      `no build output at ${relative}.`,
      'Run `npm run build` first — this compares the deploy against the local build.',
    );
  }
  const names = fs.readdirSync(dir).sort();
  const workers = names.filter((name) => name.endsWith('.js') && /worker/i.test(name));
  const wasm = names.filter((name) => name.endsWith('.wasm'));

  // Neither list may be empty: if the naming ever changes under this script it
  // would quietly check nothing, and a verifier that always passes is worse
  // than no verifier at all.
  if (workers.length === 0 || wasm.length === 0) {
    fail(
      `${relative} holds ${workers.length} worker script(s) and ${wasm.length} wasm file(s).`,
      'Expected both. Either the build is incomplete, or Vite stopped naming these ' +
        'files the way this script matches.',
    );
  }
  return { workers, wasm };
}

/**
 * Why a missing COEP header matters, once for a script and once for a binary.
 *
 * The script wording quotes the browser-visible string verbatim: that opaque
 * sentence is the whole reason this file exists, and it is what someone reading
 * a red CI log will have in front of them from a bug report.
 *
 * A `.wasm` response is a plainer argument — a same-origin binary is fetched
 * regardless of its own COEP. It is checked because every response from this
 * deploy is supposed to carry the isolation headers, so one that does not was
 * produced by a different configuration, which is exactly the shape of the
 * outage.
 */
const COEP_HINT = {
  script:
    'A cross-origin-isolated page refuses to start a worker from this response ' +
    'and reports it as a bare Event, so the user sees only "The codec worker ' +
    'failed to load (Uncaught [object Event])".',
  wasm:
    'Every response from this origin is supposed to carry the isolation ' +
    'headers, so one that does not came from a different configuration.',
};

/**
 * Assert one asset: 200, the right content type, and COEP.
 *
 * `require-corp` exactly — but as a drift check, not as the browser's rule. The
 * value the browser actually refuses is `unsafe-none`, which is also what an
 * absent header means; `credentialless` satisfies a `require-corp` page just as
 * well. This asserts the exact value `vercel.json` sets, so that any change to
 * the isolation configuration has to be a deliberate edit here too. If this
 * deployment ever moves to `credentialless` on purpose, widen this check —
 * do not read a failure as the outage returning.
 */
function checkAsset(name, result) {
  const problems = [];
  if (result.error) {
    problems.push({ note: `request failed: ${result.error}` });
    return { name, status: '—', type: '—', coep: '—', problems };
  }

  const type = (result.headers.get('content-type') ?? '').trim();
  const coep = (result.headers.get('cross-origin-embedder-policy') ?? '').trim();
  const isWasm = name.endsWith('.wasm');
  const row = {
    name,
    status: result.status,
    type: type.split(';')[0] || '—',
    coep: coep || '—',
    problems,
  };

  // A non-200 is reported on its own: whatever content type and headers came
  // back with an error page describe the error page, not the asset, and listing
  // all three reads as three separate faults instead of one.
  if (result.status !== 200) {
    problems.push({
      note: `HTTP ${result.status}, expected 200`,
      hint:
        result.status === 404
          ? 'The deploy is serving a different build than dist/ — check which commit is live.'
          : undefined,
    });
    return row;
  }

  if (HTML_TYPE.test(type)) {
    problems.push({
      note: `content-type is ${type}`,
      hint:
        'Either the deploy is a different build than dist/, or the SPA fallback ' +
        'is shadowing /assets/. Both end with a hashed script URL holding an ' +
        'HTML document in the precache for a year.',
    });
  } else if (!(isWasm ? WASM_TYPE : JS_TYPE).test(type)) {
    problems.push({
      note:
        `content-type is ${type || '(absent)'}, expected ` +
        (isWasm ? 'application/wasm' : 'JavaScript'),
    });
  }
  if (coep.toLowerCase() !== 'require-corp') {
    problems.push({
      note: `cross-origin-embedder-policy is ${coep || '(absent)'}, expected require-corp`,
      hint: isWasm ? COEP_HINT.wasm : COEP_HINT.script,
    });
  }

  return row;
}

/**
 * The document, read from the response the preflight already fetched.
 *
 * Not an asset, but the thing that decides whether any of the assets matter:
 * without both isolation headers here there is no `SharedArrayBuffer`, jSquash
 * silently selects its single-threaded builds, and nothing anywhere reports an
 * error. Checked first so that a deploy which lost isolation altogether says so
 * in one line instead of through twenty confusing asset rows.
 */
function checkDocument(result) {
  const type = (result.headers.get('content-type') ?? '').trim();
  const coop = (result.headers.get('cross-origin-opener-policy') ?? '').trim();
  const coep = (result.headers.get('cross-origin-embedder-policy') ?? '').trim();
  const problems = [];
  const hint =
    'Without both headers the page is not cross-origin isolated, so there is no ' +
    'SharedArrayBuffer and every threaded codec quietly falls back to its slow build.';

  if (result.status !== 200) problems.push({ note: `HTTP ${result.status}, expected 200` });
  if (coop.toLowerCase() !== 'same-origin') {
    problems.push({
      note: `cross-origin-opener-policy is ${coop || '(absent)'}, expected same-origin`,
      hint,
    });
  }
  if (coep.toLowerCase() !== 'require-corp') {
    problems.push({
      note: `cross-origin-embedder-policy is ${coep || '(absent)'}, expected require-corp`,
      hint,
    });
  }
  return {
    name: '/',
    status: result.status,
    type: type.split(';')[0] || '—',
    coep: coep || '—',
    problems,
  };
}

/**
 * A path no build will ever emit. Vercel serves a file that exists before it
 * consults `rewrites`, so real assets are unaffected — but if that order
 * inverts, or a host is configured with a forcing redirect, every missing
 * `/assets/*` starts answering with the SPA shell at 200, and from outside the
 * only way to see it is to ask for something that cannot be there.
 */
const MISSING_PROBE = '/assets/__missing-probe__.js';

function checkMissingProbe(result) {
  if (result.error) {
    return {
      name: MISSING_PROBE,
      status: '—',
      type: '—',
      coep: '—',
      problems: [{ note: `request failed: ${result.error}` }],
    };
  }
  const type = (result.headers.get('content-type') ?? '').trim();
  const problems = [];
  if (result.status === 200) {
    problems.push({
      note: `HTTP 200 ${type || '(no content-type)'} for a file that does not exist`,
      hint: HTML_TYPE.test(type)
        ? 'The SPA fallback is shadowing /assets/. Keep the catch-all rewrite in ' +
          'vercel.json off the build output.'
        : 'A missing asset must not resolve. Check the host\'s rewrite rules.',
    });
  }
  return {
    name: MISSING_PROBE,
    status: result.status,
    type: type.split(';')[0] || '—',
    coep: '—',
    problems,
  };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

if (positional.length === 0) fail('no base URL given.', USAGE);

let origin;
try {
  const raw = positional[0];
  origin = new URL(raw.includes('://') ? raw : `https://${raw}`).origin;
} catch {
  fail(`"${positional[0]}" is not a URL.`, USAGE);
}

const { workers, wasm } = localAssets();

console.log('\nverify deploy');
console.log(`  base                   ${origin}`);
console.log(`  build                  ${path.relative(ROOT, DIST)}/assets`);
console.log(`  assets                 ${workers.length} worker script(s), ${wasm.length} wasm`);

/**
 * A protected deployment (Vercel's preview authentication) answers every path
 * with an SSO page, so nothing below can be measured and every asset would fail
 * for a reason that is not a bug. That is "not applicable", not "broken", so it
 * exits clean — a red X nobody can fix is how a check ends up deleted.
 *
 * Detected on a manual-redirect preflight, because the interesting part is the
 * hop itself. Vercel does not answer 401: it sends `302 Location:
 * https://vercel.com/sso-api?...`, and following that lands on a perfectly
 * healthy `200 text/html` login page. Under `redirect: 'follow'` the status is
 * 200, so a status test can never see it — the run this replaced reported all
 * 27 assets as `text/html` with no COEP, which is true of the login page and
 * says nothing about the build. Any redirect that leaves this origin means the
 * origin is not the thing answering.
 */
const gate = await probe(`${origin}/`, { redirect: 'manual' });
if (gate.error) {
  fail(
    `could not reach ${origin}/: ${gate.error}`,
    'Is the URL right, and has the deployment finished?',
  );
}
const gateLocation = gate.headers?.get('location') ?? '';
const leavesOrigin =
  gate.status >= 300 &&
  gate.status < 400 &&
  gateLocation !== '' &&
  new URL(gateLocation, origin).origin !== origin;

if (gate.status === 401 || gate.status === 403 || leavesOrigin) {
  const how = leavesOrigin
    ? `redirects to ${new URL(gateLocation, origin).origin}`
    : `HTTP ${gate.status}`;
  console.log(`\n  / ${how} — the deployment is access-protected, nothing to verify.\n`);
  console.log(
    '  Vercel Deployment Protection covers preview URLs by default. Production is\n' +
      '  unprotected and is verified normally; to check previews too, set a protection\n' +
      '  bypass secret and send it as x-vercel-protection-bypass.\n',
  );
  process.exit(0);
}

const index = await probe(`${origin}/`);
if (index.error) {
  fail(
    `could not reach ${origin}/: ${index.error}`,
    'Is the URL right, and has the deployment finished?',
  );
}

const assets = [...workers, ...wasm];
const rows = [
  checkDocument(index),
  ...(await mapPool(assets, async (name) =>
    checkAsset(name, await probe(`${origin}/assets/${name}`)),
  )),
  checkMissingProbe(await probe(`${origin}${MISSING_PROBE}`)),
];

console.log('');
for (const { name, status, type, coep, problems } of rows) {
  const mark = problems.length === 0 ? '✓' : '✗';
  const head = `  ${mark} ${name.padEnd(40)} ${String(status).padEnd(4)}`;
  console.log(`${head} ${type.padEnd(24)} ${coep}`);
}

const failed = rows.filter((row) => row.problems.length > 0);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${rows.length} checks failed`);
  for (const row of failed) {
    console.error(`\n  ${row.name}`);
    for (const { note, hint } of row.problems) {
      console.error(`    ✗ ${note}`);
      if (hint) console.error(`      ${hint}`);
    }
  }
  fail(
    `${origin} is not serving its own build correctly.`,
    'docs/deploy.md explains what each header is for.',
  );
}

console.log(`\n${origin} is cross-origin isolated, ${assets.length} asset(s) served at 200`);
console.log(`with the right type and require-corp, and ${MISSING_PROBE} does not resolve.\n`);
