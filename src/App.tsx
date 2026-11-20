import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExportModal } from './components/ExportModal';
import { FacecamCropModal } from './components/FacecamCropModal';
import { ActiveView, Header } from './components/Header';
import { ImportModal } from './components/ImportModal';
import { MediaAndClipsSidebar } from './components/MediaAndClipsSidebar';
import { ShortcutsModal } from './components/ShortcutsModal';
import { ShortsPreview9x16 } from './components/ShortsPreview9x16';
import { ShortsQueueView } from './components/ShortsQueueView';
import { SourcePlayer } from './components/SourcePlayer';
import { TimelineEditor } from './components/TimelineEditor';
import { YouTubePlayerHandle } from './components/YouTubeEmbedPlayer';
import {
  ActiveTimeRange,
  CropRect,
  EditorSnapshot,
  LayoutConfig,
  ShortClip,
  TimelineSegment,
  VideoRole,
  VideoSource,
} from './types/editor';
import { generateLocalDemoPair } from './utils/demoGenerator';
import { DEFAULT_LAYOUT, hasActiveCrop } from './utils/layoutGeometry';
import { clamp, DEFAULT_FPS, formatShortDuration, formatTimecode, generateId } from './utils/time';

const INITIAL_SNAPSHOT: EditorSnapshot = {
  inPoint: 0,
  outPoint: 0,
  segments: [],
  clips: [],
  layout: DEFAULT_LAYOUT,
  activeClipId: null,
  selectedSegmentId: null,
};

export default function App() {
  const [activeView, setActiveView] = useState<ActiveView>('studio');
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isFacecamCropOpen, setIsFacecamCropOpen] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [exportInitialClipId, setExportInitialClipId] = useState<string | null>(null);

  const [gameplay, setGameplay] = useState<VideoSource | null>(null);
  const [facecam, setFacecam] = useState<VideoSource | null>(null);
  const [monitorRole, setMonitorRole] = useState<VideoRole>('gameplay');
  const [isGeneratingDemo, setIsGeneratingDemo] = useState(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [previewingClipId, setPreviewingClipId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Undo / Redo History State
  const [present, setPresent] = useState<EditorSnapshot>(INITIAL_SNAPSHOT);
  const [past, setPast] = useState<EditorSnapshot[]>([]);
  const [future, setFuture] = useState<EditorSnapshot[]>([]);

  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewGameplayRef = useRef<HTMLVideoElement | null>(null);
  const previewFacecamRef = useRef<HTMLVideoElement | null>(null);
  const ytSourceRef = useRef<YouTubePlayerHandle | null>(null);
  const ytGameplayRef = useRef<YouTubePlayerHandle | null>(null);
  const ytFacecamRef = useRef<YouTubePlayerHandle | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const layoutHistoryTimerRef = useRef<number | null>(null);
  const lastSavedLayoutSnapshotRef = useRef<EditorSnapshot | null>(null);

  const masterDuration = Math.max(gameplay?.duration || 0, facecam?.duration || 0);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
    }, 2800);
  }, []);

  const commitSnapshot = useCallback(
    (updater: (prev: EditorSnapshot) => EditorSnapshot) => {
      setPresent((prev) => {
        const next = updater(prev);
        if (next === prev) return prev;
        setPast((p) => [...p.slice(-49), prev]);
        setFuture([]);
        return next;
      });
    },
    []
  );

  const handleUndo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const previous = p[p.length - 1];
      setFuture((f) => [present, ...f]);
      setPresent(previous);
      return p.slice(0, -1);
    });
  }, [present]);

  const handleRedo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setPast((p) => [...p, present]);
      setPresent(next);
      return f.slice(1);
    });
  }, [present]);

  // Keep audio volumes and mute states synchronized on preview video elements
  useEffect(() => {
    const gpEl = previewGameplayRef.current;
    if (gpEl) {
      gpEl.muted = present.layout.gameplayMuted;
      gpEl.volume = clamp(present.layout.gameplayVolume, 0, 1);
    }
    const fcEl = previewFacecamRef.current;
    if (fcEl) {
      fcEl.muted = present.layout.facecamMuted;
      fcEl.volume = clamp(present.layout.facecamVolume, 0, 1);
    }
  }, [present.layout, gameplay, facecam]);

  // Seek all active video elements / YouTube players cleanly
  const seekAllVideos = useCallback(
    (targetTime: number) => {
      const clamped = clamp(targetTime, 0, masterDuration || 0);
      setCurrentTime(clamped);

      if (gameplay) {
        const gpTarget = clamp(clamped, 0, Math.max(0, (gameplay.duration || masterDuration) - 0.02));
        if (gameplay.sourceType === 'youtube') {
          if (Math.abs((ytGameplayRef.current?.getCurrentTime() || 0) - gpTarget) > 0.08) {
            ytGameplayRef.current?.seekTo(gpTarget);
          }
        } else {
          const gpEl = previewGameplayRef.current;
          if (gpEl && Math.abs(gpEl.currentTime - gpTarget) > 0.02) {
            gpEl.currentTime = gpTarget;
          }
        }
      }

      if (facecam) {
        const fcTarget = clamp(
          clamped + present.layout.facecamSyncOffset,
          0,
          Math.max(0, (facecam.duration || masterDuration) - 0.02)
        );
        if (facecam.sourceType === 'youtube') {
          if (Math.abs((ytFacecamRef.current?.getCurrentTime() || 0) - fcTarget) > 0.08) {
            ytFacecamRef.current?.seekTo(fcTarget);
          }
        } else {
          const fcEl = previewFacecamRef.current;
          if (fcEl && Math.abs(fcEl.currentTime - fcTarget) > 0.02) {
            fcEl.currentTime = fcTarget;
          }
        }
      }

      const srcSource = monitorRole === 'facecam' && facecam ? facecam : gameplay || facecam;
      if (srcSource) {
        const offset = monitorRole === 'facecam' && facecam ? present.layout.facecamSyncOffset : 0;
        const srcTarget = clamp(clamped + offset, 0, Math.max(0, (srcSource.duration || masterDuration) - 0.02));
        if (srcSource.sourceType === 'youtube') {
          if (Math.abs((ytSourceRef.current?.getCurrentTime() || 0) - srcTarget) > 0.08) {
            ytSourceRef.current?.seekTo(srcTarget);
          }
        } else {
          const srcEl = sourceVideoRef.current;
          if (srcEl && Math.abs(srcEl.currentTime - srcTarget) > 0.02) {
            srcEl.currentTime = srcTarget;
          }
        }
      }
    },
    [masterDuration, gameplay, facecam, monitorRole, present.layout.facecamSyncOffset]
  );

  // Sync Play/Pause across all video elements and YouTube embeds
  const setPlaybackState = useCallback(
    async (play: boolean) => {
      if (!gameplay && !facecam) return;
      setIsPlaying(play);

      const gpEl = previewGameplayRef.current;
      const fcEl = previewFacecamRef.current;
      const srcEl = sourceVideoRef.current;
      const srcSource = monitorRole === 'facecam' && facecam ? facecam : gameplay || facecam;

      if (play) {
        const promises: Promise<void>[] = [];
        if (gameplay) {
          if (gameplay.sourceType === 'youtube') {
            ytGameplayRef.current?.play();
          } else if (gpEl) {
            promises.push(gpEl.play().catch(() => undefined));
          }
        }
        if (facecam) {
          const fcTarget = currentTime + present.layout.facecamSyncOffset;
          const fcDur = facecam.duration || masterDuration || 99999;
          if (fcTarget >= 0 && fcTarget < fcDur) {
            if (facecam.sourceType === 'youtube') {
              ytFacecamRef.current?.seekTo(fcTarget);
              ytFacecamRef.current?.play();
            } else if (fcEl) {
              fcEl.currentTime = fcTarget;
              promises.push(fcEl.play().catch(() => undefined));
            }
          }
        }
        if (srcSource) {
          if (srcSource.sourceType === 'youtube') {
            ytSourceRef.current?.play();
          } else if (srcEl) {
            promises.push(srcEl.play().catch(() => undefined));
          }
        }
        await Promise.all(promises);
      } else {
        gpEl?.pause();
        fcEl?.pause();
        srcEl?.pause();
        ytGameplayRef.current?.pause();
        ytFacecamRef.current?.pause();
        ytSourceRef.current?.pause();
      }
    },
    [gameplay, facecam, monitorRole, currentTime, masterDuration, present.layout.facecamSyncOffset]
  );

  const handleTogglePlay = useCallback(() => {
    if (!gameplay && !facecam) return;
    if (isPlaying) {
      setPlaybackState(false);
    } else {
      if (masterDuration > 0 && currentTime >= masterDuration - 0.05) {
        seekAllVideos(0);
      }
      setPlaybackState(true);
    }
  }, [gameplay, facecam, isPlaying, currentTime, masterDuration, seekAllVideos, setPlaybackState]);

  // Continuous playback synchronization loop
  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;

    const previewingClip = previewingClipId
      ? present.clips.find((c) => c.id === previewingClipId) ?? null
      : null;

    const tick = () => {
      const gpEl = previewGameplayRef.current;
      const fcEl = previewFacecamRef.current;
      const srcEl = sourceVideoRef.current;

      const masterIsGameplay = Boolean(gameplay);
      const masterIsYouTube = masterIsGameplay
        ? gameplay?.sourceType === 'youtube'
        : facecam?.sourceType === 'youtube';

      let t = currentTime;
      let ended = false;

      if (masterIsYouTube) {
        const ytMaster = masterIsGameplay ? ytGameplayRef.current : ytFacecamRef.current;
        if (!ytMaster) {
          setIsPlaying(false);
          return;
        }
        t = masterIsGameplay
          ? ytMaster.getCurrentTime()
          : ytMaster.getCurrentTime() - present.layout.facecamSyncOffset;
      } else {
        const masterEl = masterIsGameplay ? gpEl : fcEl;
        if (!masterEl) {
          setIsPlaying(false);
          return;
        }
        t = masterIsGameplay
          ? masterEl.currentTime
          : masterEl.currentTime - present.layout.facecamSyncOffset;
        ended = masterEl.ended;
      }

      setCurrentTime(t);

      // Loop inside clip if previewing a Short clip
      if (previewingClip && t >= previewingClip.endTime - 0.04) {
        seekAllVideos(previewingClip.startTime);
      } else if ((masterDuration > 0 && t >= masterDuration - 0.04) || ended) {
        setPlaybackState(false);
        return;
      }

      // Keep facecam synced to gameplay
      if (gameplay && facecam) {
        const expectedFc = t + present.layout.facecamSyncOffset;
        const fcDur = facecam.duration || masterDuration || 99999;
        if (facecam.sourceType === 'youtube') {
          const ytFc = ytFacecamRef.current;
          if (ytFc) {
            if (expectedFc >= 0 && expectedFc < fcDur - 0.05) {
              if (ytFc.isPaused()) {
                ytFc.seekTo(expectedFc);
                ytFc.play();
              } else if (Math.abs(ytFc.getCurrentTime() - expectedFc) > 0.35) {
                ytFc.seekTo(expectedFc);
              }
            } else if (!ytFc.isPaused()) {
              ytFc.pause();
            }
          }
        } else if (fcEl) {
          if (expectedFc >= 0 && expectedFc < fcDur - 0.05) {
            if (fcEl.paused) {
              fcEl.currentTime = expectedFc;
              fcEl.play().catch(() => undefined);
            } else if (Math.abs(fcEl.currentTime - expectedFc) > 0.1) {
              fcEl.currentTime = expectedFc;
            }
          } else if (!fcEl.paused) {
            fcEl.pause();
          }
        }
      }

      // Keep source monitor synced
      const srcSource = monitorRole === 'facecam' && facecam ? facecam : gameplay || facecam;
      if (srcSource) {
        const srcOffset = monitorRole === 'facecam' && facecam ? present.layout.facecamSyncOffset : 0;
        const srcDur = srcSource.duration || masterDuration || 99999;
        const expectedSrc = clamp(t + srcOffset, 0, Math.max(0, srcDur - 0.02));
        if (srcSource.sourceType === 'youtube') {
          const ytSrc = ytSourceRef.current;
          if (ytSrc && Math.abs(ytSrc.getCurrentTime() - expectedSrc) > 0.35) {
            ytSrc.seekTo(expectedSrc);
          }
        } else if (srcEl && Math.abs(srcEl.currentTime - expectedSrc) > 0.12) {
          srcEl.currentTime = expectedSrc;
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [
    isPlaying,
    gameplay,
    facecam,
    currentTime,
    masterDuration,
    monitorRole,
    previewingClipId,
    present.clips,
    present.layout.facecamSyncOffset,
    seekAllVideos,
    setPlaybackState,
  ]);

  // Update video duration, dimensions & title once player/HLS/YouTube reports metadata
  const handleSourceMetadata = useCallback(
    (
      role: VideoRole,
      dur: number,
      width?: number,
      height?: number,
      title?: string
    ) => {
      if (!Number.isFinite(dur) || dur <= 0) return;
      if (role === 'gameplay') {
        setGameplay((prev) =>
          prev
            ? {
                ...prev,
                duration: dur,
                width: width || prev.width,
                height: height || prev.height,
                name: title && title.trim() ? title : prev.name,
              }
            : prev
        );
        setFacecam((prev) =>
          prev && prev.derivedFromRole === 'gameplay'
            ? {
                ...prev,
                duration: dur,
                width: width || prev.width,
                height: height || prev.height,
                name: title && title.trim() ? `${title} (Facecam Crop)` : prev.name,
              }
            : prev
        );
      } else {
        setFacecam((prev) =>
          prev
            ? {
                ...prev,
                duration: dur,
                width: width || prev.width,
                height: height || prev.height,
                name: title && title.trim() ? title : prev.name,
              }
            : prev
        );
      }

      setPresent((prev) => {
        const nextMax = Math.max(
          dur,
          role === 'gameplay' ? facecam?.duration || 0 : gameplay?.duration || 0
        );
        const hasZeroOut = prev.outPoint <= 0.1;
        return {
          ...prev,
          outPoint: hasZeroOut ? Math.min(nextMax, 15) : Math.min(prev.outPoint, nextMax),
          segments:
            prev.segments.length === 0
              ? [{ id: generateId('seg'), start: 0, end: nextMax, label: 'Main Recording' }]
              : prev.segments.map((s, idx) =>
                  idx === prev.segments.length - 1 && (s.end === 0 || s.end < nextMax)
                    ? { ...s, end: nextMax }
                    : s
                ),
        };
      });
    },
    [gameplay?.duration, facecam?.duration]
  );

  // Handle importing or replacing a video source cleanly
  const handleSetSource = useCallback(
    (role: VideoRole, source: VideoSource) => {
      setIsPlaying(false);
      setPreviewingClipId(null);

      const oldUrl = role === 'gameplay' ? gameplay?.url : facecam?.url;
      const otherUrl = role === 'gameplay' ? facecam?.url : gameplay?.url;
      const isSharedWithOther =
        Boolean(oldUrl && otherUrl && oldUrl === otherUrl) &&
        !(role === 'gameplay' && facecam?.derivedFromRole === 'gameplay');

      if (oldUrl && oldUrl.startsWith('blob:') && oldUrl !== source.url && !isSharedWithOther) {
        // Delay revocation until React finishes unmounting the previous <video> element
        window.setTimeout(() => {
          try {
            URL.revokeObjectURL(oldUrl);
          } catch {
            // ignore
          }
        }, 1500);
      }

      const isFirstOrPrimaryReplace =
        role === 'gameplay' || (role === 'facecam' && !gameplay);

      if (role === 'gameplay') {
        setGameplay(source);
        setMonitorRole('gameplay');
        // If facecam was cropped from the previous gameplay video, follow the new gameplay source
        if (facecam?.derivedFromRole === 'gameplay') {
          setFacecam({
            ...source,
            id: generateId('src'),
            role: 'facecam',
            name: `${source.name} (Facecam Crop)`,
            derivedFromRole: 'gameplay',
          });
        }
      } else {
        setFacecam(source);
        if (!gameplay) {
          setMonitorRole('facecam');
        }
      }

      const nextDuration = Math.max(
        source.duration,
        role === 'gameplay' ? facecam?.duration || 0 : gameplay?.duration || 0
      );

      if (isFirstOrPrimaryReplace) {
        const segId = generateId('seg');
        const defaultOut = nextDuration > 0 ? Math.min(nextDuration, 15) : 0;
        setPresent((prev) => ({
          ...prev,
          inPoint: 0,
          outPoint: defaultOut,
          segments: [
            {
              id: segId,
              start: 0,
              end: nextDuration,
              label: source.name || 'Main Recording',
            },
          ],
          selectedSegmentId: segId,
          activeClipId: null,
        }));
        setCurrentTime(0);
      } else {
        setPresent((prev) => ({
          ...prev,
          outPoint:
            prev.outPoint <= 0.1 && nextDuration > 0
              ? Math.min(nextDuration, 15)
              : prev.outPoint,
          segments:
            prev.segments.length === 0
              ? [
                  {
                    id: generateId('seg'),
                    start: 0,
                    end: nextDuration,
                    label: source.name || 'Main Recording',
                  },
                ]
              : prev.segments.map((s, idx) =>
                  idx === prev.segments.length - 1 && s.end < nextDuration
                    ? { ...s, end: nextDuration }
                    : s
                ),
        }));
      }
    },
    [gameplay, facecam]
  );

  const handleQuickUpload = useCallback(
    (role: VideoRole, file: File) => {
      const objectUrl = URL.createObjectURL(file);
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.src = objectUrl;
      probe.onloadedmetadata = () => {
        handleSetSource(role, {
          id: generateId('src'),
          role,
          name: file.name,
          url: objectUrl,
          sourceType: 'file',
          duration: Number.isFinite(probe.duration) ? probe.duration : 0,
          width: probe.videoWidth || 1920,
          height: probe.videoHeight || 1080,
          fileSize: file.size,
          corsSafe: true,
        });
        showToast(`Loaded ${role}: ${file.name}`);
      };
      probe.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        showToast('Could not read video file. Please select an MP4, WebM, or MOV.');
      };
    },
    [handleSetSource, showToast]
  );

  const handleRemoveSource = useCallback(
    (role: VideoRole) => {
      setIsPlaying(false);
      if (role === 'gameplay') {
        const shared = gameplay?.url && facecam?.url === gameplay.url;
        if (gameplay?.url.startsWith('blob:') && !shared) URL.revokeObjectURL(gameplay.url);
        setGameplay(null);
        if (facecam) setMonitorRole('facecam');
      } else {
        const shared = facecam?.url && gameplay?.url === facecam.url;
        if (facecam?.url.startsWith('blob:') && !shared) URL.revokeObjectURL(facecam.url);
        setFacecam(null);
        if (gameplay) setMonitorRole('gameplay');
      }
    },
    [gameplay, facecam]
  );

  const handleOpenFacecamCrop = useCallback(() => {
    setPlaybackState(false);
    setIsFacecamCropOpen(true);
  }, [setPlaybackState]);

  const handleApplyFacecamCrop = useCallback(
    ({
      sourceMode,
      crop,
      activeRange,
    }: {
      sourceMode: 'gameplay' | 'facecam';
      crop: CropRect;
      activeRange: ActiveTimeRange | null;
    }) => {
      if (sourceMode === 'gameplay' && gameplay) {
        setFacecam({
          ...gameplay,
          id: generateId('src'),
          role: 'facecam',
          name: `${gameplay.name} (Facecam Crop)`,
          derivedFromRole: 'gameplay',
        });
      }

      commitSnapshot((prev) => ({
        ...prev,
        layout: {
          ...prev.layout,
          mode: prev.layout.mode === 'full-gameplay' ? 'gameplay-top' : prev.layout.mode,
          facecamTransform: {
            zoom: 1,
            panX: 0,
            panY: 0,
            crop,
          },
          facecamMuted: sourceMode === 'gameplay' ? true : prev.layout.facecamMuted,
          facecamSyncOffset: sourceMode === 'gameplay' ? 0 : prev.layout.facecamSyncOffset,
          facecamActiveRange: activeRange,
        },
      }));
      showToast('Facecam crop applied to 9:16 split preview.');
    },
    [gameplay, commitSnapshot, showToast]
  );

  const handleLoadDemo = useCallback(async () => {
    setIsGeneratingDemo(true);
    try {
      const demo = await generateLocalDemoPair();
      setIsPlaying(false);
      setPreviewingClipId(null);
      setGameplay(demo.gameplay);
      setFacecam(demo.facecam);
      setMonitorRole('gameplay');
      const segId = generateId('seg');
      setPresent({
        inPoint: 3.5,
        outPoint: 10.5,
        segments: [{ id: segId, start: 0, end: demo.gameplay.duration, label: 'Arena Recording' }],
        clips: [],
        layout: DEFAULT_LAYOUT,
        activeClipId: null,
        selectedSegmentId: segId,
      });
      setPast([]);
      setFuture([]);
      setCurrentTime(3.5);
      showToast('Sample Gameplay & Facecam loaded locally.');
    } catch {
      showToast('Unable to generate demo footage in this browser.');
    } finally {
      setIsGeneratingDemo(false);
    }
  }, [showToast]);

  // Editing actions
  const handleSetInPoint = useCallback(() => {
    if (masterDuration <= 0) return;
    commitSnapshot((prev) => {
      const nextIn = clamp(Number(currentTime.toFixed(2)), 0, Math.max(0, masterDuration - 0.2));
      const nextOut =
        prev.outPoint <= nextIn + 0.2
          ? Math.min(masterDuration, Number((nextIn + 10).toFixed(2)))
          : prev.outPoint;
      return { ...prev, inPoint: nextIn, outPoint: nextOut };
    });
    showToast(`Start point set to ${formatTimecode(currentTime)}`);
  }, [masterDuration, currentTime, commitSnapshot, showToast]);

  const handleSetOutPoint = useCallback(() => {
    if (masterDuration <= 0) return;
    commitSnapshot((prev) => {
      const nextOut = clamp(Number(currentTime.toFixed(2)), 0.2, masterDuration);
      const nextIn =
        prev.inPoint >= nextOut - 0.2
          ? Math.max(0, Number((nextOut - 10).toFixed(2)))
          : prev.inPoint;
      return { ...prev, inPoint: nextIn, outPoint: nextOut };
    });
    showToast(`End point set to ${formatTimecode(currentTime)}`);
  }, [masterDuration, currentTime, commitSnapshot, showToast]);

  const handleApplyDuration = useCallback(
    (seconds: number) => {
      if (masterDuration <= 0) return;
      const startFrom = clamp(
        Number((currentTime > 0 ? currentTime : present.inPoint).toFixed(2)),
        0,
        Math.max(0, masterDuration - 0.5)
      );
      const nextOut = clamp(
        Number((startFrom + seconds).toFixed(2)),
        startFrom + 0.5,
        masterDuration
      );
      commitSnapshot((prev) => ({
        ...prev,
        inPoint: startFrom,
        outPoint: nextOut,
      }));
      showToast(
        `Clip window set: ${formatTimecode(startFrom)} – ${formatTimecode(nextOut)} (${formatShortDuration(nextOut - startFrom)})`
      );
    },
    [masterDuration, currentTime, present.inPoint, commitSnapshot, showToast]
  );

  const handleCutClip = useCallback(() => {
    if (present.outPoint <= present.inPoint + 0.1) return;
    const clipNumber = present.clips.length + 1;
    const newClip: ShortClip = {
      id: generateId('clip'),
      name: `Short Clip ${clipNumber}`,
      startTime: present.inPoint,
      endTime: present.outPoint,
      layout: JSON.parse(JSON.stringify(present.layout)) as LayoutConfig,
      createdAt: Date.now(),
    };
    commitSnapshot((prev) => ({
      ...prev,
      clips: [...prev.clips, newClip],
      activeClipId: newClip.id,
    }));
    showToast(
      `Created "${newClip.name}" (${formatShortDuration(newClip.endTime - newClip.startTime)})`
    );
  }, [present.inPoint, present.outPoint, present.clips.length, present.layout, commitSnapshot, showToast]);

  const handleSplitSegment = useCallback(() => {
    const t = Number(currentTime.toFixed(2));
    const targetSeg = present.segments.find((s) => t > s.start + 0.2 && t < s.end - 0.2);
    if (!targetSeg) {
      showToast('Move playhead inside a segment to split.');
      return;
    }

    const leftSeg: TimelineSegment = {
      id: generateId('seg'),
      start: targetSeg.start,
      end: t,
      label: `${targetSeg.label} A`,
    };
    const rightSeg: TimelineSegment = {
      id: generateId('seg'),
      start: t,
      end: targetSeg.end,
      label: `${targetSeg.label} B`,
    };

    commitSnapshot((prev) => {
      const idx = prev.segments.findIndex((s) => s.id === targetSeg.id);
      if (idx === -1) return prev;
      const nextSegments = [
        ...prev.segments.slice(0, idx),
        leftSeg,
        rightSeg,
        ...prev.segments.slice(idx + 1),
      ];
      return {
        ...prev,
        segments: nextSegments,
        selectedSegmentId: rightSeg.id,
      };
    });
    showToast(`Split segment at ${formatTimecode(t)}`);
  }, [currentTime, present.segments, commitSnapshot, showToast]);

  const handleDeleteSegment = useCallback(() => {
    if (!present.selectedSegmentId || present.segments.length <= 1) {
      showToast('Keep at least one segment or split first.');
      return;
    }
    commitSnapshot((prev) => {
      const remaining = prev.segments.filter((s) => s.id !== prev.selectedSegmentId);
      return {
        ...prev,
        segments: remaining,
        selectedSegmentId: remaining[0]?.id ?? null,
      };
    });
    showToast('Deleted selected segment.');
  }, [present.selectedSegmentId, present.segments.length, commitSnapshot, showToast]);

  const handleStepFrame = useCallback(
    (deltaFrames: number) => {
      setPlaybackState(false);
      const nextTime = clamp(currentTime + deltaFrames / DEFAULT_FPS, 0, masterDuration);
      seekAllVideos(nextTime);
    },
    [currentTime, masterDuration, seekAllVideos, setPlaybackState]
  );

  // Layout updates with debounced undo snapshot so drag/zoom stays smooth
  const handleChangeLayout = useCallback(
    (updater: (prev: LayoutConfig) => LayoutConfig) => {
      setPresent((prev) => {
        if (!lastSavedLayoutSnapshotRef.current) {
          lastSavedLayoutSnapshotRef.current = prev;
        }
        const nextLayout = updater(prev.layout);
        const next = { ...prev, layout: nextLayout };
        return next;
      });

      if (layoutHistoryTimerRef.current) {
        window.clearTimeout(layoutHistoryTimerRef.current);
      }
      layoutHistoryTimerRef.current = window.setTimeout(() => {
        const base = lastSavedLayoutSnapshotRef.current;
        if (base) {
          setPast((p) => [...p.slice(-49), base]);
          setFuture([]);
          lastSavedLayoutSnapshotRef.current = null;
        }
      }, 450);
    },
    []
  );

  // Clip actions
  const handleSelectClip = useCallback(
    (clipId: string) => {
      const clip = present.clips.find((c) => c.id === clipId);
      if (!clip) return;
      setPreviewingClipId(null);
      setPlaybackState(false);
      setPresent((prev) => ({
        ...prev,
        activeClipId: clip.id,
        inPoint: clip.startTime,
        outPoint: clip.endTime,
        layout: JSON.parse(JSON.stringify(clip.layout)) as LayoutConfig,
      }));
      seekAllVideos(clip.startTime);
    },
    [present.clips, seekAllVideos, setPlaybackState]
  );

  const handlePreviewClip = useCallback(
    (clipId: string) => {
      const clip = present.clips.find((c) => c.id === clipId);
      if (!clip) return;
      setPresent((prev) => ({
        ...prev,
        activeClipId: clip.id,
        inPoint: clip.startTime,
        outPoint: clip.endTime,
        layout: JSON.parse(JSON.stringify(clip.layout)) as LayoutConfig,
      }));
      setPreviewingClipId(clip.id);
      seekAllVideos(clip.startTime);
      setPlaybackState(true);
      setActiveView('studio');
    },
    [present.clips, seekAllVideos, setPlaybackState]
  );

  const handleStopPreviewClip = useCallback(() => {
    setPreviewingClipId(null);
    setPlaybackState(false);
  }, [setPlaybackState]);

  const handleRenameClip = useCallback(
    (clipId: string, newName: string) => {
      commitSnapshot((prev) => ({
        ...prev,
        clips: prev.clips.map((c) => (c.id === clipId ? { ...c, name: newName } : c)),
      }));
    },
    [commitSnapshot]
  );

  const handleDeleteClip = useCallback(
    (clipId: string) => {
      if (previewingClipId === clipId) {
        setPreviewingClipId(null);
        setPlaybackState(false);
      }
      commitSnapshot((prev) => {
        const nextClips = prev.clips.filter((c) => c.id !== clipId);
        return {
          ...prev,
          clips: nextClips,
          activeClipId: prev.activeClipId === clipId ? nextClips[0]?.id ?? null : prev.activeClipId,
        };
      });
      showToast('Clip deleted.');
    },
    [previewingClipId, setPlaybackState, commitSnapshot, showToast]
  );

  const handleSaveClipExport = useCallback(
    (clipId: string, url: string, mimeType: string, ext: string) => {
      setPresent((prev) => ({
        ...prev,
        clips: prev.clips.map((c) =>
          c.id === clipId
            ? { ...c, exportedUrl: url, exportedMimeType: mimeType, exportedExt: ext }
            : c
        ),
      }));
    },
    []
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (isImportOpen || isExportOpen || isFacecamCropOpen || isShortcutsOpen) return;

      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.key.toLowerCase() === 'i') {
        e.preventDefault();
        handleSetInPoint();
      } else if (e.key.toLowerCase() === 'o') {
        e.preventDefault();
        handleSetOutPoint();
      } else if (e.key.toLowerCase() === 'c' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        handleCutClip();
      } else if (e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        handleSplitSegment();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (e.shiftKey) {
          seekAllVideos(Math.max(0, currentTime - 5));
        } else {
          handleStepFrame(-1);
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (e.shiftKey) {
          seekAllVideos(Math.min(masterDuration, currentTime + 5));
        } else {
          handleStepFrame(1);
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (present.selectedSegmentId && present.segments.length > 1) {
          e.preventDefault();
          handleDeleteSegment();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    isImportOpen,
    isExportOpen,
    isFacecamCropOpen,
    isShortcutsOpen,
    handleTogglePlay,
    handleSetInPoint,
    handleSetOutPoint,
    handleCutClip,
    handleSplitSegment,
    handleStepFrame,
    seekAllVideos,
    currentTime,
    masterDuration,
    handleUndo,
    handleRedo,
    handleDeleteSegment,
    present.selectedSegmentId,
    present.segments.length,
  ]);

  const handleSelectView = (view: ActiveView) => {
    if (view === 'import') {
      setIsImportOpen(true);
      return;
    }
    if (view === 'shortcuts') {
      setIsShortcutsOpen(true);
      return;
    }
    setActiveView(view);
  };

  const handleOpenExport = (clipId: string | null = null) => {
    setPlaybackState(false);
    setExportInitialClipId(clipId);
    setIsExportOpen(true);
  };

  return (
    <div className="min-h-screen lg:h-screen flex flex-col bg-[#07080D] text-slate-100 overflow-x-hidden lg:overflow-hidden">
      <Header
        activeView={activeView}
        onSelectView={handleSelectView}
        clipCount={present.clips.length}
        hasMedia={Boolean(gameplay || facecam)}
        onOpenExport={() => handleOpenExport(present.activeClipId)}
      />

      {activeView === 'clips' ? (
        <ShortsQueueView
          clips={present.clips}
          onBackToStudio={() => setActiveView('studio')}
          onPreviewInStudio={handlePreviewClip}
          onExportClip={(id) => handleOpenExport(id)}
          onDeleteClip={handleDeleteClip}
          onRenameClip={handleRenameClip}
        />
      ) : (
        <main className="flex-1 min-h-0 p-3 flex flex-col gap-3 overflow-y-auto lg:overflow-hidden">
          {/* Top Workstation Grid: Media/Clips + Source Monitor + 9:16 Preview */}
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[275px_minmax(0,1fr)_350px] gap-3">
            <MediaAndClipsSidebar
              gameplay={gameplay}
              facecam={facecam}
              clips={present.clips}
              activeClipId={present.activeClipId}
              previewingClipId={previewingClipId}
              onOpenImport={() => setIsImportOpen(true)}
              onQuickUpload={handleQuickUpload}
              onRemoveSource={handleRemoveSource}
              onOpenFacecamCrop={handleOpenFacecamCrop}
              hasFacecamCrop={hasActiveCrop(present.layout.facecamTransform.crop)}
              onPreviewClip={handlePreviewClip}
              onStopPreviewClip={handleStopPreviewClip}
              onSelectClip={handleSelectClip}
              onRenameClip={handleRenameClip}
              onDeleteClip={handleDeleteClip}
              onExportClip={(id) => handleOpenExport(id)}
            />

            <SourcePlayer
              gameplay={gameplay}
              facecam={facecam}
              monitorRole={monitorRole}
              onChangeMonitorRole={(role) => {
                setMonitorRole(role);
                window.setTimeout(() => seekAllVideos(currentTime), 30);
              }}
              videoRef={sourceVideoRef}
              ytSourceRef={ytSourceRef}
              onSourceMetadata={handleSourceMetadata}
              isPlaying={isPlaying}
              currentTime={currentTime}
              duration={masterDuration}
              inPoint={present.inPoint}
              outPoint={present.outPoint}
              selectedSegmentId={present.selectedSegmentId}
              canDeleteSegment={present.segments.length > 1}
              canUndo={past.length > 0}
              canRedo={future.length > 0}
              onTogglePlay={handleTogglePlay}
              onSeek={(t) => {
                setPreviewingClipId(null);
                seekAllVideos(t);
              }}
              onStepFrame={handleStepFrame}
              onSetInPoint={handleSetInPoint}
              onSetOutPoint={handleSetOutPoint}
              onApplyDuration={handleApplyDuration}
              onCutClip={handleCutClip}
              onSplitSegment={handleSplitSegment}
              onDeleteSegment={handleDeleteSegment}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onOpenImport={() => setIsImportOpen(true)}
            />

            <ShortsPreview9x16
              gameplay={gameplay}
              facecam={facecam}
              previewGameplayRef={previewGameplayRef}
              previewFacecamRef={previewFacecamRef}
              ytGameplayRef={ytGameplayRef}
              ytFacecamRef={ytFacecamRef}
              onYouTubeMetadata={(role, dur, title) =>
                handleSourceMetadata(role, dur, 1920, 1080, title)
              }
              layout={present.layout}
              currentTime={currentTime}
              selectedDuration={Math.max(0, present.outPoint - present.inPoint)}
              isPreviewingClip={Boolean(previewingClipId)}
              onChangeLayout={handleChangeLayout}
              onOpenFacecamCrop={handleOpenFacecamCrop}
            />
          </div>

          {/* Bottom Dock: Multi-Track NLE Timeline */}
          <TimelineEditor
            duration={masterDuration}
            currentTime={currentTime}
            inPoint={present.inPoint}
            outPoint={present.outPoint}
            segments={present.segments}
            selectedSegmentId={present.selectedSegmentId}
            clips={present.clips}
            activeClipId={present.activeClipId}
            gameplay={gameplay}
            facecam={facecam}
            facecamSyncOffset={present.layout.facecamSyncOffset}
            onSeek={(t) => {
              setPreviewingClipId(null);
              seekAllVideos(t);
            }}
            onChangeInPoint={(t) =>
              setPresent((prev) => ({ ...prev, inPoint: t }))
            }
            onChangeOutPoint={(t) =>
              setPresent((prev) => ({ ...prev, outPoint: t }))
            }
            onSelectSegment={(segId) =>
              setPresent((prev) => ({ ...prev, selectedSegmentId: segId }))
            }
            onSelectClip={handleSelectClip}
          />
        </main>
      )}

      {/* Modals */}
      <ImportModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        gameplay={gameplay}
        facecam={facecam}
        onSetSource={handleSetSource}
        onLoadDemo={handleLoadDemo}
        isGeneratingDemo={isGeneratingDemo}
        onOpenFacecamCrop={handleOpenFacecamCrop}
      />

      <FacecamCropModal
        isOpen={isFacecamCropOpen}
        onClose={() => setIsFacecamCropOpen(false)}
        gameplay={gameplay}
        facecam={facecam}
        initialCrop={present.layout.facecamTransform.crop}
        initialActiveRange={present.layout.facecamActiveRange}
        timelineInPoint={present.inPoint}
        timelineOutPoint={present.outPoint}
        onQuickUploadFacecam={(file) => handleQuickUpload('facecam', file)}
        onApplyFacecamCrop={handleApplyFacecamCrop}
      />

      <ExportModal
        isOpen={isExportOpen}
        onClose={() => setIsExportOpen(false)}
        gameplay={gameplay}
        facecam={facecam}
        clips={present.clips}
        segments={present.segments}
        initialClipId={exportInitialClipId}
        currentInPoint={present.inPoint}
        currentOutPoint={present.outPoint}
        currentLayout={present.layout}
        onSaveClipExport={handleSaveClipExport}
        onQuickUpload={handleQuickUpload}
      />

      <ShortcutsModal
        isOpen={isShortcutsOpen}
        onClose={() => setIsShortcutsOpen(false)}
      />

      {/* Subtle Action Toast */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-5 right-5 z-50 px-4 py-2.5 rounded-lg bg-[#141926] border border-violet-500/40 text-xs font-medium text-slate-100 shadow-xl"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
