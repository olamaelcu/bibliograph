import sharp from 'sharp';
import { COVER_SIZE_PX, type CoverSize } from './cover-types.js';
import { COVER_SIZES } from './cover-types.js';

export interface TranscodedCover {
  width: number;
  height: number;
  variants: Record<CoverSize, { jpg: Buffer; avif: Buffer }>;
  dominantColor: string;
}

const JPEG_QUALITY = 82;
const AVIF_QUALITY = 50;
const AVIF_EFFORT = 4;

export async function transcodeCover(source: Buffer): Promise<TranscodedCover> {
  if (!Buffer.isBuffer(source) || source.length === 0) {
    throw new Error('transcodeCover: source is empty');
  }

  const meta = await sharp(source).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) {
    throw new Error('transcodeCover: unable to determine source dimensions');
  }

  const dominantColor = await extractDominantColor(source);

  const variants: TranscodedCover['variants'] = {} as TranscodedCover['variants'];

  for (const size of COVER_SIZES) {
    const targetPx = COVER_SIZE_PX[size];
    const pipeline = sharp(source)
      .resize({
        width: targetPx,
        withoutEnlargement: true,
        fit: 'inside',
      });

    const [jpg, avif] = await Promise.all([
      pipeline
        .clone()
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true, progressive: true })
        .toBuffer(),
      pipeline
        .clone()
        .avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT })
        .toBuffer(),
    ]);

    variants[size] = { jpg, avif };
  }

  return { width, height, variants, dominantColor };
}

async function extractDominantColor(source: Buffer): Promise<string> {
  const { dominant } = await sharp(source)
    .resize(1, 1, { fit: 'cover' })
    .stats();
  return rgbToHex(dominant.r, dominant.g, dominant.b);
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const hex = (v: number) => clamp(v).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function isValidImageBuffer(source: unknown): source is Buffer {
  return Buffer.isBuffer(source) && source.length > 0;
}
