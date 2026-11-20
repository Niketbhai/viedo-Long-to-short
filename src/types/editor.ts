export type VideoRole = 'gameplay' | 'facecam';

export interface VideoSource {
  id: string;
  role: VideoRole;
  name: string;
  url: string;
  sourceType: 'file' | 'url' | 'demo' | 'youtube' | 'kick';
  youtubeId?: string;
  isHls?: boolean;
  duration: number;
  width: number;
  height: number;
  fileSize?: number;
  corsSafe: boolean;
  derivedFromRole?: VideoRole;
}

export type SplitLayoutMode =
  | 'gameplay-top'
  | 'facecam-top'
  | 'side-by-side'
  | 'full-gameplay'
  | 'full-facecam';

export interface CropRect {
  x: number; // 0 to 1 normalized left
  y: number; // 0 to 1 normalized top
  width: number; // 0.05 to 1 normalized width
  height: number; // 0.05 to 1 normalized height
}

export interface VideoTransform {
  zoom: number; // 1.0 to 3.5
  panX: number; // -1.0 to 1.0 (normalized offset inside overflow crop)
  panY: number; // -1.0 to 1.0
  crop?: CropRect; // Optional manual source region crop
}

export interface ActiveTimeRange {
  start: number;
  end: number;
}

export interface LayoutConfig {
  mode: SplitLayoutMode;
  splitRatio: number; // 0.15 to 0.85 (primary zone fraction)
  gameplayTransform: VideoTransform;
  facecamTransform: VideoTransform;
  gameplayVolume: number; // 0 to 1
  facecamVolume: number; // 0 to 1
  gameplayMuted: boolean;
  facecamMuted: boolean;
  facecamSyncOffset: number; // seconds (-10 to +10)
  facecamActiveRange?: ActiveTimeRange | null; // Optional active time window for facecam
}

export interface TimelineSegment {
  id: string;
  start: number;
  end: number;
  label: string;
}

export interface ShortClip {
  id: string;
  name: string;
  startTime: number;
  endTime: number;
  layout: LayoutConfig;
  createdAt: number;
  exportedUrl?: string;
  exportedMimeType?: string;
  exportedExt?: string;
}

export interface EditorSnapshot {
  inPoint: number;
  outPoint: number;
  segments: TimelineSegment[];
  clips: ShortClip[];
  layout: LayoutConfig;
  activeClipId: string | null;
  selectedSegmentId: string | null;
}

export type ExportResolution = '720p' | '1080p';
export type ExportFps = 30 | 60;
