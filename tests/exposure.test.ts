import { describe, it, expect } from 'vitest';
import extension from '../index';

// A stub pi: registration records exposure; tool_search is pi's built-in when present.
function load(withToolSearch: boolean) {
  const tools = new Map<string, string>(withToolSearch ? [['tool_search', 'model-only']] : []);
  const handlers = new Map<string, Function[]>();
  let active: string[] = [];
  const registered: any[] = [];
  const pi: any = {
    registerTool: (tool: any) => { registered.push(tool); tools.set(tool.name, tool.exposure ?? 'direct'); },
    registerCommand: () => {},
    on: (event: string, fn: Function) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    getAllTools: () => [...tools].map(([name, exposure]) => ({
      name, exposure, sourceInfo: { path: name === 'tool_search' ? 'builtin:tool-search' : 'pi-browser' },
    })),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
  };
  extension(pi);
  const start = () => (handlers.get('session_start') ?? []).forEach(fn => fn({}, {}));
  return { tools, registered, start, active: () => active };
}

describe('tool exposure', () => {
  it('registers deferred behind pi\'s tool_search, and activates tool_search', () => {
    const pi = load(true);
    pi.start();
    expect(pi.tools.get('browser_navigate')).toBe('deferred');
    expect(pi.active()).toEqual(['tool_search']);
  });

  it('re-registers direct when pi has no tool_search', () => {
    const pi = load(false);
    pi.start();
    expect(pi.tools.get('browser_navigate')).toBe('direct');
    // the direct re-registration must stay sequential too
    expect(pi.registered.every(t => t.executionMode === 'sequential')).toBe(true);
  });
});
