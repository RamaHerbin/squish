<script lang="ts">
  /**
   * The "dot / 0N Title" header that opens every section of the Settings
   * screen (comp 05, adapted per-section: `/ 01` Defaults through `/ 06`
   * About).
   */
  import { BrandDot } from '../ui';
  import type { AccentName } from '../ui';

  interface Props {
    /** Section accent — same colour as its sidebar dot. */
    accent: AccentName | string;
    /** 1-based position in the sidebar, rendered as `/ 0N`. */
    index: number;
    title: string;
  }

  let { accent, index, title }: Props = $props();

  const indexLabel = $derived(`/ ${String(index).padStart(2, '0')}`);
</script>

<div class="section-header">
  <BrandDot {accent} size={14} radius={3} />
  <span class="index mono">{indexLabel}</span>
  <h2 class="title">{title}</h2>
</div>

<style>
  .section-header {
    display: flex;
    align-items: center;
    gap: 11px;
  }

  .index {
    font-family: var(--font-mono);
    font-size: var(--fs-mono-md);
    font-weight: 700;
    opacity: 0.5;
  }

  .title {
    font-size: var(--fs-h2);
    font-weight: var(--fw-heading);
    letter-spacing: -0.025em;
  }
</style>
