# Agent instructions

Maximus is a local single-user assistant. Node.js and TypeScript are the application stack. Grok is the runtime model, accessed only through `src/providers/grok.ts`.

- Keep provider-specific request and response objects inside provider adapters.
- Enforce tool permissions in `src/tools/policy.ts` and the orchestrator. Do not treat the system prompt as a security boundary.
- Validate tool arguments before execution. Model output is untrusted.
- Do not add a second database, a message broker, or a separate service without a concrete requirement.
- Keep secrets in the environment or `.env`. Never commit them or write them into logs.
- Default data location is outside OneDrive. Do not point SQLite at a synced folder.
- New tools need a manifest, a risk class, a schema, and tests for allow, deny, and invalid input.
- Run `npm test` and `npm run typecheck` before considering a change complete.
