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
  isReady: () => boolean;
}

interface YouTubeEmbedPlayerProps {
  videoId: string;
  muted?: boolean;
  volume?: number;
  className?: string;
  style?: React.CSSProperties;
  onReady?: () => void;
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
      onReady,
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
    const userInteractedRef = useRef(false);
    const isPrimingRef = useRef(false);
    const primedRef = useRef(false);

    const onReadyRef = useRef(onReady);
    onReadyRef.current = onReady;
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
        play: () => {
          userInteractedRef.current = true;
          isPrimingRef.current = false;
          postCommand(muted ? 'mute' : 'unMute');
          postCommand('setVolume', [Math.round(Math.min(1, Math.max(0, volume)) * 100)]);
          postCommand('playVideo');
        },
        pause: () => {
          userInteractedRef.current = true;
          isPrimingRef.current = false;
          postCommand('pauseVideo');
        },
        seekTo: (seconds: number) => {
          userInteractedRef.current = true;
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
        isReady: () => readyRef.current,
      }),
      [instanceId]
    );

    useEffect(() => {
      readyRef.current = false;
      currentTimeRef.current = 0;
      durationRef.current = 0;
      reportedDurationRef.current = 0;
      playerStateRef.current = -1;
      userInteractedRef.current = false;
      isPrimingRef.current = false;
      primedRef.current = false;
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
          onReadyRef.current?.();
          // Briefly prime 1 frame muted so YouTube dismisses its pre-play thumbnail & title overlay
          if (!userInteractedRef.current && !primedRef.current) {
            isPrimingRef.current = true;
            postCommand('mute');
            postCommand('playVideo');
          }
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

          if (typeof info.currentTime === 'number' && !isPrimingRef.current) {
            currentTimeRef.current = info.currentTime;
            onTimeUpdateRef.current?.(info.currentTime);
          }

          if (typeof info.playerState === 'number') {
            playerStateRef.current = info.playerState;
            if (isPrimingRef.current && info.playerState === 1) {
              isPrimingRef.current = false;
              primedRef.current = true;
              if (!userInteractedRef.current) {
                postCommand('pauseVideo');
                postCommand('seekTo', [0, true]);
              }
              postCommand(muted ? 'mute' : 'unMute');
              postCommand('setVolume', [Math.round(volume * 100)]);
              return;
            }
            onStateChangeRef.current?.(info.playerState);
          }
        }

        if (data.event === 'onStateChange' && typeof data.info === 'number') {
          playerStateRef.current = data.info;
          if (isPrimingRef.current && data.info === 1) {
            isPrimingRef.current = false;
            primedRef.current = true;
            if (!userInteractedRef.current) {
              postCommand('pauseVideo');
              postCommand('seekTo', [0, true]);
            }
            postCommand(muted ? 'mute' : 'unMute');
            postCommand('setVolume', [Math.round(volume * 100)]);
            return;
          }
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
    const embedSrc = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&controls=0&disablekb=1&fs=0&modestbranding=1&rel=0&playsinline=1&iv_load_policy=3&showinfo=0&cc_load_policy=0&origin=${origin}`;

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
