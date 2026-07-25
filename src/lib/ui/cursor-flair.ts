/**
 * gsap.com-style cursor "flair", dependency-free.
 *
 * A circular blob grows from the exact point where the cursor enters the
 * element, follows the cursor with a soft lag while hovering, and shrinks
 * back toward the exit point. Ported from the GSAP original in the author's
 * cv-interactif project: `quickTo` becomes a rAF lerp, the scale tweens
 * become a CSS transition, `prefers-reduced-motion` gets instant show/hide.
 *
 * The action injects `<span class="flair"><span class="flair__blob">` as the
 * node's first child. Those nodes land outside every component's scoped styles,
 * so they are styled globally in app.css; the host only clips them and lifts
 * its own content above the blob. See SettingsNav.svelte and PillButton.svelte.
 */

import type { Action } from 'svelte/action';

export interface CursorFlairParams {
  /** Fill of the blob, any CSS color, usually `var(--accent-…)`. */
  color: string;
  /** When false the action is inert: no nodes injected, no listeners. */
  enabled?: boolean;
}

/** Per-frame catch-up factor. Visually equivalent to quickTo power3 at 60fps. */
const FOLLOW = 0.18;

/** Below this delta (in % points) the follow loop parks itself. */
const SETTLE = 0.05;

export const cursorFlair: Action<HTMLElement, CursorFlairParams> = (node, params) => {
  if (params.enabled === false) return;

  const flair = document.createElement('span');
  flair.className = 'flair';
  flair.setAttribute('aria-hidden', 'true');
  const blob = document.createElement('span');
  blob.className = 'flair__blob';
  blob.style.background = params.color;
  flair.appendChild(blob);
  node.insertBefore(flair, node.firstChild);

  const reduce =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Current and target positions, in % of the node's box. */
  let x = 50;
  let y = 50;
  let targetX = 50;
  let targetY = 50;
  let frame = 0;

  const apply = () => {
    flair.style.transform = `translate(${x}%, ${y}%)`;
  };

  const step = () => {
    frame = 0;
    x += (targetX - x) * FOLLOW;
    y += (targetY - y) * FOLLOW;
    if (Math.abs(targetX - x) < SETTLE && Math.abs(targetY - y) < SETTLE) {
      x = targetX;
      y = targetY;
      apply();
      return;
    }
    apply();
    frame = requestAnimationFrame(step);
  };

  const follow = () => {
    if (!frame) frame = requestAnimationFrame(step);
  };

  const pos = (event: MouseEvent) => {
    const rect = node.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100,
      y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * 100,
    };
  };

  const onEnter = (event: MouseEvent) => {
    const at = pos(event);
    // Snap the origin to the entry point before the bloom starts.
    x = targetX = at.x;
    y = targetY = at.y;
    apply();
    if (reduce) {
      blob.style.transition = 'none';
    }
    blob.classList.add('is-in');
  };

  const onMove = (event: MouseEvent) => {
    if (reduce) return;
    const at = pos(event);
    targetX = at.x;
    targetY = at.y;
    follow();
  };

  const onLeave = (event: MouseEvent) => {
    const at = pos(event);
    if (reduce) {
      blob.classList.remove('is-in');
      return;
    }
    // Drift toward the exit point while shrinking, like the original.
    targetX = at.x;
    targetY = at.y;
    follow();
    blob.classList.remove('is-in');
  };

  node.addEventListener('mouseenter', onEnter);
  node.addEventListener('mousemove', onMove);
  node.addEventListener('mouseleave', onLeave);

  return {
    update(next: CursorFlairParams) {
      blob.style.background = next.color;
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      node.removeEventListener('mouseenter', onEnter);
      node.removeEventListener('mousemove', onMove);
      node.removeEventListener('mouseleave', onLeave);
      flair.remove();
    },
  };
};
