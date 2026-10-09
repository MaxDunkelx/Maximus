# Maximus

Maximus is a local, single-user personal assistant. This repository currently contains the foundation: a text conversation loop, a Grok adapter, and a small set of tools whose permissions are enforced by application code.

The assistant listens on `127.0.0.1:8787` by default. Conversation data is stored in SQLite. When this project lives under OneDrive, the database is placed in `%LOCALAPPDATA%\Maximus` so file sync does not corrupt it.

## Run

Requirements: Node.js 22.13 or newer.

```bash
npm install
copy .env.example .env
ollama pull llama3.2
npm run dev
```

Open `http://127.0.0.1:8787` in Edge or Chrome. Click **Talk**, allow the microphone, and Maximus answers out loud. Typing remains under “Type instead.”

The default model is local and free through Ollama. Grok is still available with `MAXIMUS_PROVIDER=grok` and `XAI_API_KEY`. `MAXIMUS_PROVIDER=fake` runs the interface without a model.

## Checks

```bash
npm test
npm run typecheck
```

## Scope of this version

Implemented:

- Configuration, structured logs, and health checks.
- Local conversations, notes, usage totals, and an audit trail.
- Ollama through its OpenAI-compatible chat API, with Grok still available as an optional provider.
- Browser speech recognition and spoken replies. Text input still works if voice is unavailable.
- A provider interface and a deterministic stand-in for tests.
- Tool calls for the clock and local notes, with risk checks and an approval pause for consequential actions.

Not implemented yet: long-term memory, multi-step task workflows, voice, proactive reminders, shell or browser control, and external account integrations. See `docs/architecture.md`.
