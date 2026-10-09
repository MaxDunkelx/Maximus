import { voiceCommand } from './commands.js';
import { createVoiceController } from './voice.js';

const state = {
  conversationId: null,
  sending: false,
  speakReply: true,
  request: null,
  token: sessionStorage.getItem('maximusToken') || '',
};

const voice = createVoiceController();

const transcript = document.querySelector('#transcript');
const message = document.querySelector('#message');
const send = document.querySelector('#send');
const status = document.querySelector('#status');
const banner = document.querySelector('#banner');
const title = document.querySelector('#conversation-title');
const conversations = document.querySelector('#conversation-list');
const notes = document.querySelector('#note-list');
const autonomy = document.querySelector('#autonomy');
const tokenInput = document.querySelector('#token');
const health = document.querySelector('#health');
const activity = document.querySelector('#activity');
const activityList = document.querySelector('#activity-list');
const talk = document.querySelector('#talk');
const heard = document.querySelector('#heard');
const handsFree = document.querySelector('#hands-free');
const spokeSvg = document.querySelector('#spokes');
const SPOKE_COUNT = 72;
const spokes = buildSpokes(spokeSvg, SPOKE_COUNT);
const spokeLevel = new Float32Array(SPOKE_COUNT);

tokenInput.value = state.token;

const deleteConversationButton = document.querySelector('#delete-conversation');

document.querySelector('#new-chat').addEventListener('click', () => {
  resetConversation();
});
deleteConversationButton.addEventListener('click', () => {
  if (!state.conversationId) return;
  void removeConversation(state.conversationId, title.textContent);
});

document.querySelector('#composer').addEventListener('submit', (event) => {
  event.preventDefault();
  void sendMessage();
});

talk.addEventListener('click', () => startListening());
handsFree.addEventListener('change', () => {
  if (!handsFree.checked) voice.stop();
});
if (!voice.supported) {
  talk.disabled = true;
  heard.textContent = 'This browser has no speech recognition. Type instead.';
}
window.speechSynthesis?.addEventListener?.('voiceschanged', () => {});

message.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }
});

autonomy.addEventListener('change', () => {
  void patchJson('/api/settings', { autonomyLevel: Number(autonomy.value) });
});

tokenInput.addEventListener('change', () => {
  state.token = tokenInput.value.trim();
  if (state.token) sessionStorage.setItem('maximusToken', state.token);
  else sessionStorage.removeItem('maximusToken');
  void refresh();
});

document.querySelector('#activity-toggle').addEventListener('click', () => {
  activity.hidden = !activity.hidden;
  if (!activity.hidden) void loadActivity();
});

void boot();
window.requestAnimationFrame(paintFrame);

async function boot() {
  document.body.dataset.presence = 'booting';
  await refresh();
  let hidden = false;
  try {
    const response = await api('/api/presence');
    if (response.ok) hidden = (await response.json()).hidden === true;
  } catch {
    hidden = false;
  }
  if (hidden) {
    shell().inert = true;
    finishHide();
    return;
  }
  document.body.dataset.presence = 'awake';
}

async function refresh() {
  await loadHealth();
  await loadSettings();
  await loadConversations();
  await loadNotes();
}

async function loadHealth() {
  const response = await api('/api/health');
  if (!response.ok) {
    health.textContent = response.status === 401 ? 'API token required.' : 'Status unavailable.';
    return;
  }
  const body = await response.json();
  const configured = body.providerConfigured ? 'ready' : body.provider === 'ollama' ? 'not running' : 'missing API key';
  health.textContent = `${body.provider} · ${body.model} · ${configured}`;
}

async function loadSettings() {
  const response = await api('/api/settings');
  if (!response.ok) return;
  const body = await response.json();
  autonomy.value = String(body.autonomyLevel);
}

async function loadConversations() {
  conversations.replaceChildren();
  const response = await api('/api/conversations');
  if (!response.ok) return;
  const body = await response.json();
  if (body.conversations.length === 0) {
    conversations.append(note('No conversations yet.'));
    return;
  }
  for (const conversation of body.conversations) {
    const row = document.createElement('div');
    row.className = 'conversation-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = conversation.title;
    button.dataset.id = conversation.id;
    button.addEventListener('click', () => void openConversation(conversation.id, conversation.title));
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'forget';
    forget.textContent = 'Delete';
    forget.setAttribute('aria-label', `Delete ${conversation.title}`);
    forget.addEventListener('click', () => void removeConversation(conversation.id, conversation.title));
    row.append(button, forget);
    conversations.append(row);
  }
  markCurrent();
}

async function loadNotes() {
  notes.replaceChildren();
  const response = await api('/api/notes');
  if (!response.ok) return;
  const body = await response.json();
  if (body.notes.length === 0) {
    notes.append(note('No notes yet.'));
    return;
  }
  for (const item of body.notes) notes.append(note(item.title));
}

async function loadActivity() {
  activityList.replaceChildren();
  const response = await api('/api/audit');
  if (!response.ok) return;
  const body = await response.json();
  if (body.events.length === 0) {
    activityList.append(note('No actions yet.'));
    return;
  }
  for (const event of body.events) {
    const row = document.createElement('div');
    row.className = 'activity-item';
    row.textContent = `${event.createdAt} · ${event.toolName || event.action} · ${event.outcome}`;
    activityList.append(row);
  }
}

async function openConversation(id, conversationTitle) {
  state.conversationId = id;
  title.textContent = conversationTitle;
  markCurrent();
  transcript.replaceChildren();
  const response = await api(`/api/conversations/${id}`);
  if (!response.ok) return showError('The conversation could not be loaded.');
  const body = await response.json();
  for (const item of body.messages) appendBubble(item.role, item.content);
}

function startListening() {
  if (!canTalk()) return;
  speechToken += 1;
  stopClip();
  if (talk.getAttribute('aria-pressed') === 'true') {
    voice.stop();
    talk.setAttribute('aria-pressed', 'false');
    talk.textContent = 'Talk';
    stopMeter();
    setStatus('Ready', 'ready');
    return;
  }
  state.request?.abort();
  voice.listen(
    {
      onInterim(text) {
        heard.textContent = text || 'Listening…';
      },
      onFinal(text) {
        const command = voiceCommand(text);
        if (command === 'hide') {
          void hideMaximus();
          return;
        }
        if (command === 'rise' || !canTalk()) return;
        heard.textContent = text;
        talk.setAttribute('aria-pressed', 'false');
        talk.textContent = 'Talk';
        stopMeter();
        void sendMessage(text);
      },
      onState(next) {
        if (next === 'listening') {
          talk.setAttribute('aria-pressed', 'true');
          talk.textContent = 'Live';
          setStatus('Listening', 'listening');
          void startMeter();
        } else if (status.dataset.state === 'listening') {
          stopMeter();
          talk.setAttribute('aria-pressed', 'false');
          talk.textContent = 'Talk';
          setStatus('Ready', 'ready');
        }
      },
      onResume() {
        window.setTimeout(() => startListening(), 400);
      },
      onError(text) {
        talk.setAttribute('aria-pressed', 'false');
        talk.textContent = 'Talk';
        showError(text);
      },
    },
    { handsFree: handsFree.checked },
  );
}

async function sendMessage(spokenText) {
  const text = (spokenText ?? message.value).trim();
  if (!text) return;
  const command = voiceCommand(text);
  if (command === 'hide') {
    message.value = '';
    hideMaximus();
    return;
  }
  if (command === 'rise' || !canTalk() || state.sending) {
    if (command === 'rise' || !canTalk()) message.value = '';
    return;
  }
  state.request?.abort();
  const request = new AbortController();
  state.request = request;
  state.sending = true;
  send.disabled = true;
  hideBanner();
  message.value = '';
  appendBubble('user', text);
  const assistant = appendBubble('assistant', '');
  setStatus('Thinking', 'thinking');
  try {
    const response = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ text, ...(state.conversationId ? { conversationId: state.conversationId } : {}) }),
      signal: request.signal,
    });
    if (!response.ok) {
      assistant.remove();
      showError(await errorMessage(response));
      return;
    }
    await readSse(response, (event) => applyEvent(event, assistant));
  } catch (error) {
    if (error?.name === 'AbortError') return;
    showError('The connection to Maximus was interrupted.');
  } finally {
    state.sending = false;
    send.disabled = false;
    await loadConversations();
    await loadNotes();
  }
}

function applyEvent(event, assistant) {
  if (event.type === 'conversation') {
    state.conversationId = event.conversationId;
    title.textContent = event.title;
  } else if (event.type === 'text') {
    assistant.textContent += event.text;
    assistant.scrollIntoView({ block: 'end' });
  } else if (event.type === 'tool_started') {
    setStatus(`Running ${event.name}`, 'thinking');
    appendLine(`${event.name} started`);
  } else if (event.type === 'tool_finished') {
    appendLine(event.summary);
    setStatus(event.ok ? 'Thinking' : 'Checking the result', event.ok ? 'thinking' : 'error');
  } else if (event.type === 'approval_required') {
    setStatus('Waiting for approval', 'approval');
    appendApproval(event);
    speak('This needs your approval.');
  } else if (event.type === 'completed') {
    if (!assistant.textContent) assistant.textContent = event.text;
    const reply = assistant.textContent.trim();
    if (state.speakReply && reply) speak(reply);
    else setStatus('Ready', 'done');
  } else if (event.type === 'failed') {
    showError(event.message);
  }
}

function appendApproval(event) {
  const card = document.createElement('article');
  card.className = 'approval';
  const copy = document.createElement('p');
  copy.textContent = `${event.name} needs approval (${event.risk}). ${JSON.stringify(event.arguments)}`;
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(decisionButton('Approve', event.approvalId, 'approve'), decisionButton('Deny', event.approvalId, 'deny'));
  card.append(copy, actions);
  transcript.append(card);
}

function decisionButton(label, approvalId, decision) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', () => void decide(approvalId, decision, button));
  return button;
}

async function decide(approvalId, decision, button) {
  button.disabled = true;
  setStatus(decision === 'approve' ? 'Executing' : 'Denying', 'thinking');
  const response = await api(`/api/approvals/${approvalId}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  });
  if (!response.ok) {
    showError(await errorMessage(response));
    return;
  }
  const assistant = appendBubble('assistant', '');
  await readSse(response, (event) => applyEvent(event, assistant));
  if (!assistant.textContent) assistant.remove();
  await loadNotes();
  await loadActivity();
}

function appendBubble(role, text) {
  const bubble = document.createElement('article');
  bubble.className = `bubble ${role === 'user' ? 'user' : 'assistant'}`;
  bubble.textContent = text;
  transcript.append(bubble);
  return bubble;
}

function appendLine(text) {
  const line = document.createElement('p');
  line.className = 'tool';
  line.textContent = text;
  transcript.append(line);
}

function note(text) {
  const item = document.createElement('p');
  item.className = 'note';
  item.textContent = text;
  return item;
}

function resetConversation() {
  state.request?.abort();
  speechToken += 1;
  stopClip();
  voice.stop();
  state.conversationId = null;
  title.textContent = 'New conversation';
  transcript.replaceChildren();
  setStatus('Ready', 'ready');
  hideBanner();
  markCurrent();
}

async function removeConversation(id, conversationTitle) {
  const confirmed = window.confirm(`Delete "${conversationTitle}"? This removes it from this computer.`);
  if (!confirmed) return;
  const response = await api(`/api/conversations/${id}`, { method: 'DELETE' });
  if (!response.ok) return showError('The conversation could not be deleted.');
  if (state.conversationId === id) resetConversation();
  await loadConversations();
}

function markCurrent() {
  deleteConversationButton.disabled = !state.conversationId;
  for (const button of conversations.querySelectorAll('button[data-id]')) {
    button.setAttribute('aria-current', button.dataset.id === state.conversationId ? 'true' : 'false');
  }
}

let speechToken = 0;
let clip = null;

function speak(text, options = {}) {
  if (!canTalk()) return;
  const token = ++speechToken;
  stopMeter();
  stopClip();
  setStatus('Speaking', 'speaking');
  void finishSpeech(text, options, token);
}

async function finishSpeech(text, options, token) {
  const played = await playNeural(text, token);
  if (token !== speechToken) return;
  if (!played) {
    voice.speak(text, () => {
      if (token === speechToken) endSpeech(options);
    });
    return;
  }
  endSpeech(options);
}

function endSpeech(options) {
  if (!canTalk()) return;
  setStatus('Ready', 'done');
  if (options.resume !== false && handsFree.checked) window.setTimeout(() => startListening(), 400);
}

async function playNeural(text, token) {
  try {
    const response = await api('/api/speech', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    if (token !== speechToken) return true;
    if (!response.ok) return false;
    const blob = await response.blob();
    if (token !== speechToken || blob.size < 128) return token !== speechToken;
    await playBlob(blob, token);
    return true;
  } catch {
    return token !== speechToken;
  }
}

function playBlob(blob, token) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    clip = audio;
    const finish = () => {
      URL.revokeObjectURL(url);
      if (clip === audio) clip = null;
      resolve();
    };
    audio.addEventListener('ended', finish, { once: true });
    audio.addEventListener('error', finish, { once: true });
    if (token !== speechToken) {
      finish();
      return;
    }
    void audio.play().catch(finish);
  });
}

function stopClip() {
  if (!clip) return;
  clip.pause();
  clip.src = '';
  clip = null;
}

let collapseAt = 0;
let presenceTimer = 0;
let sentinelTimer = 0;

function shell() {
  return document.querySelector('.app');
}

function blackout() {
  const presenceNow = document.body.dataset.presence;
  return presenceNow === 'dying' || presenceNow === 'hidden';
}

function canTalk() {
  return document.body.dataset.presence === 'awake';
}

function hideMaximus() {
  const presenceNow = document.body.dataset.presence;
  if (presenceNow === 'dying' || presenceNow === 'hidden') return;
  window.clearTimeout(presenceTimer);
  window.clearTimeout(sentinelTimer);
  state.request?.abort();
  speechToken += 1;
  stopClip();
  voice.stop();
  stopMeter();
  talk.setAttribute('aria-pressed', 'false');
  talk.textContent = 'Talk';
  state.sending = false;
  send.disabled = false;
  heard.textContent = '';
  hideBanner();
  shell().inert = true;
  collapseAt = performance.now();
  document.body.dataset.presence = 'dying';
  document.body.dataset.mode = 'dying';
  void api('/api/presence', { method: 'POST', body: JSON.stringify({ hidden: true }) });
  scheduleSentinel(500);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  presenceTimer = window.setTimeout(() => finishHide(), reduced ? 0 : 2900);
}

function finishHide() {
  const presenceNow = document.body.dataset.presence;
  if (presenceNow !== 'dying' && presenceNow !== 'hidden') return;
  document.body.dataset.presence = 'hidden';
  document.body.dataset.mode = 'hidden';
  document.documentElement.style.setProperty('--voice-level', '0');
  for (let index = 0; index < spokes.length; index += 1) {
    spokeLevel[index] = 0;
    spokes[index].setAttribute('y2', '-124');
    spokes[index].style.opacity = '0';
  }
  scheduleSentinel(200);
}

function riseMaximus() {
  const presenceNow = document.body.dataset.presence;
  if (presenceNow !== 'hidden' && presenceNow !== 'dying') return;
  window.clearTimeout(presenceTimer);
  window.clearTimeout(sentinelTimer);
  speechToken += 1;
  stopClip();
  voice.stop();
  stopMeter();
  collapseAt = performance.now();
  document.body.dataset.presence = 'rising';
  document.body.dataset.mode = 'rising';
  void api('/api/presence', { method: 'POST', body: JSON.stringify({ hidden: false }) });
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  presenceTimer = window.setTimeout(() => {
    shell().inert = false;
    document.body.dataset.presence = 'awake';
    heard.textContent = 'Click the core and speak.';
    setStatus('Ready', 'ready');
    if (handsFree.checked) startListening();
  }, reduced ? 0 : 2500);
}

function scheduleSentinel(delay) {
  window.clearTimeout(sentinelTimer);
  const presenceNow = document.body.dataset.presence;
  if (presenceNow !== 'dying' && presenceNow !== 'hidden') return;
  sentinelTimer = window.setTimeout(() => armSentinel(), delay);
}

function armSentinel() {
  const presenceNow = document.body.dataset.presence;
  if (presenceNow !== 'dying' && presenceNow !== 'hidden') return;
  if (!voice.supported) return;
  voice.listen(
    {
      onInterim() {},
      onFinal(text) {
        if (voiceCommand(text) === 'rise') riseMaximus();
      },
      onState() {},
      onResume() {
        scheduleSentinel(350);
      },
      onError() {
        scheduleSentinel(900);
      },
    },
    { sentinel: true },
  );
}

function setStatus(text, stateName) {
  if (blackout()) return;
  status.textContent = text;
  status.dataset.state = stateName;
  document.body.dataset.mode = stateName;
}

let meterStream = null;
let meterAudio = null;
let analyser = null;
let micData = null;

function buildSpokes(svg, count) {
  const ns = 'http://www.w3.org/2000/svg';
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', '-116');
    line.setAttribute('x2', '0');
    line.setAttribute('y2', '-124');
    line.setAttribute('transform', `rotate(${(360 / count) * index})`);
    svg.appendChild(line);
    lines.push(line);
  }
  return lines;
}

function paintFrame() {
  const presenceNow = document.body.dataset.presence;
  if (presenceNow === 'hidden' || presenceNow === 'booting') {
    window.requestAnimationFrame(paintFrame);
    return;
  }
  const mode = document.body.dataset.mode;
  if (presenceNow === 'dying') paintDying();
  else if (presenceNow === 'rising') paintRise();
  else if (mode === 'listening' && analyser) paintMic();
  else if (mode === 'speaking') paintSpeech();
  else paintIdle(mode === 'thinking' ? 1.7 : 1);
  window.requestAnimationFrame(paintFrame);
}

function paintDying() {
  const elapsed = Math.min(1, (performance.now() - collapseAt) / 2600);
  const flare = elapsed < 0.18 ? elapsed / 0.18 : Math.max(0, 1 - (elapsed - 0.18) / 0.82);
  const values = [];
  for (let index = 0; index < SPOKE_COUNT; index += 1) {
    const wave = Math.max(0, Math.sin(index * 0.35 + elapsed * 22));
    values.push(flare * (0.2 + wave));
  }
  applySpokes(values);
}

function paintRise() {
  const elapsed = Math.min(1, (performance.now() - collapseAt) / 2400);
  paintIdle(0.6 + elapsed * 1.8);
}

function paintIdle(speed) {
  const time = (performance.now() / 1000) * speed;
  const values = [];
  for (let index = 0; index < SPOKE_COUNT; index += 1) {
    const travel = Math.sin(time * 2.4 - index * 0.32);
    const breathe = Math.sin(time * 1.15 + index * 0.07);
    values.push(Math.max(0, 0.16 + travel * 0.28 + breathe * 0.1));
  }
  applySpokes(values);
}

function paintSpeech() {
  const time = performance.now() / 150;
  const values = [];
  for (let index = 0; index < SPOKE_COUNT; index += 1) {
    const low = Math.abs(Math.sin(time * 1.6 + index * 0.41));
    const high = Math.abs(Math.sin(time * 3.4 - index * 0.22));
    values.push(0.2 + low * 0.55 + high * 0.4);
  }
  applySpokes(values);
}

function paintMic() {
  analyser.getByteFrequencyData(micData);
  const values = [];
  for (let index = 0; index < SPOKE_COUNT; index += 1) {
    const sample = micData[index % micData.length] / 255;
    values.push(Math.pow(sample, 0.55));
  }
  applySpokes(values);
}

function applySpokes(values) {
  let sum = 0;
  for (let index = 0; index < spokes.length; index += 1) {
    const target = values[index] ?? 0;
    const level = spokeLevel[index] * 0.42 + target * 0.58;
    spokeLevel[index] = level;
    sum += level;
    spokes[index].setAttribute('y2', (-124 - level * 58).toFixed(1));
    spokes[index].style.opacity = (0.3 + Math.min(level, 1) * 0.7).toFixed(2);
  }
  document.documentElement.style.setProperty('--voice-level', (sum / spokes.length).toFixed(3));
}

async function startMeter() {
  if (meterStream || !navigator.mediaDevices?.getUserMedia) return;
  try {
    meterStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    meterAudio = new AudioContext();
    await meterAudio.resume();
    const source = meterAudio.createMediaStreamSource(meterStream);
    analyser = meterAudio.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.65;
    source.connect(analyser);
    micData = new Uint8Array(analyser.frequencyBinCount);
  } catch {
    analyser = null;
  }
}

function stopMeter() {
  meterStream?.getTracks().forEach((track) => track.stop());
  meterStream = null;
  analyser = null;
  micData = null;
  void meterAudio?.close();
  meterAudio = null;
}

function showError(text) {
  if (blackout()) return;
  banner.hidden = false;
  banner.textContent = text;
  setStatus('Needs attention', 'error');
  if (state.speakReply) speak(text, { resume: false });
}

function hideBanner() {
  banner.hidden = true;
  banner.textContent = '';
}

async function patchJson(url, body) {
  const response = await api(url, { method: 'PATCH', body: JSON.stringify(body) });
  if (!response.ok) showError(await errorMessage(response));
}

async function api(url, options = {}) {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  return fetch(url, { ...options, headers });
}

async function errorMessage(response) {
  try {
    const body = await response.json();
    return body.error?.message || 'The request failed.';
  } catch {
    return 'The request failed.';
  }
}

async function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let eventName = 'message';
      const data = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) eventName = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      if (data.length) onEvent(JSON.parse(data.join('\n')));
      boundary = buffer.indexOf('\n\n');
    }
  }
}
