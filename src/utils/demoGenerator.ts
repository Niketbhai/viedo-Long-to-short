import { VideoSource } from '../types/editor';
import { generateId } from './time';

function getSupportedRecorderMime(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  for (const mime of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
}

async function recordCanvasClip(
  width: number,
  height: number,
  durationSec: number,
  drawFrame: (ctx: CanvasRenderingContext2D, t: number, w: number, h: number) => void,
  toneFreq: number,
  pulseRate: number
): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  const stream = canvas.captureStream(30);

  // Synthesize subtle game/voice audio via Web Audio API so audio mixing & sync can be tested
  let audioCtx: AudioContext | null = null;
  let osc: OscillatorNode | null = null;
  try {
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = pulseRate > 2 ? 'sawtooth' : 'sine';
    osc.frequency.value = toneFreq;
    gain.gain.value = 0.04;

    // Subtle rhythmic modulation
    const lfo = audioCtx.createOscillator();
    const lfoGain = audioCtx.createGain();
    lfo.frequency.value = pulseRate;
    lfoGain.gain.value = 0.03;
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);

    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    lfo.start();

    dest.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
  } catch {
    // Fallback to video-only if AudioContext is restricted
  }

  const mimeType = getSupportedRecorderMime();
  const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_000_000 })
    : new MediaRecorder(stream);

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  return new Promise<string>((resolve, reject) => {
    recorder.onerror = () => reject(new Error('Failed to generate local demo video'));
    recorder.onstop = () => {
      try {
        osc?.stop();
        audioCtx?.close();
      } catch {
        // ignore cleanup error
      }
      const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      resolve(URL.createObjectURL(blob));
    };

    recorder.start(200);
    const startMs = performance.now();

    const tick = () => {
      const elapsed = (performance.now() - startMs) / 1000;
      if (elapsed >= durationSec) {
        drawFrame(ctx, durationSec, width, height);
        recorder.stop();
        return;
      }
      drawFrame(ctx, elapsed, width, height);
      requestAnimationFrame(tick);
    };

    drawFrame(ctx, 0, width, height);
    requestAnimationFrame(tick);
  });
}

function drawGameplayFrame(ctx: CanvasRenderingContext2D, t: number, w: number, h: number) {
  // Deep arena backdrop
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#090d1a');
  grad.addColorStop(0.5, '#121329');
  grad.addColorStop(1, '#081524');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Perspective tactical grid
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.16)';
  ctx.lineWidth = 1;
  const offset = (t * 60) % 64;
  for (let x = -64; x <= w + 64; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x + offset * 0.4, 0);
    ctx.lineTo(x - offset * 0.4, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, (y + offset) % h);
    ctx.lineTo(w, (y + offset) % h);
    ctx.stroke();
  }

  // Moving targets & projectiles
  for (let i = 0; i < 4; i++) {
    const cx = w * (0.22 + 0.18 * i) + Math.sin(t * (1.4 + i * 0.3) + i) * 70;
    const cy = h * 0.46 + Math.cos(t * (1.1 + i * 0.25) + i * 2) * 110;
    const radius = 26 + Math.sin(t * 4 + i) * 4;

    ctx.beginPath();
    ctx.arc(cx, cy, radius + 10, 0, Math.PI * 2);
    ctx.fillStyle = i % 2 === 0 ? 'rgba(168, 85, 247, 0.18)' : 'rgba(56, 189, 248, 0.18)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = i % 2 === 0 ? '#a855f7' : '#38bdf8';
    ctx.fill();
  }

  // Center crosshair
  const aimX = w / 2 + Math.sin(t * 2.1) * 90;
  const aimY = h / 2 + Math.cos(t * 1.7) * 55;
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(aimX, aimY, 22, 0, Math.PI * 2);
  ctx.moveTo(aimX - 32, aimY);
  ctx.lineTo(aimX - 12, aimY);
  ctx.moveTo(aimX + 12, aimY);
  ctx.lineTo(aimX + 32, aimY);
  ctx.moveTo(aimX, aimY - 32);
  ctx.lineTo(aimX, aimY - 12);
  ctx.moveTo(aimX, aimY + 12);
  ctx.lineTo(aimX, aimY + 32);
  ctx.stroke();

  // HUD top-left match timer & score simulation
  ctx.fillStyle = 'rgba(7, 8, 13, 0.72)';
  ctx.fillRect(24, 24, 240, 56);
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
  ctx.strokeRect(24, 24, 240, 56);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 20px monospace';
  const score = 1400 + Math.floor(t * 125);
  ctx.fillText(`ARENA MATCH  ${score}`, 40, 58);

  // Highlight moment burst around 4s-8s and 10s-14s
  const inBurst = (t > 4 && t < 7.5) || (t > 10 && t < 13.5);
  if (inBurst) {
    ctx.fillStyle = 'rgba(168, 85, 247, 0.9)';
    ctx.fillRect(w / 2 - 140, 32, 280, 42);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('CLUTCH STREAK ACTIVE', w / 2, 60);
    ctx.textAlign = 'left';
  }
}

function drawFacecamFrame(ctx: CanvasRenderingContext2D, t: number, w: number, h: number) {
  // Studio streamer room backdrop
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#140f24');
  grad.addColorStop(1, '#09111f');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Subtle LED rim light bars in background
  ctx.fillStyle = 'rgba(168, 85, 247, 0.25)';
  ctx.fillRect(48, 40, 12, h - 80);
  ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
  ctx.fillRect(w - 60, 40, 12, h - 80);

  // Stylized streamer silhouette + headset
  const bob = Math.sin(t * 3.2) * 6;
  const cx = w / 2;
  const cy = h * 0.56 + bob;

  // Shoulders
  ctx.fillStyle = '#1e2235';
  ctx.beginPath();
  ctx.ellipse(cx, h + 10, 190, 180, 0, Math.PI, Math.PI * 2);
  ctx.fill();

  // Head
  ctx.fillStyle = '#2d324d';
  ctx.beginPath();
  ctx.arc(cx, cy - 35, 76, 0, Math.PI * 2);
  ctx.fill();

  // Headset band
  ctx.strokeStyle = '#8b5cf6';
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.arc(cx, cy - 42, 84, Math.PI * 1.05, Math.PI * 1.95);
  ctx.stroke();

  // Earcups
  ctx.fillStyle = '#38bdf8';
  ctx.fillRect(cx - 94, cy - 55, 22, 54);
  ctx.fillRect(cx + 72, cy - 55, 22, 54);

  // Visor reflection
  ctx.fillStyle = 'rgba(56, 189, 248, 0.85)';
  ctx.fillRect(cx - 42, cy - 50, 32, 12);
  ctx.fillRect(cx + 10, cy - 50, 32, 12);

  // Voice reactive level bars at bottom of cam
  for (let i = 0; i < 16; i++) {
    const barH = 12 + Math.abs(Math.sin(t * 7 + i * 0.6)) * 34;
    ctx.fillStyle = i % 2 === 0 ? '#a855f7' : '#38bdf8';
    ctx.fillRect(cx - 128 + i * 16, h - 24 - barH, 10, barH);
  }
}

export async function generateLocalDemoPair(): Promise<{
  gameplay: VideoSource;
  facecam: VideoSource;
}> {
  const duration = 16;
  const [gameplayUrl, facecamUrl] = await Promise.all([
    recordCanvasClip(960, 540, duration, drawGameplayFrame, 220, 3.5),
    recordCanvasClip(640, 360, duration, drawFacecamFrame, 165, 1.8),
  ]);

  return {
    gameplay: {
      id: generateId('src'),
      role: 'gameplay',
      name: 'arena_match_recording.webm',
      url: gameplayUrl,
      sourceType: 'demo',
      duration,
      width: 960,
      height: 540,
      corsSafe: true,
    },
    facecam: {
      id: generateId('src'),
      role: 'facecam',
      name: 'streamer_facecam.webm',
      url: facecamUrl,
      sourceType: 'demo',
      duration,
      width: 640,
      height: 360,
      corsSafe: true,
    },
  };
}
