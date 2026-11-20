import { CropRect, LayoutConfig, SplitLayoutMode, VideoTransform } from '../types/editor';

export interface ZoneBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrawRect {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export interface CropAndCoverRect extends DrawRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  domLeft: number;
  domTop: number;
  domWidth: number;
  domHeight: number;
}

export const FULL_CROP: CropRect = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
};

export const DEFAULT_TRANSFORM: VideoTransform = {
  zoom: 1,
  panX: 0,
  panY: 0,
};

export const DEFAULT_LAYOUT: LayoutConfig = {
  mode: 'gameplay-top',
  splitRatio: 0.5,
  gameplayTransform: { ...DEFAULT_TRANSFORM },
  facecamTransform: { ...DEFAULT_TRANSFORM },
  gameplayVolume: 0.85,
  facecamVolume: 1.0,
  gameplayMuted: false,
  facecamMuted: false,
  facecamSyncOffset: 0,
  facecamActiveRange: null,
};

export const LAYOUT_LABELS: Record<SplitLayoutMode, string> = {
  'gameplay-top': 'Gameplay Top / Facecam Bottom',
  'facecam-top': 'Facecam Top / Gameplay Bottom',
  'side-by-side': 'Side by Side',
  'full-gameplay': 'Full Gameplay',
  'full-facecam': 'Full Facecam',
};

export function normalizeCropRect(crop?: CropRect): CropRect {
  if (!crop) return FULL_CROP;
  const x = Math.min(0.94, Math.max(0, crop.x));
  const y = Math.min(0.94, Math.max(0, crop.y));
  const width = Math.min(1 - x, Math.max(0.06, crop.width));
  const height = Math.min(1 - y, Math.max(0.06, crop.height));
  return { x, y, width, height };
}

export function hasActiveCrop(crop?: CropRect): boolean {
  if (!crop) return false;
  return (
    crop.x > 0.005 ||
    crop.y > 0.005 ||
    crop.width < 0.995 ||
    crop.height < 0.995
  );
}

/**
 * Computes exact pixel zone boxes inside a canvas of (canvasW x canvasH)
 * for gameplay and facecam based on layout mode and splitRatio.
 */
export function computeZoneBoxes(
  canvasW: number,
  canvasH: number,
  mode: SplitLayoutMode,
  splitRatio: number
): { gameplay: ZoneBox | null; facecam: ZoneBox | null } {
  const ratio = Math.min(0.85, Math.max(0.15, splitRatio));

  switch (mode) {
    case 'gameplay-top': {
      const topH = Math.round(canvasH * ratio);
      return {
        gameplay: { x: 0, y: 0, width: canvasW, height: topH },
        facecam: { x: 0, y: topH, width: canvasW, height: canvasH - topH },
      };
    }
    case 'facecam-top': {
      const topH = Math.round(canvasH * ratio);
      return {
        facecam: { x: 0, y: 0, width: canvasW, height: topH },
        gameplay: { x: 0, y: topH, width: canvasW, height: canvasH - topH },
      };
    }
    case 'side-by-side': {
      const leftW = Math.round(canvasW * ratio);
      return {
        gameplay: { x: 0, y: 0, width: leftW, height: canvasH },
        facecam: { x: leftW, y: 0, width: canvasW - leftW, height: canvasH },
      };
    }
    case 'full-gameplay':
      return {
        gameplay: { x: 0, y: 0, width: canvasW, height: canvasH },
        facecam: null,
      };
    case 'full-facecam':
      return {
        gameplay: null,
        facecam: { x: 0, y: 0, width: canvasW, height: canvasH },
      };
  }
}

/**
 * Computes the destination rectangle for drawing a video of (srcW x srcH)
 * inside a clipped zone box using object-cover semantics + user zoom + normalized pan.
 */
export function computeCoverDrawRect(
  srcW: number,
  srcH: number,
  zone: ZoneBox,
  transform: VideoTransform
): DrawRect {
  const safeSrcW = srcW > 0 ? srcW : 1920;
  const safeSrcH = srcH > 0 ? srcH : 1080;

  const baseScale = Math.max(zone.width / safeSrcW, zone.height / safeSrcH);
  const scale = baseScale * Math.max(1, transform.zoom);

  const dw = safeSrcW * scale;
  const dh = safeSrcH * scale;

  const maxOverflowX = Math.max(0, (dw - zone.width) / 2);
  const maxOverflowY = Math.max(0, (dh - zone.height) / 2);

  const panOffsetX = transform.panX * maxOverflowX;
  const panOffsetY = transform.panY * maxOverflowY;

  const dx = zone.x + (zone.width - dw) / 2 + panOffsetX;
  const dy = zone.y + (zone.height - dh) / 2 + panOffsetY;

  return { dx, dy, dw, dh };
}

/**
 * Unified crop + cover + pan + zoom geometry for both Canvas 9-arg drawImage
 * and HTML DOM <video> / <iframe> placement inside overflow-hidden zone boxes.
 */
export function computeCropAndCover(
  srcW: number,
  srcH: number,
  zone: ZoneBox,
  transform: VideoTransform
): CropAndCoverRect {
  const safeSrcW = srcW > 0 ? srcW : 1920;
  const safeSrcH = srcH > 0 ? srcH : 1080;
  const crop = normalizeCropRect(transform.crop);

  const sx = crop.x * safeSrcW;
  const sy = crop.y * safeSrcH;
  const sw = crop.width * safeSrcW;
  const sh = crop.height * safeSrcH;

  const cover = computeCoverDrawRect(sw, sh, zone, transform);

  const domWidth = cover.dw / crop.width;
  const domHeight = cover.dh / crop.height;
  const domLeft = cover.dx - zone.x - crop.x * domWidth;
  const domTop = cover.dy - zone.y - crop.y * domHeight;

  return {
    sx,
    sy,
    sw,
    sh,
    dx: cover.dx,
    dy: cover.dy,
    dw: cover.dw,
    dh: cover.dh,
    domLeft,
    domTop,
    domWidth,
    domHeight,
  };
}
