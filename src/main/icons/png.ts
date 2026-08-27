/**
 * Minimal RGBA PNG writer plus a tiny raster canvas.
 *
 * Why: the tray badge ("WhatsApp (3)") and the notification icon have to be
 * produced *at runtime*, on a machine where the packaged icon may be missing
 * (running from a checkout) and where a badge count of 7 is not a file we ship.
 * Drawing the image and encoding it here costs ~150 lines, has zero
 * dependencies, is deterministic, and works identically in a test runner.
 *
 * PNG layout used: 8-bit RGBA (colour type 6), no interlace, filter 0 per scan
 * line, zlib deflate - the smallest correct subset of the format.
 */

import { deflateSync } from 'node:zlib';

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export const COLOR = Object.freeze({
  transparent: { r: 0, g: 0, b: 0, a: 0 } satisfies Rgba,
  white: { r: 255, g: 255, b: 255, a: 255 } satisfies Rgba,
  black: { r: 17, g: 27, b: 33, a: 255 } satisfies Rgba,
  brand: { r: 37, g: 211, b: 102, a: 255 } satisfies Rgba,
  brandDark: { r: 18, g: 140, b: 74, a: 255 } satisfies Rgba,
  badge: { r: 222, g: 52, b: 52, a: 255 } satisfies Rgba,
  grey: { r: 130, g: 140, b: 148, a: 255 } satisfies Rgba,
});

export class Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.data = new Uint8Array(this.width * this.height * 4);
  }

  blend(x: number, y: number, color: Rgba, coverage: number): void {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const alpha = Math.max(0, Math.min(1, coverage)) * (color.a / 255);
    const offset = (py * this.width + px) * 4;
    const inverse = 1 - alpha;
    this.data[offset] = Math.round(color.r * alpha + (this.data[offset] ?? 0) * inverse);
    this.data[offset + 1] = Math.round(color.g * alpha + (this.data[offset + 1] ?? 0) * inverse);
    this.data[offset + 2] = Math.round(color.b * alpha + (this.data[offset + 2] ?? 0) * inverse);
    this.data[offset + 3] = Math.round(255 * alpha + (this.data[offset + 3] ?? 0) * inverse);
  }

  fill(x: number, y: number, color: Rgba): void {
    this.blend(x, y, color, 1);
  }

  fillRect(x: number, y: number, w: number, h: number, color: Rgba): void {
    for (let py = Math.floor(y); py < Math.ceil(y + h); py += 1) {
      for (let px = Math.floor(x); px < Math.ceil(x + w); px += 1) {
        const cx = Math.max(px, x);
        const cy = Math.max(py, y);
        const coverX = Math.min(px + 1, x + w) - cx;
        const coverY = Math.min(py + 1, y + h) - cy;
        this.blend(px, py, color, Math.max(0, coverX) * Math.max(0, coverY));
      }
    }
  }

  /** Analytic disc coverage, so small badges still look round. */
  fillDisc(cx: number, cy: number, radius: number, color: Rgba): void {
    const start = Math.floor(cy - radius);
    const end = Math.ceil(cy + radius);
    const startX = Math.floor(cx - radius);
    const endX = Math.ceil(cx + radius);
    for (let py = start; py <= end; py += 1) {
      for (let px = startX; px <= endX; px += 1) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance <= radius - 0.7071) {
          this.blend(px, py, color, 1);
        } else if (distance < radius + 0.7071) {
          this.blend(px, py, color, radius + 0.7071 - distance);
        }
      }
    }
  }

  /** Rounded rectangle, corner radius clamped to half the smaller side. */
  fillRoundedRect(x: number, y: number, w: number, h: number, radius: number, color: Rgba): void {
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    this.fillRect(x, y + r, w, h - 2 * r, color);
    this.fillRect(x + r, y, w - 2 * r, r, color);
    this.fillRect(x + r, y + h - r, w - 2 * r, r, color);
    this.fillDisc(x + r, y + r, r, color);
    this.fillDisc(x + w - r, y + r, r, color);
    this.fillDisc(x + r, y + h - r, r, color);
    this.fillDisc(x + w - r, y + h - r, r, color);
  }

  /** Draw a bitmap glyph: rows of characters, `#` (or any of `#@1`) is ink. */
  drawGlyph(glyph: readonly string[], x: number, y: number, scale: number, color: Rgba): void {
    for (let row = 0; row < glyph.length; row += 1) {
      const line = glyph[row] ?? '';
      for (let col = 0; col < line.length; col += 1) {
        const value = line[col];
        if (value === '#' || value === '@' || value === '1') {
          this.fillRect(x + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
  }

  toBuffer(): Buffer {
    return encodePng(this.width, this.height, this.data);
  }

  toDataURL(): string {
    return `data:image/png;base64,${this.toBuffer().toString('base64')}`;
  }
}

const CRC_TABLE: Int32Array = buildCrcTable();

function buildCrcTable(): Int32Array {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
}

export function crc32(buffer: Uint8Array): number {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ (buffer[i] ?? 0)) & 0xff] ?? 0);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, payload: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, payload])));
  return Buffer.concat([length, typeBuffer, payload, crc]);
}

/** Encode raw RGBA (row major, 4 bytes per pixel) as a PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new RangeError(`png: expected ${width * height * 4} bytes, got ${rgba.length}`);
  }
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: None
    offset += 1;
    const rowStart = y * width * 4;
    raw.set(rgba.subarray(rowStart, rowStart + width * 4), offset);
    offset += width * 4;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // no filtering beyond per-scanline filter byte
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
