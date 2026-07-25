<script lang="ts">
  /**
   * Service-worker lifecycle toasts: "update available" (with a Reload
   * action) and "ready to work offline". Ink pill, floating bottom-centre,
   * the one yellow accent action in the whole shell — there is no comp for
   * this (it is a transient system message, not a screen), so it borrows
   * the editorial vocabulary (ink fill, pill radius, mono caps CTA) rather
   * than copying one pixel-for-pixel.
   *
   * Mount this ONCE, near the root — importing it is what pulls in
   * `sw-registration.svelte.ts`, which is what actually registers the
   * service worker. See that file's doc comment.
   */
  import { swStatus } from './sw-registration.svelte';

  let reloading = $state(false);

  async function handleReload(): Promise<void> {
    reloading = true;
    try {
      await swStatus.reload();
    } finally {
      reloading = false;
    }
  }
</script>

{#if swStatus.needRefresh}
  <div class="toast" role="status">
    <p class="toast-text">A new version of Pinch is ready.</p>
    <div class="toast-actions">
      <button type="button" class="toast-cta" onclick={handleReload} disabled={reloading}>
        {reloading ? 'Reloading…' : 'Reload'}
      </button>
      <button
        type="button"
        class="toast-dismiss"
        onclick={() => swStatus.dismissNeedRefresh()}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  </div>
{:else if swStatus.offlineReady}
  <div class="toast" role="status">
    <p class="toast-text">Pinch is ready to work offline.</p>
    <button
      type="button"
      class="toast-dismiss"
      onclick={() => swStatus.dismissOfflineReady()}
      aria-label="Dismiss"
    >
      ✕
    </button>
  </div>
{/if}

<style>
  .toast {
    position: fixed;
    left: 50%;
    bottom: var(--space-6);
    transform: translateX(-50%);
    z-index: var(--z-toast);
    display: flex;
    align-items: center;
    gap: var(--space-4);
    max-width: min(92vw, 26rem);
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-5);
    border-radius: var(--radius-pill);
    background: var(--ink);
    color: var(--cream);
    box-shadow: var(--shadow-pop);
    font-family: var(--font-body);
  }

  .toast-text {
    margin: 0;
    font-size: var(--fs-sm);
    flex: 1;
    white-space: nowrap;
  }

  .toast-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: none;
  }

  .toast-cta {
    border: var(--border-ink);
    border-radius: var(--radius-pill);
    padding: 8px 16px;
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: var(--fs-mono-md);
    letter-spacing: var(--tracking-mono);
    text-transform: uppercase;
    color: var(--ink);
    background: var(--accent-yellow);
    cursor: pointer;
    transition: background var(--duration-fast) var(--ease-standard);
  }

  .toast-cta:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-yellow) 85%, var(--ink));
  }

  .toast-cta:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .toast-dismiss {
    border: 0;
    background: transparent;
    color: var(--cream-muted);
    cursor: pointer;
    font-size: var(--fs-sm);
    line-height: 1;
    flex: none;
    padding: var(--space-1);
  }

  .toast-dismiss:hover {
    color: var(--cream);
  }

  @media (width <= 640px) {
    .toast {
      left: var(--space-4);
      right: var(--space-4);
      bottom: var(--space-4);
      transform: none;
      max-width: none;
    }

    .toast-text {
      white-space: normal;
    }
  }
</style>
