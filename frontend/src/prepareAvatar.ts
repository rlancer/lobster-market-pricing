/** Client-side avatar prep — square crop with optional pan/zoom, or SVG pass-through. */

const MAX_EDGE = 512;
const JPEG_QUALITY = 0.88;
const MAX_BYTES = 5_242_880;

export type PreparedAvatar = {
  blob: Blob;
  contentType: 'image/jpeg' | 'image/svg+xml';
};

/**
 * Framing for the circular avatar. Zoom 1 = largest square that fits the
 * image (cover). Higher zoom crops tighter. Pan is relative to remaining
 * travel: 0 centered, ±1 flush to that edge.
 */
export type AvatarCrop = {
  zoom: number;
  panX: number;
  panY: number;
};

export const DEFAULT_AVATAR_CROP: AvatarCrop = { zoom: 1, panX: 0, panY: 0 };

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function normalizeAvatarCrop(crop?: AvatarCrop | null): AvatarCrop {
  const zoom = clamp(crop?.zoom ?? 1, 1, 4);
  return {
    zoom,
    panX: clamp(crop?.panX ?? 0, -1, 1),
    panY: clamp(crop?.panY ?? 0, -1, 1),
  };
}

/** Source square in image pixels for the given framing. */
export function avatarCropRect(
  width: number,
  height: number,
  crop?: AvatarCrop | null,
): { sx: number; sy: number; side: number } {
  const nw = Math.max(0, width);
  const nh = Math.max(0, height);
  const { zoom, panX, panY } = normalizeAvatarCrop(crop);
  const minSide = Math.min(nw, nh);
  const side = minSide / zoom;
  const maxX = Math.max(0, nw - side);
  const maxY = Math.max(0, nh - side);
  const sx = (maxX / 2) * (1 + panX);
  const sy = (maxY / 2) * (1 + panY);
  return { sx, sy, side };
}

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

/** Resolve when the browser can paint `src` in an <img>; reject on error. */
export function preloadImage(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Could not load saved photo'));
    img.decoding = 'async';
    img.src = src;
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
 * Raster images: square-crop (pan/zoom optional), scale to ≤512px, encode JPEG.
 * SVG: validate and upload as vector (no rasterization).
 */
export async function prepareAvatarUpload(
  file: File,
  crop?: AvatarCrop | null,
): Promise<PreparedAvatar> {
  if (isSvgFile(file)) {
    return prepareSvgUpload(file);
  }
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose a JPEG, PNG, WebP, or SVG image');
  }
  const img = await loadImage(file);
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  const { sx, sy, side } = avatarCropRect(nw, nh, crop);
  if (side < 32) throw new Error('Image is too small');
  const edge = Math.min(MAX_EDGE, Math.floor(side));
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

export function isSvgAvatarFile(file: File): boolean {
  return isSvgFile(file);
}
