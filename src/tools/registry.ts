import type { ToolDefinition, ToolManifest } from './types.js';

export class ToolRegistry {
  private readonly byName = new Map<string, ToolManifest>();

  constructor(tools: ToolManifest[]) {
    for (const tool of tools) {
      if (this.byName.has(tool.name)) {
        throw new Error(`Duplicate tool: ${tool.name}`);
      }
      this.byName.set(tool.name, tool);
    }
  }

  get(name: string): ToolManifest | undefined {
    return this.byName.get(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.byName.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
}
