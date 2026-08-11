import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { transcodeCover, isValidImageBuffer } from './cover-transcode.js';
import { COVER_SIZES, COVER_SIZE_PX } from './cover-types.js';

async function makeJpeg(width: number, height: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: color },
  }).jpeg().toBuffer();
}

describe('transcodeCover', () => {
  it('rejects empty buffers', async () => {
    await expect(transcodeCover(Buffer.alloc(0))).rejects.toThrow();
  });

  it('emits the source dimensions', async () => {
    const src = await makeJpeg(800, 1200, { r: 100, g: 50, b: 25 });
    const result = await transcodeCover(src);
    expect(result.width).toBe(800);
    expect(result.height).toBe(1200);
  });

  it('extracts a dominant color', async () => {
    const src = await makeJpeg(100, 100, { r: 200, g: 100, b: 50 });
    const result = await transcodeCover(src);
    expect(result.dominantColor).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('produces all 6 variants', async () => {
    const src = await makeJpeg(600, 900, { r: 60, g: 80, b: 120 });
    const result = await transcodeCover(src);
    for (const size of COVER_SIZES) {
      expect(result.variants[size]).toBeDefined();
      expect(result.variants[size].jpg.length).toBeGreaterThan(0);
      expect(result.variants[size].avif.length).toBeGreaterThan(0);
    }
  }, 15000);

  it('respects max width for each size', async () => {
    const src = await makeJpeg(2000, 3000, { r: 50, g: 80, b: 120 });
    const result = await transcodeCover(src);
    for (const size of COVER_SIZES) {
      const meta = await sharp(result.variants[size].jpg).metadata();
      expect(meta.width).toBeLessThanOrEqual(COVER_SIZE_PX[size]);
    }
  }, 15000);

  it('does not upscale small images', async () => {
    const src = await makeJpeg(80, 120, { r: 200, g: 100, b: 50 });
    const result = await transcodeCover(src);
    const meta = await sharp(result.variants.M.jpg).metadata();
    expect(meta.width).toBeLessThanOrEqual(80);
  });

  it('produces valid JPG and AVIF outputs', async () => {
    const src = await makeJpeg(400, 600, { r: 60, g: 80, b: 120 });
    const result = await transcodeCover(src);
    const jpgMeta = await sharp(result.variants.M.jpg).metadata();
    const avifMeta = await sharp(result.variants.M.avif).metadata();
    expect(jpgMeta.format).toBe('jpeg');
    expect(['avif', 'heif']).toContain(avifMeta.format);
  });
});

describe('isValidImageBuffer', () => {
  it('rejects non-buffers', () => {
    expect(isValidImageBuffer('hi')).toBe(false);
    expect(isValidImageBuffer(null)).toBe(false);
    expect(isValidImageBuffer(undefined)).toBe(false);
  });
  it('rejects empty buffers', () => {
    expect(isValidImageBuffer(Buffer.alloc(0))).toBe(false);
  });
  it('accepts non-empty buffers', () => {
    expect(isValidImageBuffer(Buffer.from('x'))).toBe(true);
  });
});
