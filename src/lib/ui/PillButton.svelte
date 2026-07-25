<script lang="ts">
  /**
   * The editorial pill button. Three variants, three heights:
   *
   * - `solid`   — ink fill, cream text, soft warm shadow ("Choose files",
   *               "Download .zip", "Use AVIF q50")
   * - `outline` — paper fill, 1.5px ink border ("Paste ↗", "Open in editor")
   * - `accent`  — blue fill, white text, ink border (primary in-canvas action)
   *
   * `font="mono"` (default) is the Space Mono caps treatment used everywhere in
   * the chrome; `font="body"` is the Archivo 800 label used on the home screen.
   *
   * Renders an `<a>` when `href` is set, a real `<button>` otherwise.
   */
  import type { Snippet } from 'svelte';
  import { cursorFlair } from './cursor-flair';
  import { accentFill, type ControlFont, type PillSize, type PillVariant } from './types';

  interface Props {
    children: Snippet;
    variant?: PillVariant;
    size?: PillSize;
    font?: ControlFont;
    /** Renders an anchor instead of a button. */
    href?: string;
    /** Anchor target; ignored without `href`. */
    target?: string;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    /** Stretch to the container's width (mobile primary actions). */
    fullWidth?: boolean;
    title?: string;
    ariaLabel?: string;
    ariaPressed?: boolean;
    ariaExpanded?: boolean;
    ariaHasPopup?: boolean;
    ariaControls?: string;
    id?: string;
    /** Leading adornment — a BrandDot, an icon glyph. */
    leading?: Snippet;
    /** Trailing adornment — "↗", a shortcut hint, a caret. */
    trailing?: Snippet;
    /**
     * Opt into the cursor-flair bloom, with this colour as the blob fill (an
     * accent name or any CSS colour). Omit it and the action never mounts.
     */
    flair?: string;
    /**
     * Label colour while the blob covers the pill. Defaults to the inverse of
     * the variant's own fill: ink on `solid`, cream on `outline`/`accent`.
     */
    flairLabel?: string;
    onclick?: (event: MouseEvent) => void;
  }

  let {
    children,
    variant = 'solid',
    size = 44,
    font = 'mono',
    href,
    target,
    type = 'button',
    disabled = false,
    fullWidth = false,
    title,
    ariaLabel,
    ariaPressed,
    ariaExpanded,
    ariaHasPopup,
    ariaControls,
    id,
    leading,
    trailing,
    flair,
    flairLabel,
    onclick,
  }: Props = $props();

  const padding = $derived(size >= 52 ? 26 : size >= 44 ? 22 : 18);

  const flairColor = $derived(flair ? accentFill(flair) : undefined);
  const flairLabelColor = $derived(
    flairLabel ?? (variant === 'solid' ? 'var(--ink)' : 'var(--cream)'),
  );

  /**
   * Pills are wide and squat, so the default 150% blob leaves a sliver
   * uncovered when the cursor enters by a short edge. 200% closes the gap.
   */
  const style = $derived(
    `--pill-h: ${size}px; --pill-px: ${padding}px;` +
      (flairColor ? ` --pill-flair-label: ${flairLabelColor}; --flair-size: 200%;` : ''),
  );
</script>

{#if href}
  <a
    {id}
    {href}
    {target}
    {title}
    class="pill-button {variant} font-{font}"
    class:full={fullWidth}
    class:disabled
    class:has-flair={Boolean(flairColor)}
    {style}
    aria-label={ariaLabel}
    aria-disabled={disabled ? 'true' : undefined}
    rel={target === '_blank' ? 'noreferrer noopener' : undefined}
    use:cursorFlair={{ color: flairColor ?? 'transparent', enabled: Boolean(flairColor) }}
  >
    {#if leading}<span class="adornment">{@render leading()}</span>{/if}
    <span class="label">{@render children()}</span>
    {#if trailing}<span class="adornment">{@render trailing()}</span>{/if}
  </a>
{:else}
  <button
    {id}
    {type}
    {title}
    {disabled}
    {onclick}
    class="pill-button {variant} font-{font}"
    class:full={fullWidth}
    class:has-flair={Boolean(flairColor)}
    {style}
    aria-label={ariaLabel}
    aria-pressed={ariaPressed}
    aria-expanded={ariaExpanded}
    aria-haspopup={ariaHasPopup ? 'true' : undefined}
    aria-controls={ariaControls}
    use:cursorFlair={{ color: flairColor ?? 'transparent', enabled: Boolean(flairColor) }}
  >
    {#if leading}<span class="adornment">{@render leading()}</span>{/if}
    <span class="label">{@render children()}</span>
    {#if trailing}<span class="adornment">{@render trailing()}</span>{/if}
  </button>
{/if}

<style>
  .pill-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    block-size: var(--pill-h);
    padding-inline: var(--pill-px);
    border: var(--border-ink);
    border-radius: var(--radius-pill);
    background: var(--surface);
    color: var(--ink);
    text-decoration: none;
    white-space: nowrap;
    transition:
      background var(--duration-fast) var(--ease-standard),
      color var(--duration-fast) var(--ease-standard),
      transform var(--duration-fast) var(--ease-standard);
  }

  .full {
    display: flex;
    inline-size: 100%;
  }

  .font-mono .label {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .font-body .label {
    font-family: var(--font-body);
    font-size: 12.5px;
    font-weight: var(--fw-subhead);
    letter-spacing: var(--tracking-tight);
  }

  .adornment {
    display: inline-flex;
    align-items: center;
    font-size: var(--fs-xs);
    line-height: 1;
  }

  .solid {
    background: var(--ink);
    color: var(--cream);
    box-shadow: var(--shadow-button);
  }

  .accent {
    background: var(--accent-blue);
    color: var(--paper-white);
    box-shadow: var(--shadow-button);
  }

  .outline {
    background: var(--surface);
    color: var(--ink);
  }

  .pill-button:hover:not(:disabled, .disabled) {
    background: var(--cream);
  }

  .solid:hover:not(:disabled, .disabled) {
    background: color-mix(in srgb, var(--ink) 86%, var(--paper));
  }

  .accent:hover:not(:disabled, .disabled) {
    background: color-mix(in srgb, var(--accent-blue) 88%, var(--ink));
  }

  .pill-button:active:not(:disabled, .disabled) {
    transform: translateY(1px);
  }

  /* ── Cursor flair (cursorFlair action) ─────────────────────────────
     The blob is styled globally in app.css since the action injects it outside
     Svelte's scope. Here we clip it to the pill and lift the label above it.
     Scoped to .has-flair so the plain pills keep their unclipped box. */
  .has-flair {
    position: relative;
    overflow: hidden;
  }

  .has-flair > :global(:not(.flair)) {
    position: relative;
    z-index: 1;
  }

  /* The label flips to the inverse ink once the blob has covered the pill.
     The shorthand repeats background/transform so the base crossfade and the
     1px press survive the hover. */
  .has-flair:hover:not(:disabled, .disabled) {
    color: var(--pill-flair-label);
    transition:
      background var(--duration-fast) var(--ease-standard),
      transform var(--duration-fast) var(--ease-standard),
      color 200ms ease 120ms;
  }

  /* `enabled` is read once at mount, so a pill disabled later hides the blob. */
  .has-flair:disabled :global(.flair),
  .has-flair.disabled :global(.flair) {
    display: none;
  }

  .pill-button:disabled,
  .pill-button.disabled {
    opacity: 0.42;
    box-shadow: none;
    pointer-events: none;
  }
</style>
