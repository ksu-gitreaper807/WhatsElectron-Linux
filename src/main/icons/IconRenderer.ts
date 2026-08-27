/**
 * Runtime icon renderer: the tray image and the badge variants.
 *
 * The tray icon on Linux is a 22 px status icon in most themes, and there is no
 * portable "badge overlay" API (Unity's `icon-dbus` experiment and KDE's
 * `com.canonical.Unity.LauncherEntry` badge hint are both dead ends, see
 * docs/LINUX_INTEGRATION.md). So the badge is *drawn into the icon*, which works
 * on every tray implementation that shows an image at all - and the count is
 * additionally offered as tray *title* / *tooltip* text, which is what KDE and
 * GNOME render as text next to the icon.
 *
 * The mark itself is a generic chat bubble, not the WhatsApp trademark: this is
 * an unofficial wrapper and must ship as one. See README ("Brand assets").
 */

import { COLOR, Raster, type Rgba } from './png.js';
import { DIGITS } from './glyphs.js';
import { LIMITS } from '../../shared/constants.js';
import { truncate } from '../../shared/util.js';

export type IconStyle = 'color' | 'symbolic';

export interface IconRenderOptions {
  readonly size: number;
  readonly badge?: number | null;
  readonly background?: Rgba;
  readonly foreground?: Rgba;
  readonly badgeBackground?: Rgba;
  /**
   * `symbolic` draws a single-colour mark on a transparent plate, which is what
   * GTK "symbolic" tray icons and most dark/light-agnostic panels expect.
   */
  readonly style?: IconStyle;
}

export interface RenderedIcon {
  readonly png: Buffer;
  readonly dataUrl: string;
  readonly size: number;
}

/** Draw the app mark at `size`, optionally with a numeric badge. */
export function renderIcon(options: IconRenderOptions): RenderedIcon {
  const size = Math.max(12, Math.min(512, Math.round(options.size)));
  const raster = new Raster(size, size);
  const symbolic = options.style === 'symbolic';
  const background = options.background ?? (symbolic ? COLOR.transparent : COLOR.brand);
  const foreground = options.foreground ?? COLOR.white;

  // Rounded square plate (skipped for symbolic icons: the panel tints them).
  const inset = Math.max(1, size * 0.06);
  const plate = size - inset * 2;
  if (!symbolic) {
    raster.fillRoundedRect(inset, inset, plate, plate, plate * 0.24, background);
  }

  // Speech bubble: a ring with a tail, drawn with primitives so it scales.
  const cx = size / 2;
  const cy = size / 2 - size * 0.04;
  const outer = size * 0.3;
  if (symbolic) {
    // Symbolic variant: an outlined bubble, so the panel's own colour reads.
    raster.fillDisc(cx, cy, outer, foreground);
    raster.fillDisc(cx, cy, outer * 0.62, COLOR.transparent);
  } else {
    raster.fillDisc(cx, cy, outer, foreground);
    raster.fillDisc(cx, cy, outer * 0.55, background);
  }
  // Three dots inside the bubble read as "typing"/"messages".
  const dot = Math.max(0.7, size * 0.045);
  for (const dx of [-1, 0, 1]) {
    raster.fillDisc(cx + dx * outer * 0.42, cy, dot, foreground);
  }

  const badge = options.badge ?? null;
  if (badge !== null && badge > 0) {
    const label = badge > LIMITS.badgeSoftCap ? `${LIMITS.badgeSoftCap}+` : String(badge);
    drawBadge(raster, size, label, options.badgeBackground ?? COLOR.badge, COLOR.white);
  }

  const png = raster.toBuffer();
  return { png, dataUrl: `data:image/png;base64,${png.toString('base64')}`, size };
}

function drawBadge(raster: Raster, size: number, label: string, background: Rgba, foreground: Rgba): void {
  const digits = Array.from(truncate(label, 4));
  const scale = Math.max(1, Math.round(size / 22));
  const glyphWidth = 3 * scale;
  const gap = scale;
  const textWidth = digits.length * glyphWidth + Math.max(0, digits.length - 1) * gap;
  const radius = Math.max(glyphWidth, (textWidth + 2 * scale * 2) / 2 + scale);
  const cx = size - radius * 0.72;
  const cy = radius * 0.72;

  raster.fillDisc(cx, cy, radius, background);

  const textWidthTotal = digits.length * (glyphWidth + gap) - gap;
  let x = Math.round(cx - textWidthTotal / 2);
  const y = Math.round(cy - (5 * scale) / 2);
  for (const digit of digits) {
    const glyph = DIGITS[digit];
    if (glyph) raster.drawGlyph(glyph, x, y, scale, foreground);
    x += glyphWidth + gap;
  }
}

/** All sizes a GTK/libayatana tray and a notification daemon may request. */
export const TRAY_SIZES: readonly number[] = Object.freeze([16, 22, 24, 32, 48]);

export interface IconSet {
  readonly tray: RenderedIcon;
  readonly traySmall: RenderedIcon;
  readonly notification: RenderedIcon;
  readonly bySize: ReadonlyMap<number, RenderedIcon>;
}

export function renderIconSet(badge: number | null, monochrome: boolean): IconSet {
  const bySize = new Map<number, RenderedIcon>();
  const background = monochrome ? COLOR.black : COLOR.brand;
  for (const size of TRAY_SIZES) {
    bySize.set(size, renderIcon({ size, badge: size >= 22 ? badge : null, background }));
  }
  return {
    tray: bySize.get(22) ?? renderIcon({ size: 22, badge }),
    traySmall: bySize.get(16) ?? renderIcon({ size: 16 }),
    notification: renderIcon({ size: 64, background: COLOR.brand }),
    bySize,
  };
}
