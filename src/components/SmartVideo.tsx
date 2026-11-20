import Hls from 'hls.js';
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

interface SmartVideoProps extends React.VideoHTMLAttributes<HTMLVideoElement> {
  src: string;
  isHls?: boolean;
  onLoadedMetadataInfo?: (duration: number, width: number, height: number) => void;
  onVideoError?: (message: string) => void;
}

export const SmartVideo = forwardRef<HTMLVideoElement | null, SmartVideoProps>(
  (
    { src, isHls = false, onLoadedMetadataInfo, onVideoError, ...videoProps },
    forwardedRef
  ) => {
    const internalRef = useRef<HTMLVideoElement | null>(null);
    useImperativeHandle<HTMLVideoElement | null, HTMLVideoElement | null>(
      forwardedRef,
      () => internalRef.current
    );

    const onMetaRef = useRef(onLoadedMetadataInfo);
    onMetaRef.current = onLoadedMetadataInfo;
    const onErrRef = useRef(onVideoError);
    onErrRef.current = onVideoError;

    useEffect(() => {
      const video = internalRef.current;
      if (!video || !src) return;

      const handleMeta = () => {
        if (video.duration && Number.isFinite(video.duration)) {
          onMetaRef.current?.(
            video.duration,
            video.videoWidth || 1920,
            video.videoHeight || 1080
          );
        }
      };

      const handleError = () => {
        onErrRef.current?.(
          'Browser could not decode this video format. For local recordings, MP4 (H.264) or WebM works best.'
        );
      };

      video.addEventListener('loadedmetadata', handleMeta);
      video.addEventListener('error', handleError);

      let hls: Hls | null = null;
      const shouldUseHls = isHls || src.includes('.m3u8') || src.includes('/api/hls-proxy');

      if (shouldUseHls && Hls.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
        });
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_ev, data) => {
          if (data.fatal) {
            onErrRef.current?.('Stream playback error while loading HLS video.');
          }
        });
      } else {
        video.src = src;
        video.load();
      }

      return () => {
        video.removeEventListener('loadedmetadata', handleMeta);
        video.removeEventListener('error', handleError);
        if (hls) {
          hls.destroy();
        }
      };
    }, [src, isHls]);

    return <video ref={internalRef} {...videoProps} />;
  }
);

SmartVideo.displayName = 'SmartVideo';
