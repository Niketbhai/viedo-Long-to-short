import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  Film,
  Loader2,
  MonitorPlay,
  Upload,
  X,
} from 'lucide-react';
import {
  ExportFps,
  ExportResolution,
  LayoutConfig,
  ShortClip,
  TimelineSegment,
  VideoRole,
  VideoSource,
} from '../types/editor';
import {
  computeCropAndCover,
  computeZoneBoxes,
  LAYOUT_LABELS,
} from '../utils/layoutGeometry';
import { formatShortDuration, formatTimecode } from '../utils/time';
import {
  detectBestExportFormat,
  ExportResult,
  exportShortVideo,
} from '../utils/videoExporter';
import {
  exportYouTubeViaTabCapture,
  requestTabCaptureStream,
  TabCaptureBlockedError,
} from '../utils/youtubeExporter';
import { SmartVideo } from './SmartVideo';
import { YouTubeEmbedPlayer, YouTubePlayerHandle } from './YouTubeEmbedPlayer';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  gameplay: VideoSource | null;
  facecam: VideoSource | null;
  clips: ShortClip[];
  segments: TimelineSegment[];
  initialClipId: string | null;
  currentInPoint: number;
  currentOutPoint: number;
  currentLayout: LayoutConfig;
  onSaveClipExport: (
    clipId: string,
    url: string,
    mimeType: string,
    ext: string,
    downloadUrl?: string
  ) => void;
  onQuickUpload: (role: VideoRole, file: File) => void;
}

const STAGE_W = 225;
const STAGE_H = 400;

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  gameplay,
  facecam,
  clips,
  segments,
  initialClipId,
  currentInPoint,
  currentOutPoint,
  currentLayout,
  onSaveClipExport,
  onQuickUpload,
}) => {
  const [selectedTarget, setSelectedTarget] = useState<string>('current');
  const [resolution, setResolution] = useState<ExportResolution>('1080p');
  const [fps, setFps] = useState<ExportFps>(30);
  const [preferMp4, setPreferMp4] = useState(true);

  const [isExporting, setIsExporting] = useState(false);
  const [isYouTubeCapturing, setIsYouTubeCapturing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [policyBlocked, setPolicyBlocked] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevOpenRef = useRef(false);

  // Refs for YouTube live 9:16 tab-capture stage
  const ytCaptureStageRef = useRef<HTMLDivElement | null>(null);
  const ytStageGameplayRef = useRef<YouTubePlayerHandle | null>(null);
  const ytStageFacecamRef = useRef<YouTubePlayerHandle | null>(null);
  const vidStageGameplayRef = useRef<HTMLVideoElement | null>(null);
  const vidStageFacecamRef = useRef<HTMLVideoElement | null>(null);

  const formatInfo = useMemo(() => detectBestExportFormat(), []);
  const isEmbeddedIframe = useMemo(() => {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  }, []);

  // Only reset export modal state when opening/closing (never when clips array updates after save!)
  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      setSelectedTarget(initialClipId || (clips.length > 0 ? clips[0].id : 'current'));
      setErrorMsg(null);
      setPolicyBlocked(false);
      setStatusLabel(null);
      setResult(null);
      setProgress(0);
      setElapsedSec(0);
      setIsExporting(false);
      setIsYouTubeCapturing(false);
    } else if (!isOpen && prevOpenRef.current) {
      abortRef.current?.abort();
      setIsExporting(false);
      setIsYouTubeCapturing(false);
    }
    prevOpenRef.current = isOpen;
  }, [isOpen, initialClipId, clips]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  if (!isOpen) return null;

  const selectedClip =
    selectedTarget !== 'current' && !selectedTarget.startsWith('seg:')
      ? clips.find((c) => c.id === selectedTarget) ?? null
      : null;

  const selectedSeg = selectedTarget.startsWith('seg:')
    ? segments.find((s) => `seg:${s.id}` === selectedTarget) ?? null
    : null;

  const targetStart = selectedClip
    ? selectedClip.startTime
    : selectedSeg
      ? selectedSeg.start
      : currentInPoint;
  const targetEnd = selectedClip
    ? selectedClip.endTime
    : selectedSeg
      ? selectedSeg.end
      : currentOutPoint;
  const targetLayout = selectedClip ? selectedClip.layout : currentLayout;
  const targetName = selectedClip
    ? selectedClip.name
    : selectedSeg
      ? selectedSeg.label
      : 'clipforge_short';
  const targetDuration = Math.max(0, targetEnd - targetStart);

  const hasYouTubeSource =
    gameplay?.sourceType === 'youtube' || facecam?.sourceType === 'youtube';

  const stageZones = computeZoneBoxes(
    STAGE_W,
    STAGE_H,
    targetLayout.mode,
    targetLayout.splitRatio
  );
  const stageGpRect =
    stageZones.gameplay && gameplay
      ? computeCropAndCover(
          gameplay.width,
          gameplay.height,
          stageZones.gameplay,
          targetLayout.gameplayTransform
        )
      : null;
  const stageFcRect =
    stageZones.facecam && facecam
      ? computeCropAndCover(
          facecam.width,
          facecam.height,
          stageZones.facecam,
          targetLayout.facecamTransform
        )
      : null;

  const handleStartExport = async () => {
    if (targetDuration < 0.2) {
      setErrorMsg('Clip duration must be at least 0.2 seconds. Adjust Start/End points first.');
      return;
    }

    setErrorMsg(null);
    setPolicyBlocked(false);
    setStatusLabel(null);
    setResult(null);
    setProgress(0);
    setElapsedSec(0);

    const controller = new AbortController();
    abortRef.current = controller;

    if (hasYouTubeSource) {
      // Request Tab Capture synchronously inside click gesture
      let displayStream: MediaStream;
      try {
        displayStream = await requestTabCaptureStream(fps);
      } catch (err) {
        if (err instanceof TabCaptureBlockedError) {
          setPolicyBlocked(err.isPolicyBlocked);
          setErrorMsg(err.message);
        } else {
          setErrorMsg(err instanceof Error ? err.message : 'Tab capture failed.');
        }
        return;
      }

      setIsYouTubeCapturing(true);
      setIsExporting(true);

      // Allow React to mount ytCaptureStageRef on screen before capturing
      await new Promise<void>((r) => window.setTimeout(r, 150));

      const stageEl = ytCaptureStageRef.current;
      if (!stageEl || controller.signal.aborted) {
        displayStream.getTracks().forEach((t) => t.stop());
        setIsExporting(false);
        setIsYouTubeCapturing(false);
        return;
      }

      try {
        const exportResult = await exportYouTubeViaTabCapture({
          displayStream,
          stageEl,
          ytGameplay: ytStageGameplayRef.current,
          ytFacecam: ytStageFacecamRef.current,
          vidGameplay: vidStageGameplayRef.current,
          vidFacecam: vidStageFacecamRef.current,
          startTime: targetStart,
          endTime: targetEnd,
          facecamSyncOffset: targetLayout.facecamSyncOffset,
          resolution,
          fps,
          preferMp4,
          signal: controller.signal,
          onProgress: (p, elapsed, label) => {
            setProgress(p);
            setElapsedSec(elapsed);
            if (label) setStatusLabel(label);
          },
        });

        setResult(exportResult);
        if (selectedClip) {
          onSaveClipExport(
            selectedClip.id,
            exportResult.previewUrl || exportResult.blobUrl,
            exportResult.mimeType,
            exportResult.extension,
            exportResult.downloadUrl
          );
        }
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') {
          setErrorMsg('Export cancelled.');
        } else {
          setErrorMsg(err instanceof Error ? err.message : 'YouTube capture export failed.');
        }
      } finally {
        setIsExporting(false);
        setIsYouTubeCapturing(false);
      }
      return;
    }

    // Standard local file / Kick MP4 / Kick HLS / CORS URL Canvas export
    setIsYouTubeCapturing(false);
    setIsExporting(true);

    try {
      const exportResult = await exportShortVideo({
        gameplay,
        facecam,
        startTime: targetStart,
        endTime: targetEnd,
        layout: targetLayout,
        resolution,
        fps,
        preferMp4,
        signal: controller.signal,
        onProgress: (p, elapsed, label) => {
          setProgress(p);
          setElapsedSec(elapsed);
          if (label) setStatusLabel(label);
        },
        onFramePreview: (srcCanvas) => {
          const destCanvas = previewCanvasRef.current;
          if (!destCanvas) return;
          const ctx = destCanvas.getContext('2d');
          if (!ctx) return;
          ctx.drawImage(srcCanvas, 0, 0, destCanvas.width, destCanvas.height);
        },
      });

      setResult(exportResult);
      if (selectedClip) {
        onSaveClipExport(
          selectedClip.id,
          exportResult.previewUrl || exportResult.blobUrl,
          exportResult.mimeType,
          exportResult.extension,
          exportResult.downloadUrl
        );
      }
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') {
        setErrorMsg('Export cancelled.');
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Export failed.');
      }
    } finally {
      setIsExporting(false);
    }
  };

  const handleCancelExport = () => {
    abortRef.current?.abort();
    setIsExporting(false);
    setIsYouTubeCapturing(false);
  };

  const safeFileName = targetName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const downloadFileName = result
    ? `${safeFileName || 'clipforge_short'}_${resolution}.${result.extension}`
    : 'clipforge_short.mp4';

  const isFacecamActiveInCapture =
    !targetLayout.facecamActiveRange ||
    (elapsedSec + targetStart >= targetLayout.facecamActiveRange.start - 0.05 &&
      elapsedSec + targetStart <= targetLayout.facecamActiveRange.end + 0.05);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-modal-title"
    >
      <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-[#0B0E16] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Film className="w-4 h-4 text-violet-400" />
            <h2 id="export-modal-title" className="font-display text-lg font-semibold text-white">
              Export 9:16 Vertical Short
            </h2>
          </div>
          <button
            type="button"
            onClick={() => {
              if (isExporting) handleCancelExport();
              onClose();
            }}
            aria-label="Close export modal"
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-5 max-h-[82vh] overflow-y-auto">
          {!isExporting && !result && (
            <>
              {/* Clip Selection */}
              <div className="space-y-1.5">
                <label
                  htmlFor="export-clip-select"
                  className="text-xs font-semibold text-slate-200 block"
                >
                  Clip to Render
                </label>
                <select
                  id="export-clip-select"
                  value={selectedTarget}
                  onChange={(e) => setSelectedTarget(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#121622] border border-white/10 text-sm text-white focus:outline-none focus:border-violet-500"
                >
                  <option value="current">
                    Current Timeline Selection ({formatTimecode(currentInPoint)} –{' '}
                    {formatTimecode(currentOutPoint)} ·{' '}
                    {formatShortDuration(Math.max(0, currentOutPoint - currentInPoint))})
                  </option>
                  {clips.map((clip) => (
                    <option key={clip.id} value={clip.id}>
                      Clip: {clip.name} ({formatTimecode(clip.startTime)} –{' '}
                      {formatTimecode(clip.endTime)} ·{' '}
                      {formatShortDuration(clip.endTime - clip.startTime)})
                    </option>
                  ))}
                  {segments.length > 1 &&
                    segments.map((seg) => (
                      <option key={`seg:${seg.id}`} value={`seg:${seg.id}`}>
                        Split Segment: {seg.label} ({formatTimecode(seg.start)} –{' '}
                        {formatTimecode(seg.end)} ·{' '}
                        {formatShortDuration(seg.end - seg.start)})
                      </option>
                    ))}
                </select>
              </div>

              {/* Resolution & FPS */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <span className="text-xs font-semibold text-slate-200 block">
                    Vertical Resolution (9:16)
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setResolution('720p')}
                      className={`p-3 rounded-lg border text-left transition-colors cursor-pointer ${
                        resolution === '720p'
                          ? 'border-violet-500 bg-violet-500/15 text-white'
                          : 'border-white/10 bg-[#111521] text-slate-300 hover:border-white/20'
                      }`}
                    >
                      <div className="text-xs font-semibold">720p HD</div>
                      <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                        720 × 1280
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setResolution('1080p')}
                      className={`p-3 rounded-lg border text-left transition-colors cursor-pointer ${
                        resolution === '1080p'
                          ? 'border-violet-500 bg-violet-500/15 text-white'
                          : 'border-white/10 bg-[#111521] text-slate-300 hover:border-white/20'
                      }`}
                    >
                      <div className="text-xs font-semibold">1080p Full HD</div>
                      <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                        1080 × 1920
                      </div>
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="text-xs font-semibold text-slate-200 block">
                    Frame Rate & Container
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setFps(30)}
                      className={`p-3 rounded-lg border text-left transition-colors cursor-pointer ${
                        fps === 30
                          ? 'border-sky-500 bg-sky-500/15 text-white'
                          : 'border-white/10 bg-[#111521] text-slate-300 hover:border-white/20'
                      }`}
                    >
                      <div className="text-xs font-semibold">30 fps</div>
                      <div className="text-[11px] text-slate-400 mt-0.5">Fast encode</div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setFps(60)}
                      className={`p-3 rounded-lg border text-left transition-colors cursor-pointer ${
                        fps === 60
                          ? 'border-sky-500 bg-sky-500/15 text-white'
                          : 'border-white/10 bg-[#111521] text-slate-300 hover:border-white/20'
                      }`}
                    >
                      <div className="text-xs font-semibold">60 fps</div>
                      <div className="text-[11px] text-slate-400 mt-0.5">Smooth motion</div>
                    </button>
                  </div>
                </div>
              </div>

              {/* Format & Composition Summary */}
              <div className="rounded-xl border border-white/[0.08] bg-[#111521] p-4 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Output Format</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPreferMp4((v) => !v)}
                      className="text-sky-300 font-medium hover:underline cursor-pointer"
                    >
                      {preferMp4 ? 'MP4 (H.264 / AAC)' : formatInfo.label}
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Split Layout</span>
                  <span className="text-slate-200">{LAYOUT_LABELS[targetLayout.mode]}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Clip Duration</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {formatShortDuration(targetDuration)}
                  </span>
                </div>
              </div>

              {hasYouTubeSource && (
                <div
                  className={`rounded-xl border p-4 space-y-3 text-xs ${
                    isEmbeddedIframe
                      ? 'border-amber-500/35 bg-amber-500/10 text-amber-100'
                      : 'border-sky-500/30 bg-sky-500/10 text-sky-100'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <MonitorPlay
                      className={`w-4 h-4 shrink-0 mt-0.5 ${
                        isEmbeddedIframe ? 'text-amber-400' : 'text-sky-400'
                      }`}
                    />
                    <div>
                      <p className="font-semibold text-white">
                        {isEmbeddedIframe
                          ? 'YouTube Export Needs Full Tab or Local File'
                          : 'YouTube Direct Tab-Capture Export Ready'}
                      </p>
                      <p className="opacity-85 mt-1 leading-relaxed">
                        {isEmbeddedIframe ? (
                          <>
                            This embedded preview blocks browser tab capture for YouTube iframes. Open ClipForge in a full browser tab to render & download YouTube Shorts directly, or swap in a local MP4/WebM file below (keeping all your cuts and facecam crop).
                          </>
                        ) : (
                          <>
                            Click <strong>Start Render & Export</strong> and select <strong>"This Tab"</strong> (with tab audio checked) when your browser prompts. ClipForge will capture your 9:16 split-screen + facecam crop directly into MP4.
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pl-6">
                    {isEmbeddedIframe && typeof window !== 'undefined' && (
                      <a
                        href={window.location.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-semibold inline-flex items-center gap-1.5 transition-colors"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span>Open Studio in Full Tab</span>
                      </a>
                    )}
                    {gameplay?.sourceType === 'youtube' && (
                      <label className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-slate-200 font-medium inline-flex items-center gap-1.5 cursor-pointer transition-colors">
                        <Upload className="w-3.5 h-3.5" />
                        <span>Upload Local Gameplay File</span>
                        <input
                          type="file"
                          accept="video/*"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) onQuickUpload('gameplay', f);
                            e.target.value = '';
                          }}
                        />
                      </label>
                    )}
                    {facecam?.sourceType === 'youtube' && facecam.derivedFromRole !== 'gameplay' && (
                      <label className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-slate-200 font-medium inline-flex items-center gap-1.5 cursor-pointer transition-colors">
                        <Upload className="w-3.5 h-3.5" />
                        <span>Upload Local Facecam File</span>
                        <input
                          type="file"
                          accept="video/*"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) onQuickUpload('facecam', f);
                            e.target.value = '';
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Rendering Progress State */}
          {isExporting && (
            <div className="flex flex-col sm:flex-row items-center gap-6 py-2">
              {isYouTubeCapturing ? (
                <div
                  ref={ytCaptureStageRef}
                  style={{ width: STAGE_W, height: STAGE_H }}
                  className="relative rounded-xl overflow-hidden border border-white/15 bg-[#05060A] shrink-0"
                >
                  {stageZones.gameplay && gameplay && stageGpRect && (
                    <div
                      style={{
                        left: stageZones.gameplay.x,
                        top: stageZones.gameplay.y,
                        width: stageZones.gameplay.width,
                        height: stageZones.gameplay.height,
                      }}
                      className="absolute overflow-hidden"
                    >
                      {gameplay.sourceType === 'youtube' && gameplay.youtubeId ? (
                        <YouTubeEmbedPlayer
                          ref={ytStageGameplayRef}
                          videoId={gameplay.youtubeId}
                          muted={targetLayout.gameplayMuted}
                          volume={targetLayout.gameplayVolume}
                          style={{
                            position: 'absolute',
                            left: stageGpRect.domLeft,
                            top: stageGpRect.domTop,
                            width: stageGpRect.domWidth,
                            height: stageGpRect.domHeight,
                            maxWidth: 'none',
                          }}
                        />
                      ) : (
                        <SmartVideo
                          ref={vidStageGameplayRef}
                          src={gameplay.url}
                          isHls={gameplay.isHls}
                          muted={targetLayout.gameplayMuted}
                          playsInline
                          preload="auto"
                          style={{
                            position: 'absolute',
                            left: stageGpRect.domLeft,
                            top: stageGpRect.domTop,
                            width: stageGpRect.domWidth,
                            height: stageGpRect.domHeight,
                            maxWidth: 'none',
                          }}
                        />
                      )}
                    </div>
                  )}

                  {stageZones.facecam && facecam && stageFcRect && (
                    <div
                      style={{
                        left: stageZones.facecam.x,
                        top: stageZones.facecam.y,
                        width: stageZones.facecam.width,
                        height: stageZones.facecam.height,
                        opacity: isFacecamActiveInCapture ? 1 : 0,
                      }}
                      className="absolute overflow-hidden"
                    >
                      {facecam.sourceType === 'youtube' && facecam.youtubeId ? (
                        <YouTubeEmbedPlayer
                          ref={ytStageFacecamRef}
                          videoId={facecam.youtubeId}
                          muted={targetLayout.facecamMuted}
                          volume={targetLayout.facecamVolume}
                          style={{
                            position: 'absolute',
                            left: stageFcRect.domLeft,
                            top: stageFcRect.domTop,
                            width: stageFcRect.domWidth,
                            height: stageFcRect.domHeight,
                            maxWidth: 'none',
                          }}
                        />
                      ) : (
                        <SmartVideo
                          ref={vidStageFacecamRef}
                          src={facecam.url}
                          isHls={facecam.isHls}
                          muted={targetLayout.facecamMuted}
                          playsInline
                          preload="auto"
                          style={{
                            position: 'absolute',
                            left: stageFcRect.domLeft,
                            top: stageFcRect.domTop,
                            width: stageFcRect.domWidth,
                            height: stageFcRect.domHeight,
                            maxWidth: 'none',
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="w-32 aspect-[9/16] rounded-xl overflow-hidden border border-white/15 bg-black shrink-0">
                  <canvas
                    ref={previewCanvasRef}
                    width={180}
                    height={320}
                    className="w-full h-full object-cover"
                  />
                </div>
              )}

              <div className="flex-1 w-full space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Loader2 className="w-4 h-4 animate-spin text-violet-400" />
                  <span>
                    {statusLabel || `Rendering Vertical Short (${resolution} · ${fps}fps)...`}
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  {isYouTubeCapturing
                    ? 'Capturing live 9:16 split-screen frames and audio from your YouTube tab. Keep this modal visible until finished.'
                    : 'Compositing synchronized Gameplay + Facecam frames and mixing audio tracks locally. Keep this tab active until finished.'}
                </p>

                <div className="space-y-1.5">
                  <div className="h-2.5 w-full rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-sky-400 to-violet-500 transition-all duration-150"
                      style={{ width: `${Math.round(progress * 100)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs font-mono tabular-nums text-slate-400">
                    <span>{Math.round(progress * 100)}% complete</span>
                    <span>
                      {elapsedSec.toFixed(1)}s / {targetDuration.toFixed(1)}s
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Completed Preview & Download State */}
          {result && (
            <div className="flex flex-col sm:flex-row items-center gap-6 py-2">
              <div className="w-36 aspect-[9/16] rounded-xl overflow-hidden border border-white/15 bg-black shrink-0">
                <video
                  src={result.previewUrl || result.blobUrl}
                  controls
                  playsInline
                  className="w-full h-full object-contain"
                />
              </div>

              <div className="flex-1 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Render Complete</span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Your {result.width}×{result.height} vertical Short is ready ({result.extension.toUpperCase()} ·{' '}
                  {((result.size || result.blob.size) / (1024 * 1024)).toFixed(2)} MB).
                </p>

                <div className="flex flex-wrap items-center gap-2.5 pt-1">
                  <a
                    href={
                      result.downloadUrl
                        ? `${result.downloadUrl}?name=${encodeURIComponent(downloadFileName)}`
                        : result.blobUrl
                    }
                    download={downloadFileName}
                    className="px-5 py-2.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white inline-flex items-center gap-2 transition-colors cursor-pointer"
                  >
                    <Download className="w-4 h-4" />
                    <span>Download {result.extension.toUpperCase()}</span>
                  </a>

                  <button
                    type="button"
                    onClick={() => setResult(null)}
                    className="px-4 py-2.5 rounded-lg text-xs font-medium bg-white/[0.06] hover:bg-white/[0.12] text-slate-200 transition-colors cursor-pointer"
                  >
                    Export Another Clip
                  </button>
                </div>
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 space-y-2.5 text-xs text-red-200">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
              {policyBlocked && typeof window !== 'undefined' && (
                <div className="pl-6">
                  <a
                    href={window.location.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-semibold transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Open Studio in Full Tab</span>
                  </a>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-white/[0.08] flex items-center justify-end gap-3 bg-[#090B12]">
          {isExporting ? (
            <button
              type="button"
              onClick={handleCancelExport}
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-red-500/20 hover:bg-red-500/30 text-red-200 transition-colors cursor-pointer"
            >
              Cancel Render
            </button>
          ) : !result ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-white/[0.06] hover:bg-white/[0.12] text-slate-300 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleStartExport}
                disabled={!gameplay && !facecam}
                className="px-5 py-2 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white inline-flex items-center gap-2 transition-colors cursor-pointer disabled:cursor-not-allowed"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Start Render & Export</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-medium bg-white/[0.08] hover:bg-white/[0.14] text-white transition-colors cursor-pointer"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
