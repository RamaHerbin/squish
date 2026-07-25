/**
 * Prop types for the editor controls, split out of the `.svelte` files so the
 * shell can build a props object before it has a component in hand.
 *
 * Contracts-only: this module never imports `state/` or `codecs/`. The caller
 * passes the registry, the current `SideSettings` and an `onchange` callback;
 * the controls are otherwise stateless.
 */

import type {
  EncoderId,
  EncoderRegistry,
  MetricsResult,
  SideSettings,
  Verdict,
} from '../contracts';

/** What both the desktop toolbar and the mobile sheet need. */
export interface EditorControlsData {
  /** Static encoder metadata — labels for the picker. */
  registry: EncoderRegistry;
  /** Ids that passed `featureTest()`. Absent ⇒ every encoder is offered. */
  supportedEncoderIds?: ReadonlySet<EncoderId>;

  /** Side 1's settings — the user's config. Side 0 stays `identity`. */
  settings: SideSettings;
  /** Every control reports here; the caller owns the state. */
  onchange: (settings: SideSettings) => void;

  /** Source file name, e.g. `art.jpg`. */
  fileName: string;
  /** Source file size in bytes. */
  originalBytes: number;
  /** Decoded (preprocessed) source dimensions — seeds the resize aspect lock. */
  sourceWidth: number;
  sourceHeight: number;

  /** Encoded output size, once the encode lands. */
  outputBytes?: number;
  /** True while an encode is in flight. */
  encoding?: boolean;
  /** Human-readable failure from the last encode attempt. */
  error?: string;

  /** Quality metrics for the current output; `null`/absent ⇒ not measured. */
  metrics?: MetricsResult | null;
  /** Overrides `verdictFor(metrics.ssim)` — pass one when the caller knows better. */
  verdict?: Verdict;
  /** Muted aside under the verdict, e.g. `AVIF would be 63% smaller`. */
  metricsNote?: string;

  /** Invoked by the download pill and by ⌘S / Ctrl+S. */
  onDownload?: () => void;
  /** Greys out the pill and disables the shortcut. */
  downloadDisabled?: boolean;
}

export interface ToolbarProps extends EditorControlsData {
  /** Drives the `Advanced ›` / `Advanced ˄` link. The caller owns the state. */
  advancedOpen: boolean;
  onAdvancedToggle: (open: boolean) => void;
  /** Register the ⌘S / Ctrl+S download shortcut. Default `true`. */
  shortcut?: boolean;
}

export interface MobileSheetProps extends EditorControlsData {
  advancedOpen: boolean;
  onAdvancedToggle: (open: boolean) => void;
}

export interface AdvancedDrawerProps {
  settings: SideSettings;
  onchange: (settings: SideSettings) => void;
  /** For the encoder name in the header. Falls back to the raw id. */
  registry?: EncoderRegistry;
  /** `Collapse ˅`. Absent ⇒ the link is not rendered. */
  onCollapse?: () => void;
  /** Single column, scrollable — the mobile sheet's build. */
  compact?: boolean;
}

export interface EncoderPopoverProps {
  value: EncoderId;
  registry: EncoderRegistry;
  supportedEncoderIds?: ReadonlySet<EncoderId>;
  /** Fired with the chosen encoder id; the caller applies `withEncoder`. */
  onValue: (id: EncoderId) => void;
  /** Trigger width — `186px` in the toolbar. */
  width?: string;
  /** Panel side. The toolbar sits at the bottom of the screen, so `top-start`. */
  placement?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';
  /** Render the trigger as the mobile codec row's 44px `▾` button. */
  compact?: boolean;
  disabled?: boolean;
}

export interface ResizeControlProps {
  settings: SideSettings;
  onchange: (settings: SideSettings) => void;
  /** Decoded source size — seeds the width/height fields and the aspect lock. */
  sourceWidth: number;
  sourceHeight: number;
  /** `top-start` in the desktop toolbar, `bottom-start` in the mobile sheet. */
  placement?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';
}
