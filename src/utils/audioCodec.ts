// Add a console log to confirm the module is being loaded
console.log('Audio codec module is loading with enhanced character detection and faster transmission...');

// Constants for audio encoding
export const START_FREQUENCY = 2500; // Hz - higher and distinct
export const END_FREQUENCY = 2700; // Hz - higher and distinct
export const MINIMUM_VALID_FREQUENCY = 400; // Ignore all frequencies below this threshold
export const MAXIMUM_VALID_FREQUENCY = 8300; // Upper limit increased for wider character spacing (100Hz)

// Constants for timing - BALANCED FOR SPEED AND ACCURACY
export const START_MARKER_DURATION = 0.15; // seconds (base 1×) — 150ms, ~3 FFT frames
export const END_MARKER_DURATION = 0.15; // seconds (base 1×)
export const CHARACTER_DURATION = 0.085; // seconds (base 1×) — 85ms gives ~1.8 FFT frames per char
export const CHARACTER_GAP = 0.04; // seconds (base 1×) — 40ms gap, nearly one FFT frame
const VOLUME = 1.0; // Full volume for better reception

// ── Speed multiplier ──────────────────────────────────────────────────────────
// Both sender and receiver must use the same speed.
// 1 = default (10 chars/sec), 2 = 20 chars/sec, 4 = 40 chars/sec
let _speedMultiplier = 1;

export type TransmissionSpeed = 1 | 2 | 4;

export const setTransmissionSpeed = (speed: TransmissionSpeed) => {
  _speedMultiplier = speed;
  console.log(`Transmission speed set to ${speed}× (${Math.round(10 * speed)} chars/sec)`);
};

export const getTransmissionSpeed = (): TransmissionSpeed => _speedMultiplier as TransmissionSpeed;

// Scaled timing helpers — used by both encoder and decoder
const scaledCharDuration   = () => CHARACTER_DURATION   / _speedMultiplier;
const scaledCharGap        = () => CHARACTER_GAP        / _speedMultiplier;
const scaledMarkerDuration = () => START_MARKER_DURATION / _speedMultiplier;
// Decoder debounce/lockout scale with speed — tighter windows at higher speeds
const scaledDebounce       = () => Math.max(20, Math.round(75  / _speedMultiplier));
const scaledLockout        = () => Math.max(30, Math.round(120 / _speedMultiplier));
const scaledRecentWindow   = () => Math.max(100, Math.round(450 / _speedMultiplier));

// Constants for parallel tone transmission
const USE_PARALLEL_TONES = true; // Enable parallel tones to improve detection at higher speeds
const PARALLEL_TONE_OFFSET = 35; // Hz offset for parallel tone - increased for better distinction at higher speeds
const PARALLEL_TONE_VOLUME = 0.75; // Slightly lower volume for secondary tone

// Debug flag to enable verbose logging
const DEBUG_AUDIO = true;

// Detection thresholds
const FREQUENCY_TOLERANCE = 45;
const SIGNAL_THRESHOLD = 135; // fixed threshold — adaptive was causing false triggers

// ── Weighted frequency estimation ─────────────────────────────────────────────
// Parabolic interpolation on peak bin ± 1 for sub-bin frequency accuracy.
// Reduces character misidentification from FFT bin quantization.
function weightedPeakFrequency(
  data: Uint8Array,
  peakBin: number,
  sampleRate: number
): number {
  const binWidth = sampleRate / (data.length * 2);
  if (peakBin <= 0 || peakBin >= data.length - 1) {
    return peakBin * binWidth;
  }
  const alpha = data[peakBin - 1];
  const beta  = data[peakBin];
  const gamma = data[peakBin + 1];
  // Parabolic interpolation: offset = 0.5 * (alpha - gamma) / (alpha - 2*beta + gamma)
  const denom = alpha - 2 * beta + gamma;
  const offset = denom !== 0 ? 0.5 * (alpha - gamma) / denom : 0;
  return (peakBin + offset) * binWidth;
}

// ── Parity / checksum ─────────────────────────────────────────────────────────
// A single check character is appended to each transmitted message.
// It's the XOR of all character codes mod 26, mapped to A-Z.
// The decoder strips it and verifies — if mismatch, flags the message.

export function computeCheckChar(text: string): string {
  let xor = 0;
  for (let i = 0; i < text.length; i++) {
    xor ^= text.charCodeAt(i);
  }
  // Map to A-Z (26 values)
  return String.fromCharCode(65 + (xor % 26));
}

export function verifyAndStrip(text: string): { message: string; valid: boolean } {
  if (text.length < 2) return { message: text, valid: false };
  const body = text.slice(0, -1);
  const check = text.slice(-1);
  const expected = computeCheckChar(body);
  return { message: body, valid: check === expected };
}

// ── Standard mode frequency map ───────────────────────────────────────────────
export const CHAR_FREQUENCIES: { [char: string]: number } = {
  ' ': 900,
  '!': 1300, '@': 1400, '#': 1500, '$': 1600, '%': 1700, '^': 1800,
  '&': 1900, '*': 2000, '(': 2100, ')': 2200, '-': 2300, '_': 2400,
  '+': 2600, '=': 2800, '{': 2900, '}': 3000, '[': 3100, ']': 3200,
  '|': 3300, '\\': 3400, ':': 3500, ';': 3600, '"': 3700, "'": 3800,
  '<': 3900, '>': 4000, ',': 4100, '.': 4200, '/': 4300, '?': 4400,
  '`': 4500, '~': 4600,
  '0': 4700, '1': 4800, '2': 4900, '3': 5000, '4': 5100,
  '5': 5200, '6': 5300, '7': 5400, '8': 5500, '9': 5600,
  'A': 5700, 'B': 5800, 'C': 5900, 'D': 6000, 'E': 6100, 'F': 6200,
  'G': 6300, 'H': 6400, 'I': 6500, 'J': 6600, 'K': 6700, 'L': 6800,
  'M': 6900, 'N': 7000, 'O': 7100, 'P': 7200, 'Q': 7300, 'R': 7400,
  'S': 7500, 'T': 7600, 'U': 7700, 'V': 7800, 'W': 7900, 'X': 8000,
  'Y': 8100, 'Z': 8200,
};

// ── Codec mode ────────────────────────────────────────────────────────────────
// 'standard' = original FSK (900–8200Hz, full character set, loud)
// 'soft'     = musical scale (220–1760Hz, A-Z + 0-9 only, quiet & pleasant)

export type CodecMode = 'standard' | 'soft' | 'ultrasound' | 'reliable';
let _codecMode: CodecMode = 'standard';

export const setCodecMode = (mode: CodecMode) => {
  _codecMode = mode;
  console.log(`Codec mode set to: ${mode}`);
};

export const getCodecMode = (): CodecMode => _codecMode;

// ── Soft mode frequency map ───────────────────────────────────────────────────
// 36 characters (A-Z, 0-9) mapped to equal-temperament semitones from A3 (220Hz)
// Each semitone = ×2^(1/12) ≈ ×1.05946
// 36 steps across 3 octaves: 220Hz → ~1760Hz
// Sounds like a xylophone/steel drum — pleasant, low-frequency, reliable on cheap speakers

const _buildSoftFrequencies = (): { [char: string]: number } => {
  const map: { [char: string]: number } = {};
  // Linear spacing: 300–1992Hz, 47Hz per step, 37 slots (space + A-Z + 0-9)
  // All within the reliable 300–2000Hz range, 47Hz gap → 18Hz tolerance = 38% of gap (safe)
  const chars = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const base = 300;
  const step = 47;
  for (let i = 0; i < chars.length; i++) {
    map[chars[i]] = base + i * step;
  }
  return map;
};

export const SOFT_FREQUENCIES: { [char: string]: number } = _buildSoftFrequencies();

// Soft mode markers — use same as standard for maximum compatibility
// The receiver distinguishes modes by which frequency map matches the characters
export const SOFT_START_FREQUENCY = START_FREQUENCY; // 2500Hz
export const SOFT_END_FREQUENCY   = END_FREQUENCY;   // 2700Hz

// Active frequency map and markers — switch based on mode
// Reliable mode uses standard frequencies but with much more conservative timing
const activeFrequencies  = () => _codecMode === 'soft' ? SOFT_FREQUENCIES  : CHAR_FREQUENCIES;
const activeStartFreq    = () => _codecMode === 'soft' ? SOFT_START_FREQUENCY : START_FREQUENCY;
const activeEndFreq      = () => _codecMode === 'soft' ? SOFT_END_FREQUENCY   : END_FREQUENCY;
const activeVolume       = () => _codecMode === 'soft' ? 0.7 : VOLUME;
const activeMinFreq      = () => _codecMode === 'soft' ? 250 : MINIMUM_VALID_FREQUENCY;
const activeMaxFreq      = () => _codecMode === 'soft' ? 2300 : MAXIMUM_VALID_FREQUENCY;
const activeFreqTolerance = () => _codecMode === 'soft' ? 20 : FREQUENCY_TOLERANCE;
const activeAttackTime   = () => _codecMode === 'soft' ? 0.015 : _codecMode === 'reliable' ? 0.008 : 0.004;
const activeReleaseTime  = () => _codecMode === 'soft' ? 0.020 : _codecMode === 'reliable' ? 0.010 : 0.004;

// ── Reliable mode timing overrides ────────────────────────────────────────────
// Reliable mode ignores speed multiplier and uses very conservative timing
const RELIABLE_CHAR_DURATION = 0.15;   // 150ms per tone (vs 70ms standard)
const RELIABLE_CHAR_GAP      = 0.08;   // 80ms gap (vs 30ms standard)
const RELIABLE_MARKER_DURATION = 0.20; // 200ms markers (vs 120ms standard)
const RELIABLE_INITIAL_DELAY   = 0.06; // 60ms delays (vs 30ms standard)

// Override scaled timing when in reliable mode
const effectiveCharDuration   = () => _codecMode === 'reliable' ? RELIABLE_CHAR_DURATION : scaledCharDuration();
const effectiveCharGap        = () => _codecMode === 'reliable' ? RELIABLE_CHAR_GAP : scaledCharGap();
const effectiveMarkerDuration = () => _codecMode === 'reliable' ? RELIABLE_MARKER_DURATION : scaledMarkerDuration();
const effectiveInitialDelay   = () => _codecMode === 'reliable' ? RELIABLE_INITIAL_DELAY : 0.03 / _speedMultiplier;

export const getSoftModeCharset = () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';

// ── Ultrasound mode ───────────────────────────────────────────────────────────
// 2-FSK binary encoding: UTF-8 bytes → bits → near-ultrasound tones
// Full UTF-8 support (any character, emoji, etc.)
// Frequencies chosen to be at/above typical human hearing threshold (~18kHz)

export const ULTRA_MARK_FREQ  = 18500; // Hz — bit 1
export const ULTRA_SPACE_FREQ = 19500; // Hz — bit 0
export const ULTRA_START_FREQ = 17500; // Hz — start marker (below data range)
export const ULTRA_END_FREQ   = 20500; // Hz — end marker (above data range)
export const ULTRA_BIT_DURATION = 0.035; // seconds per bit (35ms)
export const ULTRA_BIT_GAP     = 0.005; // seconds gap between bits
export const ULTRA_MARKER_DURATION = 0.08; // seconds for start/end markers
export const ULTRA_FREQ_TOLERANCE  = 400; // Hz — wide enough for FFT bin resolution
export const ULTRA_SIGNAL_THRESHOLD = 80; // lower threshold — ultrasound is quieter on most speakers

/** Convert a string to a flat array of bits (UTF-8, MSB first per byte) */
export function textToBits(text: string): number[] {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const bits: number[] = [];
  for (const byte of bytes) {
    for (let b = 7; b >= 0; b--) {
      bits.push((byte >> b) & 1);
    }
  }
  return bits;
}

/** Convert a flat array of bits back to a string (UTF-8, MSB first per byte) */
export function bitsToText(bits: number[]): string {
  // Pad to multiple of 8
  while (bits.length % 8 !== 0) bits.push(0);
  const bytes = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bytes.length; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      byte = (byte << 1) | (bits[i * 8 + b] ?? 0);
    }
    bytes[i] = byte;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Fallback: decode ignoring errors
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/**
 * Encode text as ultrasound 2-FSK binary transmission
 * Full UTF-8 support — any character, emoji, etc.
 */
export const encodeUltrasound = async (
  text: string,
  audioContext: AudioContext
): Promise<void> => {
  return new Promise(async (resolve) => {
    try {
      const isReady = await ensureAudioContextReady(audioContext);
      if (!isReady) { resolve(); return; }

      const bits = textToBits(text);
      const speed = _speedMultiplier;
      const bitDur = ULTRA_BIT_DURATION / speed;
      const bitGap = ULTRA_BIT_GAP / speed;
      const markerDur = ULTRA_MARKER_DURATION / speed;
      const vol = 0.6; // slightly louder than soft mode — ultrasound attenuates quickly

      let t = audioContext.currentTime + 0.03;

      // Start marker
      const startOsc = audioContext.createOscillator();
      const startGain = audioContext.createGain();
      startOsc.type = 'sine';
      startOsc.frequency.value = ULTRA_START_FREQ;
      startGain.gain.setValueAtTime(0, t);
      startGain.gain.linearRampToValueAtTime(vol, t + 0.005);
      startGain.gain.setValueAtTime(vol, t + markerDur - 0.005);
      startGain.gain.linearRampToValueAtTime(0, t + markerDur);
      startOsc.connect(startGain);
      startGain.connect(audioContext.destination);
      startOsc.start(t);
      startOsc.stop(t + markerDur);
      t += markerDur + 0.01 / speed;

      // Data bits
      for (const bit of bits) {
        const freq = bit === 1 ? ULTRA_MARK_FREQ : ULTRA_SPACE_FREQ;
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const fade = Math.min(0.003, bitDur / 8);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(vol, t + fade);
        gain.gain.setValueAtTime(vol, t + bitDur - fade);
        gain.gain.linearRampToValueAtTime(0, t + bitDur);
        osc.connect(gain);
        gain.connect(audioContext.destination);
        osc.start(t);
        osc.stop(t + bitDur);
        t += bitDur + bitGap;
      }

      t += 0.01 / speed;

      // End marker
      const endOsc = audioContext.createOscillator();
      const endGain = audioContext.createGain();
      endOsc.type = 'sine';
      endOsc.frequency.value = ULTRA_END_FREQ;
      endGain.gain.setValueAtTime(0, t);
      endGain.gain.linearRampToValueAtTime(vol, t + 0.005);
      endGain.gain.setValueAtTime(vol, t + markerDur - 0.005);
      endGain.gain.linearRampToValueAtTime(0, t + markerDur);
      endOsc.connect(endGain);
      endGain.connect(audioContext.destination);
      endOsc.start(t);
      endOsc.stop(t + markerDur);
      t += markerDur;

      const remainingMs = (t - audioContext.currentTime) * 1000;
      logMessage(`Ultrasound TX: ${bits.length} bits, ${text.length} chars, ${remainingMs.toFixed(0)}ms`);

      setTimeout(() => {
        logMessage('Ultrasound transmission complete');
        resolve();
      }, remainingMs + 150);
    } catch (err) {
      console.error('encodeUltrasound error:', err);
      resolve();
    }
  });
};


console.log(`Initialized frequency map for ${Object.keys(CHAR_FREQUENCIES).length} characters`);
console.log('Frequency ranges:');
console.log('- Space: 900 Hz');
console.log('- Special characters: 1300-4600 Hz (100Hz spacing)');
console.log('- Numbers: 4700-5600 Hz (100Hz spacing)');
console.log('- START marker: 2500 Hz');
console.log('- END marker: 2700 Hz');
console.log('- Uppercase letters: 5700-8200 Hz (100Hz spacing)');

// State for decoding
let isReceivingMessage = false;
let messageBuffer: string = ''; // Store characters directly
let startMarkerDetectionCount = 0;
let endMarkerDetectionCount = 0;
let lastDetectedFrequency = 0;
let lastDetectedTime = 0;
let lastDetectedChar = '';
let transmissionStartTime = 0;
let recentCharacters: { char: string, time: number }[] = []; // Track recent character detections
let charFrequencyCounts: Map<string, number> = new Map(); // Count how many times we've seen each character

// Auto-detected mode for the current incoming transmission (independent of _codecMode)
// Allows receiving soft-mode transmissions without manually switching the UI
let _receivingMode: CodecMode = 'standard';

// Helpers that use the receiving mode (not the sending mode) for decoding
const rxFrequencies   = () => _receivingMode === 'soft' ? SOFT_FREQUENCIES  : CHAR_FREQUENCIES;
const rxStartFreq     = () => _receivingMode === 'soft' ? SOFT_START_FREQUENCY : START_FREQUENCY;
const rxEndFreq       = () => _receivingMode === 'soft' ? SOFT_END_FREQUENCY   : END_FREQUENCY;
const rxMinFreq       = () => _receivingMode === 'soft' ? 250 : MINIMUM_VALID_FREQUENCY;
const rxMaxFreq       = () => _receivingMode === 'soft' ? 2300 : MAXIMUM_VALID_FREQUENCY;
const rxFreqTolerance = () => _receivingMode === 'soft' ? 20 : FREQUENCY_TOLERANCE;

// ── Ultrasound decoder state ──────────────────────────────────────────────────
let _ultraReceiving = false;
let _ultraBits: number[] = [];
let _ultraStartCount = 0;
let _ultraEndCount = 0;
let _ultraLastBitTime = 0;
let _ultraLastBitFreq = 0; // track last bit freq to avoid duplicates

// Log direct to console for better debugging
const logMessage = (msg: string) => {
  if (DEBUG_AUDIO) {
    console.log(`%c${msg}`, 'color: #4a6bff; font-weight: bold;');
  }
};

/**
 * Check if AudioContext is usable and resume if needed
 */
const ensureAudioContextReady = async (audioContext: AudioContext): Promise<boolean> => {
  if (audioContext.state === 'closed') {
    console.error('AudioContext is closed and cannot be used');
    return false;
  }
  
  if (audioContext.state === 'suspended') {
    try {
      console.log('Resuming suspended AudioContext');
      await audioContext.resume();
      return audioContext.state !== 'suspended';
    } catch (error) {
      console.error('Failed to resume AudioContext:', error);
      return false;
    }
  }
  
  return true;
};

/**
 * Play a tone with the given frequency for the specified duration
 * Balanced for better reliability while keeping good speed
 */
const playTone = async (
  audioContext: AudioContext,
  frequency: number,
  duration: number,
  startTime: number,
  volume: number = VOLUME
): Promise<number> => {
  // Ensure the context is ready
  const isReady = await ensureAudioContextReady(audioContext);
  if (!isReady) {
    console.error('Cannot play tone - AudioContext is not ready');
    return startTime; // Return current time without playing
  }
  
  // Create audio nodes for primary tone
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  
  // Balanced fade times for reliability without sacrificing too much speed
  const attack  = Math.min(activeAttackTime(),  duration / 4);
  const release = Math.min(activeReleaseTime(), duration / 4);
  
  gainNode.gain.setValueAtTime(0, startTime);
  gainNode.gain.linearRampToValueAtTime(volume, startTime + attack);
  gainNode.gain.setValueAtTime(volume, startTime + duration - release);
  gainNode.gain.linearRampToValueAtTime(0, startTime + duration);
  
  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  
  oscillator.start(startTime);
  oscillator.stop(startTime + duration);
  
  // Add a parallel secondary tone if enabled (standard mode only — soft mode tones are already distinct)
  if (USE_PARALLEL_TONES && _codecMode === 'standard' && frequency !== START_FREQUENCY && frequency !== END_FREQUENCY) {
    const oscillator2 = audioContext.createOscillator();
    const gainNode2 = audioContext.createGain();
    
    oscillator2.type = 'sine';
    oscillator2.frequency.value = frequency + PARALLEL_TONE_OFFSET;
    
    gainNode2.gain.setValueAtTime(0, startTime);
    gainNode2.gain.linearRampToValueAtTime(PARALLEL_TONE_VOLUME, startTime + attack);
    gainNode2.gain.setValueAtTime(PARALLEL_TONE_VOLUME, startTime + duration - release);
    gainNode2.gain.linearRampToValueAtTime(0, startTime + duration);
    
    oscillator2.connect(gainNode2);
    gainNode2.connect(audioContext.destination);
    
    oscillator2.start(startTime);
    oscillator2.stop(startTime + duration);
  }
  
  return startTime + duration;
};

/**
 * Convert a character to its corresponding frequency
 */
const charToFrequency = (char: string): number => {
  // Always use uppercase for consistent mapping
  const upperChar = char.toUpperCase();
  
  // Return the frequency for this character, or 0 if not supported
  return CHAR_FREQUENCIES[upperChar] || 0;
};

/**
 * Convert a frequency back to the original character
 */
const frequencyToChar = (frequency: number): string | null => {
  const freqMap = activeFrequencies();
  const tol = activeFreqTolerance();
  for (const [char, charFreq] of Object.entries(freqMap)) {
    if (Math.abs(frequency - charFreq) < tol) {
      return char;
    }
  }
  return null;
};

/**
 * Encode text into audio signals
 */
export const encodeText = async (
  text: string,
  audioContext: AudioContext
): Promise<void> => {
  return new Promise(async (resolve, reject) => {
    try {
    // Ensure the audio context is ready
    const isReady = await ensureAudioContextReady(audioContext);
    if (!isReady) {
      console.error('Cannot encode text - AudioContext is not ready');
      resolve();
      return;
    }
    
    // Convert all text to uppercase to match our frequency mapping
    text = text.toUpperCase();
    
    logMessage(`Encoding text: "${text}" using optimized batch character encoding`);
    const startTime = audioContext.currentTime;
    let currentTime = startTime;
    
    // Add a small initial delay
    currentTime += effectiveInitialDelay();
    
    // Play start marker
    logMessage('Playing start marker');
    currentTime = await playTone(
      audioContext,
      activeStartFreq(),
      effectiveMarkerDuration(),
      currentTime,
      activeVolume()
    );
    
    // Add gap after start marker
    currentTime += effectiveInitialDelay();
    
    // OPTIMIZATION: Pre-schedule all character tones at once with batch scheduling
    const characters = text.split('');
    
    // Define the type for our audio nodes
    type AudioNodeSet = {
      char: string;
      frequency: number;
      oscillator: OscillatorNode;
      gainNode: GainNode;
      oscillator2: OscillatorNode | null;
      gainNode2: GainNode | null;
    };
    
    // Create all oscillators and gain nodes first for more efficient scheduling
    const nodes: AudioNodeSet[] = characters
      .map(char => {
        const freqMap = activeFrequencies();
        const frequency = freqMap[char.toUpperCase()] ?? 0;
        
        if (frequency === 0) {
          console.warn(`Skipping unsupported character: '${char}'`);
          return null;
        }
        
        // Create nodes for this character
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        // For parallel tones if enabled (standard mode only)
        let oscillator2: OscillatorNode | null = null;
        let gainNode2: GainNode | null = null;
        
        if (USE_PARALLEL_TONES && _codecMode === 'standard') {
          oscillator2 = audioContext.createOscillator();
          gainNode2 = audioContext.createGain();
          
          oscillator2.type = 'sine';
          oscillator2.frequency.value = frequency + PARALLEL_TONE_OFFSET;
          
          oscillator2.connect(gainNode2);
          gainNode2.connect(audioContext.destination);
        }
        
        return { 
          char, 
          frequency, 
          oscillator, 
          gainNode, 
          oscillator2, 
          gainNode2 
        };
      })
      .filter((node): node is AudioNodeSet => node !== null); // Type-safe filter to remove nulls
    
    // Now schedule all the tones in sequence with optimized timing
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const { char, frequency, oscillator, gainNode, oscillator2, gainNode2 } = node;
      
      // Optimized fade times for faster transmission
      const fadeTime = Math.min(0.005, effectiveCharDuration() / 12);
      const vol = activeVolume();
      
      // Schedule primary tone
      gainNode.gain.setValueAtTime(0, currentTime);
      gainNode.gain.linearRampToValueAtTime(vol, currentTime + fadeTime);
      gainNode.gain.setValueAtTime(vol, currentTime + effectiveCharDuration() - fadeTime);
      gainNode.gain.linearRampToValueAtTime(0, currentTime + effectiveCharDuration());
      
      oscillator.start(currentTime);
      oscillator.stop(currentTime + effectiveCharDuration());
      
      // Schedule parallel tone if enabled
      if (USE_PARALLEL_TONES && oscillator2 && gainNode2) {
        gainNode2.gain.setValueAtTime(0, currentTime);
        gainNode2.gain.linearRampToValueAtTime(PARALLEL_TONE_VOLUME * vol, currentTime + fadeTime);
        gainNode2.gain.setValueAtTime(PARALLEL_TONE_VOLUME * vol, currentTime + effectiveCharDuration() - fadeTime);
        gainNode2.gain.linearRampToValueAtTime(0, currentTime + effectiveCharDuration());
        
        oscillator2.start(currentTime);
        oscillator2.stop(currentTime + effectiveCharDuration());
      }
      
      // Display scheduling status periodically
      if (i % 5 === 0 || i === nodes.length - 1) {
        console.log(`Scheduling character '${char}' at ${frequency}Hz at time ${currentTime.toFixed(3)}`);
      }
      
      // Update the time for the next character
      currentTime += effectiveCharDuration() + effectiveCharGap();
    }
    
    // Add pause before end marker
    currentTime += effectiveInitialDelay();
    
    // Play end marker
    logMessage('Playing end marker');
    currentTime = await playTone(
      audioContext,
      activeEndFreq(),
      effectiveMarkerDuration(),
      currentTime,
      activeVolume()
    );
    
    const totalDuration = (currentTime - startTime) * 1000;
    const charsPerSecond = text.length / ((totalDuration) / 1000);
    logMessage(`Transmission complete, duration: ${totalDuration.toFixed(0)}ms, speed: ${charsPerSecond.toFixed(1)} chars/sec`);
    
    // Wait until all scheduled audio has finished playing
    // remainingMs = time from NOW until the last tone ends
    const remainingMs = (currentTime - audioContext.currentTime) * 1000;
    const endBuffer = Math.max(150, remainingMs * 0.05);
    logMessage(`Waiting ${Math.round(remainingMs + endBuffer)}ms for audio to complete...`);
    
    setTimeout(() => {
      logMessage('Transmission fully complete');
      resolve();
    }, remainingMs + endBuffer);
    } catch (err) {
      console.error('encodeText error:', err);
      resolve(); // always resolve so transmitMessage's finally block runs
    }
  });
};

/**
 * Enhanced character deduplication and filtering system
 * Balanced for optimal speed and accuracy
 */
const shouldAddCharacter = (char: string): boolean => {
  const now = Date.now();
  
  // Clean up old character detections — window scales with speed
  recentCharacters = recentCharacters.filter(entry => (now - entry.time) < scaledRecentWindow());
  
  // Strategy 1: Time-based debounce with speed-scaled lockout
  for (const entry of recentCharacters) {
    if (entry.char === char && (now - entry.time) < scaledLockout()) {
      console.log(`Rejecting duplicate '${char}' - detected ${now - entry.time}ms ago`);
      return false;
    }
  }
  
  // Strategy 2: Check for unusual frequency - balanced approach
  let consecutiveCount = 0;
  const recentCharsToCheck = Math.min(recentCharacters.length, 4); // Check more characters for better accuracy
  
  for (let i = recentCharacters.length - 1; i >= recentCharacters.length - recentCharsToCheck; i--) {
    if (i < 0) break; // Safety check
    if (recentCharacters[i].char === char) {
      consecutiveCount++;
      // Only filter consecutive identical characters (except space and common letters) 
      if (consecutiveCount >= 3 && char !== ' ' && !isCommonRepeatingChar(char)) {
        console.log(`Rejecting unusual frequency of character '${char}'`);
        return false;
      }
    } else {
      break;
    }
  }
  
  // Special treatment for tricky punctuation/special characters
  // Balance between speed and accuracy
  if (char.match(/[-_+=$&@#%^*(){}[\]|\\:;"'<>,.?/]/)) {
    // More careful with special characters
    for (const entry of recentCharacters) {
      if (entry.char === char && (now - entry.time) < Math.max(80, Math.round(350 / _speedMultiplier))) {
        console.log(`Rejecting duplicate special character '${char}'`);
        return false;
      }
    }
  }
  
  // Add this character to our recent detections
  recentCharacters.push({ char, time: now });
  return true; // Not a duplicate based on our strategies
};

/**
 * Helper function to identify characters that commonly repeat in text
 */
const isCommonRepeatingChar = (char: string): boolean => {
  // Allow repeats for letters that commonly repeat: E, L, O, T, etc.
  return ['E', 'L', 'O', 'T', 'M', 'S', 'P', 'A'].includes(char);
};

/**
 * Process received message to improve accuracy
 * Applies various rules to clean up the message
 */
const postProcessMessage = (message: string): string => {
  return message;
};

/**
 * Detect signature patterns and decode frequencies to text
 */
export const decodeAudio = (
  frequencyData: Uint8Array,
  sampleRate: number
): string | null => {
  try {
    // Find the dominant frequency with a simple algorithm
    let maxBin = 0;
    let maxValue = 0;
    
    for (let i = 0; i < frequencyData.length; i++) {
      if (frequencyData[i] > maxValue) {
        maxValue = frequencyData[i];
        maxBin = i;
      }
    }
    
    // If no significant audio or below threshold, return null
    if (maxValue < SIGNAL_THRESHOLD) return null;
    
    // Weighted frequency estimation — parabolic interpolation for sub-bin accuracy
    const binFrequency = weightedPeakFrequency(frequencyData, maxBin, sampleRate);
    
    // Filter: accept anything in either mode's range (100Hz–8300Hz covers both)
    // Also accept ultrasound range (17000–21000Hz)
    const inAudioRange = binFrequency >= 100 && binFrequency <= MAXIMUM_VALID_FREQUENCY;
    const inUltraRange = binFrequency >= 17000 && binFrequency <= 21000;
    if (!inAudioRange && !inUltraRange) {
      return null;
    }
    
    // Current time (approximation based on audio buffer frame)
    const currentTime = Date.now();
    
    // Debounce: if we see the SAME frequency again within the debounce window, skip it.
    // But if the frequency CHANGED, accept it immediately — it's a new character.
    const freqChanged = Math.abs(binFrequency - lastDetectedFrequency) > 30;
    if (!freqChanged && currentTime - lastDetectedTime < scaledDebounce()) {
      return null;
    }
    
    lastDetectedFrequency = binFrequency;
    lastDetectedTime = currentTime;
    
    // Check for timeout
    if (isReceivingMessage && (currentTime - transmissionStartTime > 15000)) {
      console.log('⚠️ TRANSMISSION TIMEOUT - Force ending after 15 seconds');
      const message = messageBuffer;
      isReceivingMessage = false;
      messageBuffer = '';
      charFrequencyCounts.clear();
      if (message.length > 0) return "[STREAM_END] " + message + " (timeout)";
      return "[STREAM_END] (timeout)";
    }

    // Ultrasound timeout — if no bits received for 5s, abort
    if (_ultraReceiving && _ultraLastBitTime > 0 && (currentTime - _ultraLastBitTime > 5000)) {
      console.log('⚠️ ULTRASOUND TIMEOUT - No bits received for 5s');
      _ultraReceiving = false;
      const bitsCopy = [..._ultraBits];
      _ultraBits = [];
      if (bitsCopy.length >= 8) {
        const partial = bitsToText(bitsCopy);
        if (partial.trim()) return '[STREAM_END] ' + partial + ' (timeout)';
      }
      return '[STREAM_END] (timeout)';
    }
    
    // ── Ultrasound 2-FSK decoder ─────────────────────────────────────────────
    // Detect start marker at 17500Hz, then decode bits as MARK(18500)/SPACE(19500)

    // Only check for ultrasound start when not already in any receive mode
    if (!isReceivingMessage && !_ultraReceiving) {
      if (Math.abs(binFrequency - ULTRA_START_FREQ) < ULTRA_FREQ_TOLERANCE &&
          maxValue > ULTRA_SIGNAL_THRESHOLD) {
        _ultraStartCount++;
        if (_ultraStartCount >= 2) {
          _ultraReceiving = true;
          _ultraBits = [];
          _ultraStartCount = 0;
          _ultraLastBitTime = currentTime;
          _ultraLastBitFreq = 0;
          _receivingMode = 'ultrasound' as CodecMode;
          console.log('***** ULTRASOUND START MARKER DETECTED *****');
          return '[STREAM_START]';
        }
        return null;
      } else {
        _ultraStartCount = 0;
      }
    }

    // Ultrasound bit decoding (while receiving)
    if (_ultraReceiving) {
      // End marker
      if (Math.abs(binFrequency - ULTRA_END_FREQ) < ULTRA_FREQ_TOLERANCE &&
          maxValue > ULTRA_SIGNAL_THRESHOLD) {
        _ultraEndCount++;
        if (_ultraEndCount >= 2) {
          _ultraReceiving = false;
          _ultraEndCount = 0;
          const bitsCopy = [..._ultraBits];
          const bitCount = bitsCopy.length;
          _ultraBits = [];
          const decoded = bitsToText(bitsCopy);
          console.log(`Ultrasound decoded: "${decoded}" (${bitCount} bits → ${Math.floor(bitCount / 8)} bytes)`);
          if (decoded.trim()) return '[STREAM_END] ' + decoded;
          return '[STREAM_END]';
        }
        return null;
      }
      _ultraEndCount = 0;

      // Bit detection — MARK (18500Hz) = 1, SPACE (19500Hz) = 0
      const isMark  = Math.abs(binFrequency - ULTRA_MARK_FREQ)  < ULTRA_FREQ_TOLERANCE;
      const isSpace = Math.abs(binFrequency - ULTRA_SPACE_FREQ) < ULTRA_FREQ_TOLERANCE;

      if ((isMark || isSpace) && maxValue > ULTRA_SIGNAL_THRESHOLD) {
        const bitDurMs = (ULTRA_BIT_DURATION / _speedMultiplier) * 1000;
        const timeSinceLast = currentTime - _ultraLastBitTime;

        // Debounce: accept a new bit only after 70% of a bit duration has elapsed
        // This prevents the same tone being counted multiple times across FFT frames
        if (timeSinceLast > bitDurMs * 0.70) {
          const bit = isMark ? 1 : 0;
          _ultraBits.push(bit);
          _ultraLastBitTime = currentTime;
          _ultraLastBitFreq = binFrequency;
          console.log(`Ultra bit ${bit} (${binFrequency.toFixed(0)}Hz) — total: ${_ultraBits.length}`);

          // Stream partial decode every 8 bits (1 byte)
          if (_ultraBits.length % 8 === 0) {
            const partial = bitsToText([..._ultraBits]);
            const lastChar = partial[partial.length - 1] ?? '';
            if (lastChar) return '[STREAM]' + lastChar;
          }
        }
      }
      return null;
    }

    // ── Auto-detect start marker (checks BOTH audio modes simultaneously) ──────────
    if (!isReceivingMessage && !_ultraReceiving) {
      // Both soft and standard use the same start marker (2500Hz)
      // Mode is determined by which frequency map the sender is using
      const stdMatch  = Math.abs(binFrequency - START_FREQUENCY) < FREQUENCY_TOLERANCE;

      if (stdMatch && maxValue > SIGNAL_THRESHOLD) {
        startMarkerDetectionCount++;
        console.log(`Potential start marker detected (${startMarkerDetectionCount}/2), freq: ${binFrequency.toFixed(0)}Hz, strength: ${maxValue}`);

        if (startMarkerDetectionCount >= 2) {
          // Default to standard; will auto-switch to soft if first char is in soft range
          _receivingMode = 'standard';
          console.log(`***** DETECTED START MARKER *****`);
          isReceivingMessage = true;
          messageBuffer = '';
          transmissionStartTime = currentTime;
          startMarkerDetectionCount = 0;
          recentCharacters = [];
          charFrequencyCounts.clear();
          return "[STREAM_START]";
        }
        return null;
      } else {
        startMarkerDetectionCount = 0;
      }
    }
    
    // ── End marker (uses rx mode detected at start) ───────────────────────────
    if (isReceivingMessage && 
        Math.abs(binFrequency - rxEndFreq()) < rxFreqTolerance() * 1.5 && 
        maxValue > SIGNAL_THRESHOLD) {
      
      endMarkerDetectionCount++;
      console.log(`Potential end marker detected (${endMarkerDetectionCount}/2), freq: ${binFrequency.toFixed(0)}Hz`);
      
      if (endMarkerDetectionCount >= 2) {
        console.log('***** DETECTED END MARKER *****');
        const message = messageBuffer;
        isReceivingMessage = false;
        messageBuffer = '';
        endMarkerDetectionCount = 0;
        recentCharacters = [];
        charFrequencyCounts.clear();
        const processedMessage = postProcessMessage(message);
        if (processedMessage.length > 0) {
          console.log(`Decoded message: "${processedMessage}"`);
          return "[STREAM_END] " + processedMessage;
        }
        return "[STREAM_END]";
      }
      return null;
    } else if (isReceivingMessage) {
      endMarkerDetectionCount = 0;
      
      // Try both frequency maps — auto-detect soft mode from first character
      let char: string | null = null;
      
      // Try current rx mode first
      const tol = rxFreqTolerance();
      const freqMap = rxFrequencies();
      for (const [c, f] of Object.entries(freqMap)) {
        if (Math.abs(binFrequency - f) < tol) { char = c; break; }
      }
      
      // If no match in current mode and this is the first character, try the other mode
      if (char === null && messageBuffer.length === 0) {
        const otherMap = _receivingMode === 'standard' ? SOFT_FREQUENCIES : CHAR_FREQUENCIES;
        const otherTol = _receivingMode === 'standard' ? 20 : FREQUENCY_TOLERANCE;
        for (const [c, f] of Object.entries(otherMap)) {
          if (Math.abs(binFrequency - f) < otherTol) {
            char = c;
            // Switch receiving mode
            _receivingMode = _receivingMode === 'standard' ? 'soft' : 'standard';
            console.log(`Auto-switched to ${_receivingMode} mode based on first character '${c}' at ${binFrequency.toFixed(0)}Hz`);
            break;
          }
        }
      }
      
      if (char !== null) {
        const upperChar = char.toUpperCase();
        console.log(`Detected character: '${upperChar}' from frequency ${binFrequency.toFixed(0)}Hz, strength: ${maxValue}`);
        
        if (shouldAddCharacter(upperChar)) {
          console.log(`Adding character '${upperChar}' to message buffer`);
          messageBuffer += upperChar;
          lastDetectedChar = upperChar;
          return "[STREAM]" + upperChar;
        } else {
          console.log(`Filtered out potential duplicate: '${upperChar}'`);
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error in decodeAudio:', error);
    return null;
  }
};

/**
 * Reset the decoder state (useful when starting new listening session)
 */
export const resetDecoder = () => {
  console.log('Decoder reset');
  isReceivingMessage = false;
  messageBuffer = '';
  startMarkerDetectionCount = 0;
  endMarkerDetectionCount = 0;
  lastDetectedFrequency = 0;
  lastDetectedTime = 0;
  lastDetectedChar = '';
  transmissionStartTime = 0;
  recentCharacters = [];
  charFrequencyCounts.clear();
  _receivingMode = 'standard';
  // Ultrasound state
  _ultraReceiving = false;
  _ultraBits = [];
  _ultraStartCount = 0;
  _ultraEndCount = 0;
  _ultraLastBitTime = 0;
  _ultraLastBitFreq = 0;
};