/** Client-side avatar prep — raster square-crop, or pass-through SVG. */

const MAX_EDGE = 512;
const JPEG_QUALITY = 0.88;
const MAX_BYTES = 5_242_880;

export type PreparedAvatar = {
  blob: Blob;
  contentType: 'image/jpeg' | 'image/svg+xml';
};

function isSvgFile(file: File): boolean {
  const type = (file.type || '').toLowerCase();
  if (type === 'image/svg+xml') return true;
  return /\.svg$/i.test(file.name || '');
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image'));
    };
    img.src = url;
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error('Could not encode avatar'));
        else resolve(blob);
      },
      'image/jpeg',
      quality,
    );
  });
}

async function prepareSvgUpload(file: File): Promise<PreparedAvatar> {
  if (file.size > MAX_BYTES) {
    throw new Error('Avatar must be 5 MB or smaller');
  }
  const text = await file.text();
  const head = text.trimStart().slice(0, 256).toLowerCase();
  if (!head.startsWith('<svg') && !head.startsWith('<?xml')) {
    throw new Error('File is not a valid SVG');
  }
  if (!/<svg[\s>]/i.test(text)) {
    throw new Error('File is not a valid SVG');
  }
  if (/<script[\s>/]|on[a-z]+\s*=|javascript:|data:\s*text\/html|<foreignObject/i.test(text)) {
    throw new Error('SVG contains disallowed content');
  }
  return {
    blob: new Blob([text], { type: 'image/svg+xml' }),
    contentType: 'image/svg+xml',
  };
}

/**
 * Raster images: center-crop to square, scale to ≤512px, encode JPEG.
 * SVG: validate and upload as vector (no rasterization).
 */
export async function prepareAvatarUpload(file: File): Promise<PreparedAvatar> {
  if (isSvgFile(file)) {
    return prepareSvgUpload(file);
  }
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose a JPEG, PNG, WebP, or SVG image');
  }
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
  if (side < 32) throw new Error('Image is too small');
  const sx = Math.floor(((img.naturalWidth || img.width) - side) / 2);
  const sy = Math.floor(((img.naturalHeight || img.height) - side) / 2);
  const edge = Math.min(MAX_EDGE, side);
  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not prepare avatar');
  ctx.drawImage(img, sx, sy, side, side, 0, 0, edge, edge);

  let quality = JPEG_QUALITY;
  let blob = await canvasToJpeg(canvas, quality);
  while (blob.size > MAX_BYTES && quality > 0.45) {
    quality -= 0.1;
    blob = await canvasToJpeg(canvas, quality);
  }
  if (blob.size > MAX_BYTES) {
    throw new Error('Avatar must be 5 MB or smaller after resize');
  }
  return { blob, contentType: 'image/jpeg' };
}
