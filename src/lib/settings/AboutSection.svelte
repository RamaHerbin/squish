<script lang="ts">
  /**
   * Screen 05, section `/ 06`. The privacy card and DOCS/GIT link cards are
   * lifted verbatim from the bottom of comp 05's single scrolling panel
   * (padding, radii, badge treatment, colours) — relocated here since they
   * are "about the app", not a default to tune.
   */
  import { APP_VERSION_TAG } from '$lib/contracts';
  import { openExternalLink } from '../platform';
  import { BrandDot } from '../ui';
  import SectionHeader from './SectionHeader.svelte';
</script>

<div class="section">
  <SectionHeader accent="ink" index={6} title="About" />

  <div class="row">
    <span class="mono-label">Version</span>
    <span class="version mono">Pinch {APP_VERSION_TAG}</span>
  </div>

  <div class="block">
    <span class="mono-label">Privacy</span>
    <div class="privacy-card">
      <BrandDot accent="blue" size={13} />
      <p>
        Images never leave this device. Encoding runs in WebAssembly inside your browser, there is
        no server to send them to, and the app works with the network switched off.
      </p>
    </div>

    <!-- `openExternalLink` does nothing on the web, so these stay ordinary
         new-tab links. Under Tauri a plain anchor would navigate the app
         window itself to GitHub, so it hands the URL to the system browser. -->
    <div class="links">
      <a
        class="link-card docs"
        href="https://github.com/RamaHerbin/squish#readme"
        target="_blank"
        rel="noopener noreferrer"
        onclick={openExternalLink}
      >
        <span class="badge">DOCS</span>
        <span class="link-label">README</span>
        <span class="spacer"></span>
        <span class="arrow" aria-hidden="true">↗</span>
      </a>
      <a
        class="link-card git"
        href="https://github.com/RamaHerbin/squish"
        target="_blank"
        rel="noopener noreferrer"
        onclick={openExternalLink}
      >
        <span class="badge">GIT</span>
        <span class="link-label">github.com/RamaHerbin/squish</span>
        <span class="spacer"></span>
        <span class="arrow" aria-hidden="true">↗</span>
      </a>
    </div>
  </div>
</div>

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-7);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-5) 0;
    border-top: var(--border-ink);
    border-bottom: var(--border-hairline);
  }

  .version {
    font-size: var(--fs-mono-lg);
    font-weight: 700;
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .privacy-card {
    border: var(--border-ink);
    border-radius: var(--radius-lg);
    padding: 22px 24px;
    display: flex;
    gap: var(--space-5);
    align-items: flex-start;
  }

  .privacy-card :global(.brand-dot) {
    margin-top: 6px;
  }

  .privacy-card p {
    font-size: var(--fs-body);
    line-height: 1.55;
    color: var(--ink);
    text-wrap: pretty;
  }

  .links {
    display: flex;
    gap: var(--space-2);
  }

  .link-card {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 9px;
    border: var(--border-ink);
    border-radius: var(--radius-md);
    padding: 10px 13px;
    min-width: 0;
    text-decoration: none;
    transition: opacity var(--duration-fast) var(--ease-standard);
  }

  .link-card:hover {
    opacity: 0.82;
  }

  .docs {
    background: var(--paper);
    color: var(--ink);
  }

  .git {
    background: var(--ink);
    color: var(--cream);
    border-color: rgba(244, 238, 224, 0.4);
  }

  .badge {
    font-family: var(--font-mono);
    font-size: 8.5px;
    font-weight: 700;
    letter-spacing: var(--tracking-mono-tight);
    padding: 3px 6px;
    border-radius: 4px;
    flex: none;
  }

  .docs .badge {
    background: var(--ink);
    color: var(--cream);
  }

  .git .badge {
    background: var(--cream);
    color: var(--ink);
  }

  .link-label {
    font-size: var(--fs-xs);
    font-weight: var(--fw-subhead);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spacer {
    flex: 1;
  }

  .arrow {
    font-size: var(--fs-xs);
    flex: none;
  }

  @media (width <= 640px) {
    .links {
      flex-direction: column;
    }
  }
</style>
