import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';

export interface YouTubePlayerHandle {
  play: () => void;
  pause: () => void;
  seekTo: (seconds: number) => void;
  setMuted: (muted: boolean) => void;
  setVolume: (volume0to1: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  isPaused: () => boolean;
}

interface YouTubeEmbedPlayerProps {
  videoId: string;
  muted?: boolean;
  volume?: number;
  className?: string;
  style?: React.CSSProperties;
  onMetadata?: (duration: number, title?: string) => void;
  onTimeUpdate?: (currentTime: number) => void;
  onStateChange?: (playerState: number) => void;
}

let ytInstanceCounter = 1;

export const YouTubeEmbedPlayer = forwardRef<
  YouTubePlayerHandle,
  YouTubeEmbedPlayerProps
>(
  (
    {
      videoId,
      muted = false,
      volume = 1,
      className,
      style,
      onMetadata,
      onTimeUpdate,
      onStateChange,
    },
    ref
  ) => {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const instanceId = useMemo(() => ytInstanceCounter++, []);
    const readyRef = useRef(false);
    const currentTimeRef = useRef(0);
    const durationRef = useRef(0);
    const playerStateRef = useRef(-1);
    const reportedDurationRef = useRef(0);

    const onMetadataRef = useRef(onMetadata);
    onMetadataRef.current = onMetadata;
    const onTimeUpdateRef = useRef(onTimeUpdate);
    onTimeUpdateRef.current = onTimeUpdate;
    const onStateChangeRef = useRef(onStateChange);
    onStateChangeRef.current = onStateChange;

    const postCommand = (func: string, args: unknown[] = []) => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      win.postMessage(
        JSON.stringify({
          event: 'command',
          func,
          args,
          id: instanceId,
        }),
        '*'
      );
    };

    useImperativeHandle(
      ref,
      () => ({
        play: () => postCommand('playVideo'),
        pause: () => postCommand('pauseVideo'),
        seekTo: (seconds: number) => {
          currentTimeRef.current = seconds;
          postCommand('seekTo', [Math.max(0, seconds), true]);
        },
        setMuted: (isMuted: boolean) => {
          postCommand(isMuted ? 'mute' : 'unMute');
        },
        setVolume: (vol0to1: number) => {
          postCommand('setVolume', [Math.round(Math.min(1, Math.max(0, vol0to1)) * 100)]);
        },
        getCurrentTime: () => currentTimeRef.current,
        getDuration: () => durationRef.current,
        isPaused: () => playerStateRef.current !== 1 && playerStateRef.current !== 3,
      }),
      [instanceId]
    );

    useEffect(() => {
      readyRef.current = false;
      currentTimeRef.current = 0;
      durationRef.current = 0;
      reportedDurationRef.current = 0;
      playerStateRef.current = -1;
    }, [videoId]);

    useEffect(() => {
      const handleMessage = (event: MessageEvent) => {
        if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
          return;
        }
        let data: Record<string, unknown> | null = null;
        if (typeof event.data === 'string') {
          try {
            data = JSON.parse(event.data) as Record<string, unknown>;
          } catch {
            return;
          }
        } else if (typeof event.data === 'object' && event.data !== null) {
          data = event.data as Record<string, unknown>;
        }
        if (!data) return;

        if (data.event === 'onReady') {
          readyRef.current = true;
          postCommand(muted ? 'mute' : 'unMute');
          postCommand('setVolume', [Math.round(volume * 100)]);
        }

        if (data.event === 'infoDelivery' && typeof data.info === 'object' && data.info !== null) {
          const info = data.info as Record<string, unknown>;

          if (typeof info.duration === 'number' && info.duration > 0) {
            durationRef.current = info.duration;
            const videoData = info.videoData as { title?: string } | undefined;
            if (
              Math.abs(reportedDurationRef.current - info.duration) > 0.5 ||
              videoData?.title
            ) {
              reportedDurationRef.current = info.duration;
              onMetadataRef.current?.(info.duration, videoData?.title);
            }
          }

          if (typeof info.currentTime === 'number') {
            currentTimeRef.current = info.currentTime;
            onTimeUpdateRef.current?.(info.currentTime);
          }

          if (typeof info.playerState === 'number') {
            playerStateRef.current = info.playerState;
            onStateChangeRef.current?.(info.playerState);
          }
        }

        if (data.event === 'onStateChange' && typeof data.info === 'number') {
          playerStateRef.current = data.info;
          onStateChangeRef.current?.(data.info);
        }
      };

      window.addEventListener('message', handleMessage);
      return () => window.removeEventListener('message', handleMessage);
    }, [muted, volume]);

    // Apply mute / volume changes cleanly
    useEffect(() => {
      if (!readyRef.current) return;
      postCommand(muted ? 'mute' : 'unMute');
      postCommand('setVolume', [Math.round(Math.min(1, Math.max(0, volume)) * 100)]);
    }, [muted, volume]);

    // Send listening handshake on load & retry briefly until ready
    const handleIframeLoad = () => {
      const sendListening = () => {
        const win = iframeRef.current?.contentWindow;
        if (!win) return;
        win.postMessage(
          JSON.stringify({ event: 'listening', id: instanceId, channel: 'widget' }),
          '*'
        );
      };
      sendListening();
      const timer = window.setInterval(() => {
        if (readyRef.current) {
          window.clearInterval(timer);
          return;
        }
        sendListening();
      }, 300);
      window.setTimeout(() => window.clearInterval(timer), 6000);
    };

    const origin =
      typeof window !== 'undefined' ? encodeURIComponent(window.location.origin) : '';
    const embedSrc = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&controls=0&disablekb=1&fs=0&modestbranding=1&rel=0&playsinline=1&iv_load_policy=3&origin=${origin}`;

    return (
      <iframe
        ref={iframeRef}
        src={embedSrc}
        onLoad={handleIframeLoad}
        title={`YouTube player ${videoId}`}
        allow="autoplay; encrypted-media; picture-in-picture"
        className={className}
        style={{ border: 0, ...style }}
      />
    );
  }
);

YouTubeEmbedPlayer.displayName = 'YouTubeEmbedPlayer';
