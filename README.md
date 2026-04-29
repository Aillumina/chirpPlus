# ChirpEx: Sound-based Data Transfer

> Live at [https://chirpex.vercel.app/](https://chirpex.vercel.app/)

ChirpEx is an extended fork of [Chirp](https://github.com/solst-ice/chirp) that transmits and receives data through sound. It encodes text into audio frequencies played through your speakers and decoded by a microphone in real time.

## What's New in ChirpEx

ChirpEx builds on the original Chirp proof-of-concept with several major additions:

- **4 Codec Modes** — Standard FSK, Soft (musical-scale, pleasant tones), Ultrasound (near-inaudible 18–20 kHz binary FSK with full UTF-8/emoji support), and Reliable (conservative timing for noisy environments).
- **Adjustable Transmission Speed** — 1×, 2×, or 4× speed multiplier (10, 20, or 40 chars/sec) for standard and soft modes.
- **Parity / Checksum Verification** — Every message includes an XOR-based check character; the receiver flags corrupted transmissions automatically.
- **Weighted Peak Frequency Detection** — Parabolic interpolation on FFT bins for sub-bin accuracy, reducing character misidentification.
- **Parallel Tone Transmission** — A secondary tone at +35 Hz offset reinforces each character for better detection at higher speeds.
- **Transmission Recording & Playback** — Every sent/received transmission is recorded frame-by-frame and can be replayed with a visual timeline.
- **LLM Conversation Bridge** — Built-in chat interface supporting Google Gemini, OpenRouter (dozens of free models), OpenAI, Anthropic (via OpenRouter), Ollama (local), and custom endpoints. Messages are transmitted and received acoustically.
- **Admin / Debug Panel** — Filterable, searchable, real-time log viewer with level-based coloring (LOG, INF, WRN, ERR, audio, LLM request/response).
- **Auto-Response Triggers** — Certain received keywords (e.g. `STARTDEMO`) trigger automatic reply sequences for demos.
- **Custom Unifont Monospace Font** — Consistent retro-terminal aesthetic across all UI elements.

## How It Works

1. **Text Encoding** — Each character is mapped to a unique frequency (FSK).
2. **Transmission** — The app plays a start marker, the encoded characters, and an end marker.
3. **Reception** — The app listens for frequencies, detects the start marker, decodes characters, verifies the checksum, and stops at the end marker.
4. **Visualization** — Real-time frequency spectrum shows data being transmitted and received.

## Getting Started

### Prerequisites

- Node.js (version 14 or higher)
- npm or yarn

### Installation

Clone this repository:

```bash
gh repo clone solst-ice/chirp
```

Or:

```bash
git clone https://github.com/solst-ice/chirp.git
```

Install dependencies:

```bash
npm install
```

### Running

```bash
npm run dev
```

Open your browser to the URL shown in the terminal (usually http://localhost:5173).

## Usage

1. Click "Start Listening" to begin capturing audio
2. Type a message in the text box
3. Click "Transmit Message" to send it as sound
4. Received messages appear in the messages section
5. Switch to the LLM tab to have an AI conversation over sound
6. Use the Admin tab to inspect logs and debug audio events

## Notes

- Best results in a quiet environment
- Browser will ask for microphone permission
- Both sender and receiver must use the same codec mode and speed setting

## Technologies Used

- React + TypeScript
- Vite
- Web Audio API (FFT analysis, oscillator synthesis)

---

## Frequency-to-Character Tables

### Standard Mode (900–8200 Hz)

Full character set with 100 Hz spacing. Start marker: 2500 Hz, End marker: 2700 Hz.

| Char | Freq (Hz) | | Char | Freq (Hz) | | Char | Freq (Hz) | | Char | Freq (Hz) |
|------|----------:|-|------|----------:|-|------|----------:|-|------|----------:|
| ` ` (space) | 900 | | `!` | 1300 | | `@` | 1400 | | `#` | 1500 |
| `$` | 1600 | | `%` | 1700 | | `^` | 1800 | | `&` | 1900 |
| `*` | 2000 | | `(` | 2100 | | `)` | 2200 | | `-` | 2300 |
| `_` | 2400 | | `+` | 2600 | | `=` | 2800 | | `{` | 2900 |
| `}` | 3000 | | `[` | 3100 | | `]` | 3200 | | `\|` | 3300 |
| `\` | 3400 | | `:` | 3500 | | `;` | 3600 | | `"` | 3700 |
| `'` | 3800 | | `<` | 3900 | | `>` | 4000 | | `,` | 4100 |
| `.` | 4200 | | `/` | 4300 | | `?` | 4400 | | `` ` `` | 4500 |
| `~` | 4600 | | `0` | 4700 | | `1` | 4800 | | `2` | 4900 |
| `3` | 5000 | | `4` | 5100 | | `5` | 5200 | | `6` | 5300 |
| `7` | 5400 | | `8` | 5500 | | `9` | 5600 | | `A` | 5700 |
| `B` | 5800 | | `C` | 5900 | | `D` | 6000 | | `E` | 6100 |
| `F` | 6200 | | `G` | 6300 | | `H` | 6400 | | `I` | 6500 |
| `J` | 6600 | | `K` | 6700 | | `L` | 6800 | | `M` | 6900 |
| `N` | 7000 | | `O` | 7100 | | `P` | 7200 | | `Q` | 7300 |
| `R` | 7400 | | `S` | 7500 | | `T` | 7600 | | `U` | 7700 |
| `V` | 7800 | | `W` | 7900 | | `X` | 8000 | | `Y` | 8100 |
| `Z` | 8200 | | | | | | | | | |

### Soft Mode (300–1992 Hz)

37 characters (space + A–Z + 0–9) with linear 47 Hz spacing. Pleasant, low-frequency tones. Start/End markers same as standard (2500/2700 Hz).

| Char | Freq (Hz) | | Char | Freq (Hz) | | Char | Freq (Hz) | | Char | Freq (Hz) |
|------|----------:|-|------|----------:|-|------|----------:|-|------|----------:|
| ` ` (space) | 300 | | `A` | 347 | | `B` | 394 | | `C` | 441 |
| `D` | 488 | | `E` | 535 | | `F` | 582 | | `G` | 629 |
| `H` | 676 | | `I` | 723 | | `J` | 770 | | `K` | 817 |
| `L` | 864 | | `M` | 911 | | `N` | 958 | | `O` | 1005 |
| `P` | 1052 | | `Q` | 1099 | | `R` | 1146 | | `S` | 1193 |
| `T` | 1240 | | `U` | 1287 | | `V` | 1334 | | `W` | 1381 |
| `X` | 1428 | | `Y` | 1475 | | `Z` | 1522 | | `0` | 1569 |
| `1` | 1616 | | `2` | 1663 | | `3` | 1710 | | `4` | 1757 |
| `5` | 1804 | | `6` | 1851 | | `7` | 1898 | | `8` | 1945 |
| `9` | 1992 | | | | | | | | | |

### Ultrasound Mode (17.5–20.5 kHz)

Binary 2-FSK encoding. Text is converted to UTF-8 bytes, then to individual bits. Supports any character including emoji.

| Signal | Freq (Hz) |
|--------|----------:|
| Start marker | 17,500 |
| Bit 1 (mark) | 18,500 |
| Bit 0 (space) | 19,500 |
| End marker | 20,500 |

Bit duration: 35 ms, bit gap: 5 ms, marker duration: 80 ms.

### Reliable Mode

Uses the same frequency table as Standard mode but with much more conservative timing for noisy or difficult environments:

| Parameter | Standard | Reliable |
|-----------|----------|----------|
| Char duration | 85 ms | 150 ms |
| Char gap | 40 ms | 80 ms |
| Marker duration | 150 ms | 200 ms |
| Initial delay | 30 ms | 60 ms |
