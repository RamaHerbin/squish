<script lang="ts">
  /**
   * Screen 05, section `/ 04` — the SSIM explainer plus a read-out of every
   * cut point behind `verdictFor` (see `contracts/pinch.ts`). No comp exists
   * for this section; it borrows the matrix's outline verdict chip and the
   * Defaults section's ruled rows.
   */
  import { Chip } from '../ui';
  import type { AccentName } from '../ui';
  import { THRESHOLDS, verdictFor, type VerdictTone } from '../contracts';
  import SectionHeader from './SectionHeader.svelte';

  // No explicit `Record<string, string>` annotation: this needs to keep its
  // literal key names (not widen to `string`) so `keyof typeof BAND_NOTES`
  // below stays a subset of `keyof typeof THRESHOLDS` and `THRESHOLDS[key]`
  // type-checks without a cast.
  const BAND_NOTES = {
    lossless: 'Pixel-identical to the source.',
    overkill: 'Spending bytes nobody can see.',
    excellent: 'Comfortably invisible at 100%.',
    good: 'Invisible in normal viewing — the safe default target.',
    soft: 'Softness shows on flat gradients and skies.',
    visible: 'Below this, damage is visible without looking for it.',
  } satisfies Partial<Record<keyof typeof THRESHOLDS, string>>;

  const bands = (Object.keys(BAND_NOTES) as (keyof typeof BAND_NOTES)[]).map((key) => {
    const ssim = THRESHOLDS[key];
    return { key, ssim, note: BAND_NOTES[key], verdict: verdictFor(ssim) };
  });

  function chipTone(tone: VerdictTone): AccentName {
    if (tone === 'good') return 'green';
    if (tone === 'warn') return 'red';
    return 'yellow';
  }
</script>

<div class="section">
  <SectionHeader accent="green" index={4} title="Metrics" />
  <p class="intro">
    SSIM compares the output against the original, pixel for pixel, on a 0–1 scale — 1 is
    identical. Pinch reports Butteraugli too, wherever the codec exposes it. Every verdict pill in
    the matrix and the editor toolbar is one of the bands below.
  </p>

  <div class="rows">
    {#each bands as band (band.key)}
      <div class="row">
        <span class="value mono">≥ {band.ssim}</span>
        <span class="note">{band.note}</span>
        <Chip tone={chipTone(band.verdict.tone)} uppercase={false}>{band.verdict.label}</Chip>
      </div>
    {/each}
  </div>

  <p class="footnote mono">
    Savings floor · {THRESHOLDS.savingsFloor}% — a saving smaller than this is not worth changing
    format for.
  </p>
</div>

<style>
  .section {
    display: flex;
    flex-direction: column;
  }

  .intro {
    font-size: var(--fs-sm);
    color: var(--muted);
    max-width: 62ch;
    line-height: 1.55;
    margin-bottom: var(--space-5);
  }

  .rows {
    border-top: var(--border-ink);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-5);
    padding: var(--space-4) 0;
    border-bottom: var(--border-hairline);
  }

  .value {
    font-size: var(--fs-mono-lg);
    font-weight: 700;
    flex: none;
    width: 84px;
  }

  .note {
    flex: 1;
    font-size: var(--fs-sm);
    color: var(--muted);
    min-width: 0;
  }

  .footnote {
    font-size: var(--fs-mono-xs);
    letter-spacing: var(--tracking-mono-wide);
    color: var(--faint);
    margin-top: var(--space-4);
  }

  @media (width <= 640px) {
    .row {
      flex-wrap: wrap;
    }

    .note {
      order: 3;
      flex-basis: 100%;
    }
  }
</style>
