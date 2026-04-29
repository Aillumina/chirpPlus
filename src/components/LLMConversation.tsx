import React, { useState, useRef, useEffect, useCallback } from 'react';
import './LLMConversation.css';
import FrequencyVisualizer from './FrequencyVisualizer';
import { encodeText, decodeAudio, resetDecoder, MAXIMUM_VALID_FREQUENCY } from '../utils/audioCodec';
import { pushLog } from '../utils/logger';

type Role = 'emitter' | 'receiver' | null;
type TurnState = 'idle' | 'transmitting' | 'listening' | 'processing' | 'waiting';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  direction: 'sent' | 'received';
}

interface Provider {
  id: string;
  label: string;
  endpoint: string;
  keyPlaceholder: string;
  defaultModel: string;
  models: string[];
  extraHeaders?: Record<string, string>;
  color: string;
  apiFormat: 'openai' | 'gemini'; // request/response shape
}

// Build Gemini endpoint for a given model
const geminiEndpoint = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const PROVIDERS: Provider[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    endpoint: geminiEndpoint('gemini-2.0-flash-lite'),
    keyPlaceholder: 'AIzaSy...',
    defaultModel: 'gemini-2.0-flash-lite',
    models: [
      'gemini-2.0-flash-lite',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b',
      'gemini-1.5-pro',
    ],
    color: '#4285f4',
    apiFormat: 'gemini',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    keyPlaceholder: 'sk-or-v1-...',
    defaultModel: 'openrouter/free',
    models: [
      // Auto-router (picks best free model automatically)
      'openrouter/free',
      // Top free models as of April 2026
      'google/gemma-4-31b-it:free',
      'google/gemma-4-26b-a4b-it:free',
      'google/gemma-3-27b-it:free',
      'google/gemma-3-12b-it:free',
      'google/gemma-3-4b-it:free',
      'google/gemma-3n-e4b-it:free',
      'google/gemma-3n-e2b-it:free',
      'meta-llama/llama-3.3-70b-instruct:free',
      'meta-llama/llama-3.2-3b-instruct:free',
      'openai/gpt-oss-120b:free',
      'openai/gpt-oss-20b:free',
      'qwen/qwen3-coder:free',
      'qwen/qwen3-next-80b-a3b-instruct:free',
      'deepseek/deepseek-r1:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'nvidia/nemotron-3-nano-30b-a3b:free',
      'nvidia/nemotron-nano-12b-v2-vl:free',
      'nvidia/nemotron-nano-9b-v2:free',
      'nousresearch/hermes-3-llama-3.1-405b:free',
      'minimax/minimax-m2.5:free',
      'z-ai/glm-4.5-air:free',
      'arcee-ai/trinity-large-preview:free',
      'arcee-ai/trinity-mini:free',
      'arcee-ai/trinity-large-thinking',
      'liquid/lfm-2.5-1.2b-thinking:free',
      'liquid/lfm-2.5-1.2b-instruct:free',
      'stepfun/step-3.5-flash:free',
      'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
    ],
    extraHeaders: {
      'HTTP-Referer': window.location.origin,
      'X-Title': 'Chirp Acoustic Bridge',
    },
    color: '#7c5cfc',
    apiFormat: 'openai',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    keyPlaceholder: 'sk-...',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
    color: '#10a37f',
    apiFormat: 'openai',
  },
  {
    id: 'anthropic-compat',
    label: 'Anthropic (via OR)',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    keyPlaceholder: 'sk-or-v1-...',
    defaultModel: 'anthropic/claude-3.5-haiku',
    models: ['anthropic/claude-3.5-haiku', 'anthropic/claude-3.5-sonnet', 'anthropic/claude-3-opus'],
    extraHeaders: {
      'HTTP-Referer': window.location.origin,
      'X-Title': 'Chirp Acoustic Bridge',
    },
    color: '#d4a843',
    apiFormat: 'openai',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    endpoint: 'http://localhost:11434/v1/chat/completions',
    keyPlaceholder: 'ollama (no key needed)',
    defaultModel: 'llama3',
    models: ['llama3', 'mistral', 'phi3', 'gemma2'],
    color: '#4a9eff',
    apiFormat: 'openai',
  },
  {
    id: 'custom',
    label: 'Custom',
    endpoint: '',
    keyPlaceholder: 'API key...',
    defaultModel: '',
    models: [],
    color: '#888888',
    apiFormat: 'openai',
  },
];

const STORAGE_KEY = 'chirp_llm_config';

interface SavedConfig {
  providerId: string;
  apiEndpoint: string;
  apiKey: string;
  modelName: string;
  systemPrompt: string;
  firstMessage: string;
  aiFirstMessage: boolean;
}

const loadConfig = (): Partial<SavedConfig> => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
};

const saveConfig = (cfg: SavedConfig) => {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch {}
};

const LLMConversation: React.FC = () => {
  const saved = loadConfig();
  const initialProvider = PROVIDERS.find(p => p.id === saved.providerId) ?? PROVIDERS[0];

  // Role & session state
  const [role, setRole] = useState<Role>(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [turnState, setTurnState] = useState<TurnState>('idle');
  const [messages, setMessages] = useState<Message[]>([]);
  const [statusText, setStatusText] = useState('SELECT ROLE TO BEGIN');
  const [frequencies, setFrequencies] = useState<number[]>([]);

  // Provider + LLM config
  const [providerId, setProviderId] = useState(initialProvider.id);
  const [apiEndpoint, setApiEndpoint] = useState(saved.apiEndpoint ?? initialProvider.endpoint);
  const [apiKey, setApiKey] = useState(saved.apiKey ?? '');
  const [modelName, setModelName] = useState(saved.modelName ?? initialProvider.defaultModel);
  const [systemPrompt, setSystemPrompt] = useState(
    saved.systemPrompt ??
    'You are a concise AI communicating over an audio channel. Keep responses under 80 characters. Use only uppercase letters, numbers, and basic punctuation.'
  );
  const [firstMessage, setFirstMessage] = useState(saved.firstMessage ?? 'HELLO');
  const [aiFirstMessage, setAiFirstMessage] = useState(saved.aiFirstMessage ?? false);
  const [showConfig, setShowConfig] = useState(false);
  const [modelInput, setModelInput] = useState(saved.modelName ?? initialProvider.defaultModel);

  const currentProvider = PROVIDERS.find(p => p.id === providerId) ?? PROVIDERS[0];

  // Persist config whenever it changes
  useEffect(() => {
    saveConfig({ providerId, apiEndpoint, apiKey, modelName, systemPrompt, firstMessage, aiFirstMessage });
  }, [providerId, apiEndpoint, apiKey, modelName, systemPrompt, firstMessage, aiFirstMessage]);

  // When provider changes, update endpoint + default model (but keep key if same provider)
  const handleProviderChange = (id: string) => {
    const p = PROVIDERS.find(pr => pr.id === id) ?? PROVIDERS[0];
    setProviderId(id);
    if (id !== 'custom') {
      setApiEndpoint(p.apiFormat === 'gemini' ? geminiEndpoint(p.defaultModel) : p.endpoint);
      setModelName(p.defaultModel);
      setModelInput(p.defaultModel);
    }
  };

  // When Gemini model changes, keep endpoint in sync
  const handleModelChange = (model: string) => {
    setModelName(model);
    setModelInput(model);
    if (currentProvider.apiFormat === 'gemini') {
      setApiEndpoint(geminiEndpoint(model));
    }
  };

  // Audio refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const isListeningRef = useRef(false);
  const isTransmittingRef = useRef(false);
  const currentStreamRef = useRef('');
  const isStreamingRef = useRef(false);
  const conversationHistoryRef = useRef<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const sessionActiveRef = useRef(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const getTimestamp = () => {
    const now = new Date();
    return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
  };

  const addMessage = useCallback((content: string, direction: 'sent' | 'received') => {
    const msg: Message = {
      role: direction === 'sent' ? 'assistant' : 'user',
      content,
      timestamp: getTimestamp(),
      direction,
    };
    setMessages(prev => [msg, ...prev]);
    conversationHistoryRef.current.push({ role: msg.role, content });
  }, []);

  const getAudioContext = async (): Promise<AudioContext> => {
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }
      return audioContextRef.current;
    }
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    audioContextRef.current = ctx;
    analyserRef.current = ctx.createAnalyser();
    analyserRef.current.fftSize = 2048;
    analyserRef.current.smoothingTimeConstant = 0.3;
    return ctx;
  };

  const startMic = async () => {
    const ctx = await getAudioContext();
    // Always get/reuse the stream
    if (!streamRef.current) {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
    }
    // Always reconnect source → analyser so it's live for each listen session
    if (analyserRef.current) {
      try { analyserRef.current.disconnect(); } catch (_) {}
      const source = ctx.createMediaStreamSource(streamRef.current);
      source.connect(analyserRef.current);
    }
  };

  const stopMic = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
  };

  // Fallback model chain for OpenRouter 429s — tried in order after the selected model fails
  const OPENROUTER_FALLBACKS = [
    'openrouter/free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemma-3-27b-it:free',
    'google/gemma-4-31b-it:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'openai/gpt-oss-20b:free',
    'z-ai/glm-4.5-air:free',
  ];

  // Shared fetch helper — handles both OpenAI-compatible and Gemini API formats
  // Auto-retries on 429 with fallback models for OpenRouter
  const fetchLLM = async (
    turns: { role: 'system' | 'user' | 'assistant'; content: string }[],
    maxTokens: number,
    logPrefix: string
  ): Promise<string> => {
    const provider = PROVIDERS.find(p => p.id === providerId) ?? PROVIDERS[0];
    const isGemini = provider.apiFormat === 'gemini';
    const isOpenRouter = provider.id === 'openrouter';

    // Build the list of models to try: selected model first, then fallbacks (deduped)
    const modelsToTry = isOpenRouter
      ? [modelName, ...OPENROUTER_FALLBACKS.filter(m => m !== modelName)]
      : [modelName];

    let lastError: Error = new Error('No models tried');

    for (let attempt = 0; attempt < modelsToTry.length; attempt++) {
      const currentModel = modelsToTry[attempt];
      if (attempt > 0) {
        pushLog('llm-req', `RETRY ${attempt}/${modelsToTry.length - 1} with fallback: ${currentModel}`);
        setStatusText(`RETRYING WITH ${currentModel.split('/').pop()?.toUpperCase()}...`);
        await new Promise(r => setTimeout(r, 600));
      }

      let endpoint = apiEndpoint;
      let payload: any;
      let headers: Record<string, string> = { 'Content-Type': 'application/json' };

      if (isGemini) {
        endpoint = geminiEndpoint(currentModel);
        headers['X-goog-api-key'] = apiKey;
        const systemTurn = turns.find(t => t.role === 'system');
        const chatTurns = turns.filter(t => t.role !== 'system');
        payload = {
          ...(systemTurn ? { system_instruction: { parts: [{ text: systemTurn.content }] } } : {}),
          contents: chatTurns.map(t => ({
            role: t.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: t.content }],
          })),
          generationConfig: { maxOutputTokens: maxTokens },
        };
      } else {
        headers['Authorization'] = `Bearer ${apiKey}`;
        Object.assign(headers, provider.extraHeaders ?? {});
        payload = { model: currentModel, messages: turns, max_tokens: maxTokens };
      }

      pushLog('llm-req', `${logPrefix} | provider=${provider.label} | model=${currentModel} | format=${provider.apiFormat}`);
      pushLog('llm-req', `POST ${endpoint}`);
      pushLog('llm-req', `PAYLOAD: ${JSON.stringify(payload)}`);
      pushLog('llm-req', `HEADERS: ${JSON.stringify({ ...headers, Authorization: headers.Authorization ? 'Bearer [REDACTED]' : undefined, 'X-goog-api-key': headers['X-goog-api-key'] ? '[REDACTED]' : undefined })}`);

      let res: Response;
      try {
        res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
      } catch (fetchErr) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        pushLog('llm-err', `FETCH FAILED: ${msg}`);
        lastError = fetchErr instanceof Error ? fetchErr : new Error(msg);
        continue; // try next model
      }

      const rawText = await res.text();
      pushLog(res.ok ? 'llm-res' : 'llm-err', `STATUS: ${res.status} ${res.statusText}`);
      pushLog(res.ok ? 'llm-res' : 'llm-err', `BODY: ${rawText}`);

      // On 429 or 503, check if it's an account-level limit (no point retrying other models)
      if (res.status === 429 || res.status === 503) {
        let parsed: any = {};
        try { parsed = JSON.parse(rawText); } catch (_) {}
        const msg: string = parsed?.error?.message ?? '';
        // Account-level daily cap — retrying other models won't help
        if (msg.includes('free-models-per-day') || msg.includes('RateLimit-Remaining') || msg.includes('Add') && msg.includes('credits')) {
          pushLog('llm-err', `ACCOUNT RATE LIMIT HIT: ${msg}`);
          throw new Error(`DAILY FREE LIMIT REACHED — add credits at openrouter.ai or switch provider`);
        }
        lastError = new Error(`${res.status} on ${currentModel}`);
        continue;
      }

      if (!res.ok) throw new Error(`LLM API ${res.status}: ${rawText}`);

      let data: any;
      try { data = JSON.parse(rawText); }
      catch {
        pushLog('llm-err', `JSON PARSE FAILED: ${rawText}`);
        throw new Error('Invalid JSON from LLM API');
      }

      const reply = isGemini
        ? data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? 'ERROR'
        : (data.choices?.[0]?.message?.content?.trim() ||
           // Some thinking models return content:null with reasoning only — extract last sentence of reasoning
           (() => {
             const reasoning = data.choices?.[0]?.message?.reasoning as string | undefined;
             if (!reasoning) return 'ERROR';
             // Grab the last meaningful sentence from the reasoning trace
             const sentences = reasoning.split(/[.!?]+/).map((s: string) => s.trim()).filter(Boolean);
             const last = sentences[sentences.length - 1] ?? 'HELLO';
             pushLog('llm-res', `content was null, extracted from reasoning: "${last}"`);
             return last;
           })());

      pushLog('llm-res', `REPLY: "${reply}"`);
      return reply.toUpperCase().replace(/[^\x20-\x7E]/g, '').substring(0, 120);
    }

    throw lastError;
  };

  // Call LLM API
  const callLLM = async (receivedText: string): Promise<string> => {
    setStatusText('PROCESSING WITH LLM...');
    setTurnState('processing');
    return fetchLLM(
      [
        { role: 'system', content: systemPrompt },
        ...conversationHistoryRef.current,
        { role: 'user', content: receivedText },
      ],
      300,
      `REPLY | user="${receivedText}"`
    );
  };

  // Generate the very first message via LLM (no prior context)
  const callLLMOpener = async (): Promise<string> => {
    setStatusText('AI GENERATING OPENER...');
    setTurnState('processing');
    return fetchLLM(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Start the conversation. Reply with ONLY your opening message, no thinking or explanation.' },
      ],
      200,
      'OPENER'
    );
  };

  const transmit = async (text: string) => {    setTurnState('transmitting');
    setStatusText(`TRANSMITTING: ${text}`);
    isTransmittingRef.current = true;
    const ctx = await getAudioContext();
    await encodeText(text, ctx);
    isTransmittingRef.current = false;
    addMessage(text, 'sent');
  };

  const listenForMessage = (): Promise<string> => {
    return new Promise(async (resolve, reject) => {
      // Ensure AudioContext is running — mobile suspends it aggressively
      try {
        const ctx = await getAudioContext();
        if (ctx.state === 'suspended') await ctx.resume();
      } catch (_) {}

      setTurnState('listening');
      setStatusText('LISTENING FOR TRANSMISSION...');
      isListeningRef.current = true;
      resetDecoder();
      currentStreamRef.current = '';
      isStreamingRef.current = false;

      const timeout = setTimeout(() => {
        isListeningRef.current = false;
        // cancel the current tick frame but keep the mic/analyser alive for retry
        if (animFrameRef.current) {
          cancelAnimationFrame(animFrameRef.current);
          animFrameRef.current = null;
        }
        reject(new Error('LISTEN TIMEOUT'));
      }, 30000);

      const tick = () => {
        if (!isListeningRef.current || !sessionActiveRef.current) { clearTimeout(timeout); return; }
        if (!analyserRef.current || !audioContextRef.current) {
          animFrameRef.current = requestAnimationFrame(tick); return;
        }

        const bufferLength = analyserRef.current.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyserRef.current.getByteFrequencyData(dataArray);

        const nyquist = audioContextRef.current.sampleRate / 2;
        const maxBin = Math.ceil((MAXIMUM_VALID_FREQUENCY / nyquist) * dataArray.length);
        setFrequencies(Array.from(dataArray.slice(15, maxBin)));

        const decoded = decodeAudio(dataArray, audioContextRef.current.sampleRate);
        if (decoded) {
          if (decoded === '[STREAM_START]') {
            isStreamingRef.current = true;
            currentStreamRef.current = '';
            setStatusText('RECEIVING...');
          } else if (decoded.startsWith('[STREAM]') && isStreamingRef.current) {
            currentStreamRef.current += decoded.substring(8).replace(/[\x00-\x1F\x7F-\x9F]/g, '');
            setStatusText(`RECEIVING: ${currentStreamRef.current}`);
          } else if (decoded.startsWith('[STREAM_END]')) {
            clearTimeout(timeout);
            isListeningRef.current = false;
            const finalMsg = decoded.length > 12
              ? decoded.substring(12).replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim()
              : currentStreamRef.current;
            resolve(finalMsg || currentStreamRef.current);
            return;
          }
        }
        animFrameRef.current = requestAnimationFrame(tick);
      };
      animFrameRef.current = requestAnimationFrame(tick);
    });
  };

  const runConversationLoop = useCallback(async (initialRole: Role, initialMsg?: string, aiOpener = false) => {
    sessionActiveRef.current = true;
    try { await startMic(); }
    catch (err) {
      setStatusText('MIC ACCESS DENIED');
      setSessionActive(false);
      sessionActiveRef.current = false;
      return;
    }

    let currentRole = initialRole;
    if (currentRole === 'emitter') {
      let opener: string;
      if (aiOpener) {
        try {
          opener = await callLLMOpener();
        } catch (err) {
          setStatusText(`LLM OPENER ERROR: ${err instanceof Error ? err.message : 'UNKNOWN'}`);
          setSessionActive(false);
          sessionActiveRef.current = false;
          return;
        }
      } else {
        opener = initialMsg ?? 'HELLO';
      }
      await transmit(opener);
      currentRole = 'receiver';
    }

    while (sessionActiveRef.current) {
      if (currentRole === 'receiver') {
        let received: string;
        try { received = await listenForMessage(); }
        catch (err) {
          if (sessionActiveRef.current) {
            setStatusText('TIMEOUT — RETRYING...');
            await new Promise(r => setTimeout(r, 500));
            // Reconnect mic source before retrying
            try { await startMic(); } catch (_) {}
            continue;
          }
          break;
        }
        if (!sessionActiveRef.current) break;
        addMessage(received, 'received');

        let reply: string;
        try { reply = await callLLM(received); }
        catch (err) {
          setStatusText(`LLM ERROR: ${err instanceof Error ? err.message : 'UNKNOWN'}`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        if (!sessionActiveRef.current) break;

        setTurnState('waiting');
        setStatusText('PREPARING RESPONSE...');
        await new Promise(r => setTimeout(r, 800));
        await transmit(reply);
        currentRole = 'receiver';
      } else {
        setTurnState('waiting');
        setStatusText('WAITING FOR RESPONSE...');
        await new Promise(r => setTimeout(r, 500));
        currentRole = 'receiver';
      }
    }

    stopMic();
    setTurnState('idle');
    setStatusText('SESSION ENDED');
  }, [addMessage, systemPrompt, apiEndpoint, apiKey, modelName, providerId]);

  const startSession = async () => {
    if (!role) return;
    if (!apiKey && providerId !== 'ollama' && role === 'receiver') {
      setStatusText('API KEY REQUIRED');
      return;
    }
    conversationHistoryRef.current = [];
    setMessages([]);
    setSessionActive(true);
    sessionActiveRef.current = true;
    runConversationLoop(
      role,
      role === 'emitter' && !aiFirstMessage ? firstMessage : undefined,
      role === 'emitter' && aiFirstMessage
    );
  };

  const stopSession = () => {
    sessionActiveRef.current = false;
    isListeningRef.current = false;
    isTransmittingRef.current = false;
    if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
    setSessionActive(false);
    setTurnState('idle');
    setStatusText('SESSION STOPPED');
  };

  useEffect(() => {
    return () => {
      sessionActiveRef.current = false;
      isListeningRef.current = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  const turnStateLabel: Record<TurnState, string> = {
    idle: 'IDLE', transmitting: 'TX', listening: 'RX', processing: 'LLM', waiting: 'WAIT',
  };

  return (
    <div className="llm-conversation-container">
      <div className="llm-title-bar">
        <span>&gt; LLM ACOUSTIC BRIDGE</span>
        <span className={`llm-turn-badge llm-turn-${turnState}`}>{turnStateLabel[turnState]}</span>
      </div>

      {!sessionActive && (
        <div className="llm-setup-panel">
          {/* Role selector */}
          <div className="llm-role-selector">
            <button className={`llm-role-btn ${role === 'emitter' ? 'active' : ''}`} onClick={() => setRole('emitter')}>
              EMITTER
              <span className="llm-role-desc">Sends first message</span>
            </button>
            <div className="llm-role-divider">⇄</div>
            <button className={`llm-role-btn ${role === 'receiver' ? 'active' : ''}`} onClick={() => setRole('receiver')}>
              RECEIVER
              <span className="llm-role-desc">Listens first</span>
            </button>
          </div>

          {role === 'emitter' && (
            <div className="llm-first-msg">
              <div className="llm-first-msg-header">
                <label>INITIAL MESSAGE</label>
                <button
                  className={`llm-ai-opener-toggle ${aiFirstMessage ? 'active' : ''}`}
                  onClick={() => setAiFirstMessage(v => !v)}
                  title="Let the AI generate the opening message"
                >
                  {aiFirstMessage ? '✦ AI OPENER ON' : '✦ AI OPENER'}
                </button>
              </div>
              {aiFirstMessage ? (
                <div className="llm-ai-opener-hint">
                  AI will generate the first message using the system prompt
                </div>
              ) : (
                <input
                  type="text"
                  value={firstMessage}
                  onChange={e => setFirstMessage(e.target.value.toUpperCase())}
                  placeholder="HELLO"
                  maxLength={80}
                />
              )}
            </div>
          )}

          {/* Config toggle */}
          <button className="llm-config-toggle" onClick={() => setShowConfig(v => !v)}>
            {showConfig ? '▲ HIDE CONFIG' : '▼ LLM CONFIG'}
            <span className="llm-config-provider-hint" style={{ color: currentProvider.color }}>
              {currentProvider.label}
            </span>
          </button>

          {showConfig && (
            <div className="llm-config-panel">
              {/* Provider presets */}
              <label>PROVIDER</label>
              <div className="llm-provider-grid">
                {PROVIDERS.map(p => (
                  <button
                    key={p.id}
                    className={`llm-provider-btn ${providerId === p.id ? 'active' : ''}`}
                    style={{ '--provider-color': p.color } as React.CSSProperties}
                    onClick={() => handleProviderChange(p.id)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {/* Endpoint — editable, auto-filled by preset */}
              <label>ENDPOINT</label>
              <input
                type="text"
                value={apiEndpoint}
                onChange={e => { setApiEndpoint(e.target.value); setProviderId('custom'); }}
                placeholder="https://..."
              />

              {/* API Key */}
              <label>API KEY {currentProvider.apiFormat === 'gemini' ? '(X-GOOG-API-KEY)' : '(BEARER)'}</label>
              <div className="llm-key-row">
                <input
                  type="password"
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder={currentProvider.keyPlaceholder}
                  className="llm-key-input"
                />
                {apiKey && (
                  <span className="llm-key-saved">✓ SAVED</span>
                )}
              </div>

              {/* Model — dropdown + free-type */}
              <label>MODEL</label>
              {currentProvider.models.length > 0 ? (
                <div className="llm-model-row">
                  <select
                    className="llm-model-select"
                    value={currentProvider.models.includes(modelName) ? modelName : '__custom__'}
                    onChange={e => {
                      if (e.target.value !== '__custom__') handleModelChange(e.target.value);
                    }}
                  >
                    {currentProvider.models.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                    <option value="__custom__">custom...</option>
                  </select>
                  {(!currentProvider.models.includes(modelName) || modelInput !== modelName) && (
                    <input
                      type="text"
                      className="llm-model-custom"
                      value={modelInput}
                      onChange={e => handleModelChange(e.target.value)}
                      placeholder="model name..."
                    />
                  )}
                </div>
              ) : (
                <input
                  type="text"
                  value={modelInput}
                  onChange={e => handleModelChange(e.target.value)}
                  placeholder="model name..."
                />
              )}

              {/* System prompt */}
              <label>SYSTEM PROMPT</label>
              <textarea
                value={systemPrompt}
                onChange={e => setSystemPrompt(e.target.value)}
                rows={3}
              />

              {/* Extra headers hint for OpenRouter */}
              {currentProvider.extraHeaders && (
                <div className="llm-headers-hint">
                  ✓ {Object.keys(currentProvider.extraHeaders).join(', ')} auto-injected
                </div>
              )}
            </div>
          )}

          <button className="llm-start-btn" onClick={startSession} disabled={!role}>
            INITIALIZE SESSION
          </button>
        </div>
      )}

      {/* Active session */}
      {sessionActive && (
        <>
          <div className="llm-visualizer-wrap">
            <FrequencyVisualizer frequencies={frequencies} transmitMode={turnState === 'transmitting'} />
            <div className={`llm-status-badge llm-status-${turnState}`}>
              {statusText}<span className="llm-cursor">_</span>
            </div>
          </div>

          <div className="llm-messages" ref={messagesContainerRef}>
            {messages.length === 0 && <div className="llm-empty">AWAITING TRANSMISSION...</div>}
            {messages.map((msg, i) => (
              <div key={i} className={`llm-msg llm-msg-${msg.direction}`}>
                <span className="llm-msg-tag">[{msg.timestamp}] {msg.direction === 'sent' ? '[TX]' : '[RX]'}</span>
                <span className="llm-msg-content">{msg.content}</span>
              </div>
            ))}
          </div>

          <button className="llm-stop-btn" onClick={stopSession}>TERMINATE SESSION</button>
        </>
      )}

      {!sessionActive && messages.length > 0 && (
        <div className="llm-messages llm-messages-history">
          <div className="llm-history-label">— SESSION LOG —</div>
          {messages.map((msg, i) => (
            <div key={i} className={`llm-msg llm-msg-${msg.direction}`}>
              <span className="llm-msg-tag">[{msg.timestamp}] {msg.direction === 'sent' ? '[TX]' : '[RX]'}</span>
              <span className="llm-msg-content">{msg.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default LLMConversation;
