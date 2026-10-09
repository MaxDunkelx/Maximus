const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export function createVoiceController() {
  const supported = typeof SpeechRecognition === 'function' && 'speechSynthesis' in window;
  let recognition = null;
  let listening = false;
  let handsFree = false;
  let speaking = false;
  let speakGeneration = 0;
  let usingLocal = false;
  let localRetry = false;
  let recovering = false;
  let sentinel = false;

  function haltSpeech() {
    speakGeneration += 1;
    window.speechSynthesis?.cancel();
  }

  function ensureRecognition() {
    if (!supported) return null;
    if (recognition) return recognition;
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = speechLanguage();
    return recognition;
  }

  return {
    supported,
    listen(handlers, options = {}) {
      handsFree = Boolean(options.handsFree);
      sentinel = Boolean(options.sentinel);
      haltSpeech();
      const engine = ensureRecognition();
      if (!engine) {
        handlers.onError('This browser cannot use the microphone. Type a message instead.');
        return;
      }
      engine.continuous = sentinel;
      bind(engine, handlers);
      if (listening) {
        if (sentinel) return;
        engine.stop();
        return;
      }
      listening = true;
      handlers.onState('listening');
      void begin(engine, handlers);
    },
    stop() {
      handsFree = false;
      sentinel = false;
      listening = false;
      recognition?.stop();
      haltSpeech();
    },
    speak(text, onEnd) {
      if (!text.trim() || !('speechSynthesis' in window)) {
        onEnd?.();
        return;
      }
      haltSpeech();
      const generation = ++speakGeneration;
      recognition?.stop();
      listening = false;
      const play = () => {
        if (generation !== speakGeneration) return;
        window.speechSynthesis.resume();
        const utterance = new SpeechSynthesisUtterance(text);
        const voice = pickVoice();
        if (voice) utterance.voice = voice;
        utterance.rate = 1;
        utterance.pitch = 1;
        utterance.onstart = () => {
          speaking = true;
        };
        utterance.onend = () => {
          speaking = false;
          if (generation === speakGeneration) onEnd?.();
        };
        utterance.onerror = () => {
          speaking = false;
          if (generation === speakGeneration) onEnd?.();
        };
        window.speechSynthesis.speak(utterance);
      };
      if (window.speechSynthesis.getVoices().length) {
        play();
        return;
      }
      let started = false;
      const startOnce = () => {
        if (started) return;
        started = true;
        window.speechSynthesis.removeEventListener('voiceschanged', startOnce);
        play();
      };
      window.speechSynthesis.addEventListener('voiceschanged', startOnce);
      window.setTimeout(startOnce, 400);
    },
    setHandsFree(value) {
      handsFree = value;
      if (!value) recognition?.stop();
    },
  };

  function bind(engine, handlers) {
    engine.onresult = (event) => {
      let finalText = '';
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript?.trim() ?? '';
        if (result?.isFinal) finalText = `${finalText} ${transcript}`.trim();
        else interim = `${interim} ${transcript}`.trim();
      }
      handlers.onInterim(interim);
      if (finalText) handlers.onFinal(finalText);
    };
    engine.onerror = (event) => {
      if (event.error === 'aborted') {
        listening = false;
        handlers.onState('idle');
        return;
      }
      if (event.error === 'no-speech') {
        listening = false;
        handlers.onState('idle');
        if (handsFree && !sentinel) handlers.onResume?.();
        return;
      }
      if (event.error === 'network' && !usingLocal && !localRetry) {
        localRetry = true;
        recovering = true;
        void recoverLocally(engine, handlers);
        return;
      }
      listening = false;
      handlers.onError(recognitionMessage(event.error, usingLocal));
    };
    engine.onend = () => {
      listening = false;
      if (!speaking && !recovering) handlers.onState('idle');
      if (sentinel && !recovering) handlers.onResume?.();
    };
  }

  async function begin(engine, handlers) {
    const mode = await chooseRecognition(engine, handlers);
    if (!listening) return;
    usingLocal = mode === 'local';
    try {
      engine.start();
    } catch {
      listening = false;
      handlers.onError('The microphone is already in use.');
    }
  }

  async function recoverLocally(engine, handlers) {
    handlers.onInterim('Cloud speech failed. Switching to this device.');
    const mode = await chooseRecognition(engine, handlers, true);
    recovering = false;
    if (!listening && mode !== 'local') {
      handlers.onError(recognitionMessage('network', false));
      return;
    }
    if (mode !== 'local') {
      listening = false;
      handlers.onError(recognitionMessage('network', false));
      return;
    }
    usingLocal = true;
    listening = true;
    handlers.onState('listening');
    try {
      engine.start();
    } catch {
      listening = false;
      handlers.onError('The microphone is already in use.');
    }
  }
}

async function chooseRecognition(engine, handlers, forceInstall = false) {
  const lang = speechLanguage();
  engine.lang = lang;
  const ctor = SpeechRecognition;
  if (typeof ctor?.available !== 'function') {
    engine.processLocally = false;
    return 'cloud';
  }
  let result = 'timeout';
  try {
    result = await withTimeout(ctor.available({ langs: [lang], processLocally: true }), 2500);
  } catch {
    result = 'unavailable';
  }
  if (result === 'available') {
    engine.processLocally = true;
    return 'local';
  }
  if (forceInstall || result === 'downloadable' || result === 'downloading') {
    if (typeof ctor.install === 'function') {
      handlers.onInterim?.('Downloading on-device speech. This stays on the computer.');
      try {
        const installed = await ctor.install({ langs: [lang], processLocally: true });
        if (installed) {
          engine.processLocally = true;
          return 'local';
        }
      } catch {
        engine.processLocally = false;
        return 'cloud';
      }
    }
  }
  engine.processLocally = false;
  return 'cloud';
}

function speechLanguage() {
  const lang = navigator.language || 'en-US';
  return /^[a-z]{2}-[A-Z]{2}/.test(lang) ? lang : 'en-US';
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      window.setTimeout(() => resolve('timeout'), ms);
    }),
  ]);
}

function pickVoice() {
  const voices = window.speechSynthesis?.getVoices?.() ?? [];
  const english = voices.filter((voice) => voice.lang.toLowerCase().startsWith('en'));
  const pool = english.length ? english : voices;
  return (
    pool.find((voice) => /natural/i.test(voice.name)) ||
    pool.find((voice) => /online/i.test(voice.name)) ||
    pool.find((voice) => /aria|jenny|sonia/i.test(voice.name)) ||
    pool.find((voice) => /zira/i.test(voice.name)) ||
    pool.find((voice) => !/david|mark/i.test(voice.name)) ||
    pool[0] ||
    null
  );
}

function recognitionMessage(code, local) {
  if (code === 'not-allowed') return 'Microphone permission was blocked. Allow it for this site, then try again.';
  if (code === 'audio-capture') return 'No microphone was found.';
  if (code === 'language-not-supported') return 'On-device speech for this language is not installed yet. Click Talk again to download it.';
  if (code === 'network') {
    return local
      ? 'On-device speech failed in this browser. Type under Type instead, or open Maximus in Chrome or Edge.'
      : 'This computer is online. The browser still sent your voice to its cloud speech service, and that call failed. Click Talk again so Maximus can use on-device speech.';
  }
  return 'Speech recognition stopped.';
}
