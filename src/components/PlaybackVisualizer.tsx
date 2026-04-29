import React, { useState, useRef, useEffect, useCallback } from 'react';
import './PlaybackVisualizer.css';
import { MAXIMUM_VALID_FREQUENCY, CHARACTER_DURATION } from '../utils/audioCodec';
import type { TransmissionRecord, FrequencyFrame } from '../utils/transmissionStore';

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function selectActiveFrame(
  frames: FrequencyFrame[],
  positionMs: number
): FrequencyFrame | null {
  if (!frames.length) return null;
  let best = frames[0];
  let bestDist = Math.abs(frames[0].offsetMs - positionMs);
  for (let i = 1; i < frames.length; i++) {
    const d = Math.abs(frames[i].offsetMs - positionMs);
    if (d < bestDist) { bestDist = d; best = frames[i]; }
  }
  return bestDist <= 55 ? best : null;
}

/** How far (0–1) through the current frame's active window we are */
function framePulse(frames: FrequencyFrame[], positionMs: number): number {
  if (!frames.length) return 0;
  let activeIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const d = Math.abs(frames[i].offsetMs - positionMs);
    if (d < bestDist) { bestDist = d; activeIdx = i; }
  }
  if (activeIdx < 0 || bestDist > 55) return 0;
  const frame = frames[activeIdx];
  const nextOffset = activeIdx + 1 < frames.length
    ? frames[activeIdx + 1].offsetMs
    : frame.offsetMs + Math.round(CHARACTER_DURATION * 1000);
  const duration = nextOffset - frame.offsetMs;
  if (duration <= 0) return 1;
  const elapsed = positionMs - frame.offsetMs;
  // Pulse: rises quickly, holds, then fades — like a sine arch
  const t = Math.max(0, Math.min(1, elapsed / duration));
  return Math.sin(t * Math.PI);
}

export function formatTime(posMs: number, durMs: number): string {
  return `${String(Math.round(posMs)).padStart(4, '0')}ms / ${String(durMs).padStart(4, '0')}ms`;
}

export function annotationString(frame: FrequencyFrame): string {
  return `${frame.label} / ${frame.frequency}Hz`;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const KEY_RANGES = [
  { freq: 900,  label: 'SPACE'   },
  { freq: 1300, label: 'SPECIAL' },
  { freq: 4700, label: 'NUMBERS' },
  { freq: 5700, label: 'LETTERS' },
  { freq: 2500, label: 'START'   },
  { freq: 2700, label: 'END'     },
];

const EDGE_PADDING = 30;
const CANVAS_W = 800;
const CANVAS_H = 175;
const HISTORY_DEPTH = 8;
const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4];

// ── Audio engine ──────────────────────────────────────────────────────────────

function scheduleAudio(
  frames: FrequencyFrame[],
  startFromMs: number,
  speed: number,
  onEnd: () => void
): { ctx: AudioContext; stop: () => void } {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const nodes: OscillatorNode[] = [];
  let maxEnd = ctx.currentTime;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.offsetMs < startFromMs) continue;
    if (f.frequency <= 0) continue;

    const nextOffset = i + 1 < frames.length
      ? frames[i + 1].offsetMs
      : f.offsetMs + Math.round(CHARACTER_DURATION * 1000);
    const durMs = Math.max(30, nextOffset - f.offsetMs);

    const startSec = ctx.currentTime + (f.offsetMs - startFromMs) / 1000 / speed;
    const durSec = (durMs / 1000) / speed;
    const fadeTime = Math.min(0.004, durSec / 10);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = f.frequency;
    gain.gain.setValueAtTime(0, startSec);
    gain.gain.linearRampToValueAtTime(0.35, startSec + fadeTime);
    gain.gain.setValueAtTime(0.35, startSec + durSec - fadeTime);
    gain.gain.linearRampToValueAtTime(0, startSec + durSec);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startSec);
    osc.stop(startSec + durSec);
    nodes.push(osc);
    maxEnd = Math.max(maxEnd, startSec + durSec);
  }

  // Fire onEnd after all tones finish
  const endDelay = Math.max(0, (maxEnd - ctx.currentTime) * 1000 + 100);
  const timer = window.setTimeout(onEnd, endDelay);

  return {
    ctx,
    stop: () => {
      clearTimeout(timer);
      nodes.forEach(n => { try { n.stop(); } catch (_) {} });
      ctx.close();
    },
  };
}

// ── PlaybackCanvas ────────────────────────────────────────────────────────────

interface PlaybackCanvasProps {
  record: TransmissionRecord;
  position: number;
  pulse: number; // 0–1 reactive intensity
}

const PlaybackCanvas: React.FC<PlaybackCanvasProps> = ({ record, position, pulse }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const maxFreq = MAXIMUM_VALID_FREQUENCY;
    const usableW = CANVAS_W - EDGE_PADDING * 2;
    const isSent = record.direction === 'sent';

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Grid
    ctx.strokeStyle = 'rgba(50,50,50,0.5)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 10; i++) {
      const gx = i * (CANVAS_W / 10);
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, CANVAS_H - 15); ctx.stroke();
    }

    // Freq axis labels
    ctx.fillStyle = 'rgba(49,133,255,0.8)';
    ctx.font = '10px monospace';
    for (let i = 0; i <= 10; i++) {
      const norm = i / 10;
      const x = EDGE_PADDING + norm * usableW;
      ctx.textAlign = i === 0 ? 'left' : i === 10 ? 'right' : 'center';
      ctx.fillText(`${Math.round(norm * maxFreq)}Hz`, x, CANVAS_H - 5);
    }

    // Key markers
    ctx.font = '9px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    KEY_RANGES.forEach(m => {
      const norm = m.freq / maxFreq;
      const x = EDGE_PADDING + norm * usableW;
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H - 20); ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = norm < 0.05 ? 'left' : norm > 0.95 ? 'right' : 'center';
      ctx.fillText(m.label, x, 10);
    });

    // History waterfall
    const pastFrames = record.frames.filter(f => f.offsetMs <= position);
    const historySlice = pastFrames.slice(-HISTORY_DEPTH);
    const opacities    = [0.06, 0.10, 0.16, 0.23, 0.31, 0.40, 0.53, 0.68];
    const scaleFactors = [0.18, 0.28, 0.38, 0.48, 0.58, 0.68, 0.80, 0.90];

    for (let hi = 0; hi < historySlice.length - 1; hi++) {
      const hf = historySlice[hi];
      const opacity = opacities[hi] ?? 0.06;
      const scale   = scaleFactors[hi] ?? 0.18;
      const norm = hf.frequency / maxFreq;
      const cx = EDGE_PADDING + norm * usableW;
      const barW = Math.max(4, (usableW / 120) * 1.4 * scale);
      const barH = (CANVAS_H - 20) * scale;
      const isMarker = hf.label === 'START' || hf.label === 'END';
      ctx.globalAlpha = opacity;
      ctx.fillStyle = isMarker ? 'rgba(255,170,0,1)'
        : isSent ? 'rgba(0,255,65,1)' : 'rgba(20,255,255,1)';
      ctx.fillRect(cx - barW / 2, CANVAS_H - 20 - barH, barW, barH);
    }
    ctx.globalAlpha = 1;

    // Active frame with reactive pulse
    const active = selectActiveFrame(record.frames, position);
    if (active) {
      const norm = active.frequency / maxFreq;
      const cx = EDGE_PADDING + norm * usableW;
      const isMarker = active.label === 'START' || active.label === 'END';

      // Reactive: bar height and glow scale with pulse
      const heightScale = 0.6 + 0.4 * pulse;
      const barH = (CANVAS_H - 20) * heightScale;
      const barW = Math.max(6, (usableW / 120) * (1.4 + 0.8 * pulse));
      const by = CANVAS_H - 20 - barH;

      const glowColor = isMarker ? '#ffaa00' : isSent ? '#00ff41' : '#ff2b6d';
      ctx.shadowBlur = 12 + 24 * pulse;
      ctx.shadowColor = glowColor;

      const grad = ctx.createLinearGradient(0, by, 0, CANVAS_H - 20);
      if (isMarker) {
        grad.addColorStop(0, `rgba(255,${Math.round(180 + 20 * pulse)},0,1)`);
        grad.addColorStop(1, 'rgba(255,140,0,0.9)');
      } else if (isSent) {
        grad.addColorStop(0, `rgba(0,255,${Math.round(50 + 15 * pulse)},1)`);
        grad.addColorStop(1, 'rgba(0,200,50,0.9)');
      } else {
        grad.addColorStop(0, `rgba(255,${Math.round(43 - 20 * pulse)},${Math.round(109 + 71 * pulse)},1)`);
        grad.addColorStop(1, 'rgba(255,65,180,0.9)');
      }
      ctx.fillStyle = grad;
      ctx.fillRect(cx - barW / 2, by, barW, barH);
      ctx.shadowBlur = 0;

      // Annotation
      const annotation = annotationString(active);
      ctx.font = `bold ${Math.round(10 + 3 * pulse)}px monospace`;
      ctx.textAlign = 'center';
      const tw = ctx.measureText(annotation).width + 12;
      const tx = cx - tw / 2;
      const ty = Math.max(16, by - 4);
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.fillRect(tx, ty - 13, tw, 17);
      ctx.fillStyle = isMarker ? '#ffaa00' : isSent ? '#00ff41' : '#ff2b6d';
      ctx.fillText(annotation, cx, ty);
    }
  }, [record, position, pulse]);

  return (
    <div className="pb-canvas-wrapper">
      <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} className="pb-canvas-3d" />
    </div>
  );
};

// ── PlaybackControls ──────────────────────────────────────────────────────────

interface PlaybackControlsProps {
  duration: number;
  position: number;
  isPlaying: boolean;
  speed: number;
  isFullscreen: boolean;
  onSeek: (ms: number) => void;
  onPlay: () => void;
  onStop: () => void;
  onSpeedChange: (s: number) => void;
  onFullscreen: () => void;
}

const PlaybackControls: React.FC<PlaybackControlsProps> = ({
  duration, position, isPlaying, speed, isFullscreen,
  onSeek, onPlay, onStop, onSpeedChange, onFullscreen,
}) => (
  <div className="pb-controls">
    <button className="pb-btn" onClick={isPlaying ? onStop : onPlay}>
      {isPlaying ? '⏹' : '▶'}
    </button>
    <input
      type="range"
      className="pb-scrubber"
      min={0}
      max={duration}
      step={1}
      value={position}
      onChange={e => onSeek(Number(e.target.value))}
    />
    <span className="pb-time">{formatTime(position, duration)}</span>
    <div className="pb-speed-group">
      {SPEED_OPTIONS.map(s => (
        <button
          key={s}
          className={`pb-speed-btn ${speed === s ? 'active' : ''}`}
          onClick={() => onSpeedChange(s)}
        >
          {s}×
        </button>
      ))}
    </div>
    <button className="pb-btn pb-fs-btn" onClick={onFullscreen} title="Fullscreen">
      {isFullscreen ? '⛶' : '⛶'}
    </button>
  </div>
);

// ── TransmissionList ──────────────────────────────────────────────────────────

interface TransmissionListProps {
  transmissions: TransmissionRecord[];
  selectedId: string | null;
  onSelect: (r: TransmissionRecord) => void;
}

const TransmissionList: React.FC<TransmissionListProps> = ({ transmissions, selectedId, onSelect }) => {
  if (!transmissions.length) return <div className="pb-empty">NO TRANSMISSIONS RECORDED YET</div>;
  const sorted = [...transmissions].sort((a, b) => b.startTimestamp - a.startTimestamp);
  return (
    <div className="pb-list">
      {sorted.map(r => {
        const label = r.text.length > 40 ? r.text.slice(0, 40) + '…' : r.text;
        return (
          <button
            key={r.id}
            className={`pb-list-item ${selectedId === r.id ? 'active' : ''} pb-dir-${r.direction}`}
            onClick={() => onSelect(r)}
          >
            <span className="pb-badge">{r.direction === 'sent' ? 'TX' : 'RX'}</span>
            <span className="pb-label">{label || '(empty)'}</span>
            <span className="pb-dur">{r.durationMs}ms</span>
          </button>
        );
      })}
    </div>
  );
};

// ── PlaybackVisualizer (container) ────────────────────────────────────────────

interface PlaybackVisualizerProps {
  transmissions: TransmissionRecord[];
}

const PlaybackVisualizer: React.FC<PlaybackVisualizerProps> = ({ transmissions }) => {
  const [selectedRecord, setSelectedRecord] = useState<TransmissionRecord | null>(null);
  const [scrubPosition, setScrubPosition] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [pulse, setPulse] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const playIntervalRef = useRef<number | null>(null);
  const audioRef = useRef<{ ctx: AudioContext; stop: () => void } | null>(null);
  const speedRef = useRef(1);
  const positionRef = useRef(0);

  useEffect(() => { speedRef.current = playbackSpeed; }, [playbackSpeed]);
  useEffect(() => { positionRef.current = scrubPosition; }, [scrubPosition]);

  // Auto-select newest
  useEffect(() => {
    if (transmissions.length > 0 && !selectedRecord) {
      setSelectedRecord(transmissions[0]);
      setScrubPosition(0);
    }
  }, [transmissions]);

  // Fullscreen change listener
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const stopPlayback = useCallback(() => {
    if (playIntervalRef.current) { clearInterval(playIntervalRef.current); playIntervalRef.current = null; }
    if (audioRef.current) { audioRef.current.stop(); audioRef.current = null; }
    setIsPlaying(false);
    setPulse(0);
  }, []);

  const handleSelect = useCallback((r: TransmissionRecord) => {
    stopPlayback();
    setSelectedRecord(r);
    setScrubPosition(0);
  }, [stopPlayback]);

  const handleSeek = useCallback((ms: number) => {
    stopPlayback();
    setScrubPosition(ms);
  }, [stopPlayback]);

  const handlePlay = useCallback(() => {
    if (!selectedRecord) return;
    setIsPlaying(true);

    // Schedule audio from current position
    audioRef.current = scheduleAudio(
      selectedRecord.frames,
      positionRef.current,
      speedRef.current,
      () => { /* audio ends naturally */ }
    );

    // Advance scrub position + compute pulse
    playIntervalRef.current = window.setInterval(() => {
      setScrubPosition(prev => {
        const next = prev + 16 * speedRef.current;
        if (next >= selectedRecord.durationMs) {
          clearInterval(playIntervalRef.current!);
          playIntervalRef.current = null;
          if (audioRef.current) { audioRef.current.stop(); audioRef.current = null; }
          setIsPlaying(false);
          setPulse(0);
          return selectedRecord.durationMs;
        }
        setPulse(framePulse(selectedRecord.frames, next));
        return next;
      });
    }, 16);
  }, [selectedRecord]);

  const handleSpeedChange = useCallback((s: number) => {
    setPlaybackSpeed(s);
    speedRef.current = s;
    if (isPlaying && selectedRecord) {
      stopPlayback();
      // Restart with new speed from current position
      setIsPlaying(true);
      audioRef.current = scheduleAudio(
        selectedRecord.frames,
        positionRef.current,
        s,
        () => {}
      );
      playIntervalRef.current = window.setInterval(() => {
        setScrubPosition(prev => {
          const next = prev + 16 * speedRef.current;
          if (next >= selectedRecord.durationMs) {
            clearInterval(playIntervalRef.current!);
            playIntervalRef.current = null;
            if (audioRef.current) { audioRef.current.stop(); audioRef.current = null; }
            setIsPlaying(false);
            setPulse(0);
            return selectedRecord.durationMs;
          }
          setPulse(framePulse(selectedRecord.frames, next));
          return next;
        });
      }, 16);
    }
  }, [isPlaying, selectedRecord, stopPlayback]);

  const handleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => () => stopPlayback(), []);

  return (
    <div className={`pb-container ${isFullscreen ? 'pb-fullscreen' : ''}`} ref={containerRef}>
      {!isFullscreen && (
        <TransmissionList
          transmissions={transmissions}
          selectedId={selectedRecord?.id ?? null}
          onSelect={handleSelect}
        />
      )}
      {selectedRecord && (
        <>
          <PlaybackCanvas record={selectedRecord} position={scrubPosition} pulse={pulse} />
          <PlaybackControls
            duration={selectedRecord.durationMs}
            position={scrubPosition}
            isPlaying={isPlaying}
            speed={playbackSpeed}
            isFullscreen={isFullscreen}
            onSeek={handleSeek}
            onPlay={handlePlay}
            onStop={stopPlayback}
            onSpeedChange={handleSpeedChange}
            onFullscreen={handleFullscreen}
          />
          {isFullscreen && (
            <div className="pb-fs-info">
              <span className={`pb-fs-badge pb-dir-${selectedRecord.direction}`}>
                {selectedRecord.direction === 'sent' ? 'TX' : 'RX'}
              </span>
              <span className="pb-fs-text">{selectedRecord.text}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default PlaybackVisualizer;
