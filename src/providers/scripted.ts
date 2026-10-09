import type { ChatProvider, CompletionRequest, CompletionResult, ProviderStreamEvent } from './types.js';

export class ScriptedProvider implements ChatProvider {
  readonly requests: CompletionRequest[] = [];

  constructor(private readonly steps: Array<(request: CompletionRequest) => CompletionResult>) {}

  async *stream(request: CompletionRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(request);
    const step = this.steps[this.requests.length - 1];
    if (!step) throw new Error('ScriptedProvider has no remaining responses.');
    const result = step(request);
    if (result.text) {
      const midpoint = Math.ceil(result.text.length / 2);
      yield { type: 'text', text: result.text.slice(0, midpoint) };
      const rest = result.text.slice(midpoint);
      if (rest) yield { type: 'text', text: rest };
    }
    yield { type: 'completed', result };
  }
}
