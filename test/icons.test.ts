import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { renderIcon, renderIconSet } from '../src/main/icons/IconRenderer.js';
import { COLOR, Raster, crc32, encodePng } from '../src/main/icons/png.js';

describe('png encoder', () => {
  it('writes a valid 8-bit RGBA PNG header', () => {
    const buffer = encodePng(2, 2, new Uint8Array(2 * 2 * 4));
    expect([...buffer.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(buffer.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(buffer.readUInt32BE(16)).toBe(2);
    expect(buffer.readUInt32BE(20)).toBe(2);
    expect(buffer[24]).toBe(8); // bit depth
    expect(buffer[25]).toBe(6); // colour type: RGBA
    expect(buffer.subarray(-8, -4).toString('ascii')).toBe('IEND');
    // the IEND chunk is length 0 with a valid CRC: 12 bytes total
    expect(buffer.readUInt32BE(buffer.length - 12)).toBe(0);
  });

  it('rejects a buffer whose length does not match the dimensions', () => {
    expect(() => encodePng(4, 4, new Uint8Array(10))).toThrow(RangeError);
  });

  it('computes the CRC32 of a chunk the way PNG requires', () => {
    // Known value: crc32('IEND') = 0xae426082
    expect(crc32(Buffer.from('IEND', 'ascii'))).toBe(0xae426082);
  });

  it('is deterministic, so a rebuild does not churn binaries', () => {
    const a = renderIcon({ size: 32, badge: 7 }).png;
    const b = renderIcon({ size: 32, badge: 7 }).png;
    expect(a.equals(b)).toBe(true);
  });

  it('emits a data URL that decodes back to the same bytes', () => {
    const icon = renderIcon({ size: 16 });
    const base64 = icon.dataUrl.replace('data:image/png;base64,', '');
    expect(Buffer.from(base64, 'base64').equals(icon.png)).toBe(true);
  });
});

describe('raster primitives', () => {
  it('paints opaque pixels only inside the rectangle', () => {
    const raster = new Raster(4, 4);
    raster.fillRect(1, 1, 2, 2, COLOR.black);
    const at = (x: number, y: number): number => raster.data[(y * 4 + x) * 4 + 3] ?? 0;
    expect(at(0, 0)).toBe(0);
    expect(at(1, 1)).toBe(255);
    expect(at(2, 2)).toBe(255);
    expect(at(3, 3)).toBe(0);
  });

  it('anti-aliases the edge of a disc', () => {
    const raster = new Raster(16, 16);
    raster.fillDisc(8, 8, 5, COLOR.white);
    const alphas = [...raster.data].filter((_, index) => index % 4 === 3);
    expect(alphas.some((alpha) => alpha > 0 && alpha < 255)).toBe(true);
    expect(alphas.some((alpha) => alpha === 255)).toBe(true);
  });

  it('draws a glyph at the requested scale', () => {
    const raster = new Raster(8, 8);
    raster.drawGlyph(['##', '#.'], 0, 0, 2, COLOR.white);
    // two columns at scale 2 covers x=0..3
    expect(raster.data[0]).toBe(255);
    expect(raster.data[(0 * 8 + 3) * 4]).toBe(255);
    expect(raster.data[(0 * 8 + 4) * 4]).toBe(0);
  });

  it('clamps nonsense sizes to something drawable', () => {
    expect(renderIcon({ size: 1 }).size).toBeGreaterThanOrEqual(12);
    expect(renderIcon({ size: 10_000 }).size).toBeLessThanOrEqual(512);
  });
});

describe('badge rendering', () => {
  it('adds ink only when there is something to report', () => {
    const ink = (icon: { png: Buffer }): number => {
      let count = 0;
      // decode the PNG through zlib to inspect the raw pixels
      const bytes = icon.png;
      let offset = 8;
      const idat: Buffer[] = [];
      while (offset < bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
        if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length));
        offset += 12 + length;
      }
      const raw = inflateSync(Buffer.concat(idat));
      const width = 22;
      for (let i = 0; i < raw.length; i += 1) {
        if (i % (width * 4 + 1) === 0) continue; // filter byte
        const channel = (i % (width * 4 + 1)) % 4;
        if (channel === 3 && (raw[i] ?? 0) > 0) count += 1;
      }
      return count;
    };

    const plain = ink(renderIcon({ size: 22 }));
    const badged = ink(renderIcon({ size: 22, badge: 3 }));
    expect(badged).toBeGreaterThan(plain);
  });

  it('caps the badge text at 99+', () => {
    const huge = renderIcon({ size: 64, badge: 5_000 });
    const capped = renderIcon({ size: 64, badge: 99 });
    expect(huge.png.length).toBeGreaterThan(0);
    expect(huge.png.equals(capped.png)).toBe(false);
  });

  it('produces a set with a tray and notification icon', () => {
    const set = renderIconSet(4, false);
    expect(set.tray.size).toBe(22);
    expect(set.notification.size).toBe(64);
    expect(set.bySize.get(16)?.size).toBe(16);
  });
});
