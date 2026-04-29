/** A single frequency event within a transmission */
export interface FrequencyFrame {
  /** Character transmitted, or "START" / "END" for protocol markers */
  label: string;
  /** FSK frequency in Hz */
  frequency: number;
  /** Milliseconds from transmission start */
  offsetMs: number;
}

/** A complete recorded transmission (sent or received) */
export interface TransmissionRecord {
  id: string;
  direction: 'sent' | 'received';
  /** Full message text (finalized on completion) */
  text: string;
  /** Ordered by offsetMs */
  frames: FrequencyFrame[];
  /** Date.now() when record was opened */
  startTimestamp: number;
  /** Total duration in ms; 0 while in-progress */
  durationMs: number;
  finalized: boolean;
}
