import { defineTabTool } from '../tool';

const LEVELS = ['error', 'warning', 'info', 'debug'] as const;
type Level = typeof LEVELS[number];

function levelIndex(l: Level): number { return LEVELS.indexOf(l); }

export const consoleMessages = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_console_messages',
    title: 'Get console messages',
    description: 'Return console messages from the current page. Useful for debugging errors and failed requests.',
    type: 'readOnly',
  },
  handle: async (tab, params, result) => {
    const level: Level = params.level ?? 'info';
    const threshold = levelIndex(level);
    const msgs = tab.consoleMessages().filter(m => {
      const ml: Level = m.type === 'warning' ? 'warning' : m.type === 'error' ? 'error' : m.type === 'debug' ? 'debug' : 'info';
      return levelIndex(ml) <= threshold;
    });
    if (!msgs.length) {
      result.addTextResult('No console messages.');
      return;
    }
    // No clamp here: an oversized result is excerpted and spilled to a file by the
    // result builder, so the messages past the excerpt stay reachable.
    result.addTextResult(msgs.map(m => m.toString()).join('\n'));
  },
});

export const consoleClear = defineTabTool({
  capability: 'core',
  schema: { name: 'browser_console_clear', title: 'Clear console messages', description: 'Clear recorded console messages', type: 'action' },
  handle: async (tab, _params, result) => {
    tab.clearConsoleMessages();
    result.addTextResult('Console messages cleared.');
  },
});

export default [consoleMessages, consoleClear];
