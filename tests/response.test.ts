import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { BrowserToolResult } from '../src/response';
import type { Context } from '../src/context';
import type { Tab } from '../src/tab';
import type { CdpTarget } from '../src/browser-session';

function makeTab(url: string, title: string, current = false, opts: { ariaSnapshot?: string; modalStates?: any[] } = {}): Tab {
  return {
    page: { url: () => url } as any,
    headerSnapshot: async () => ({ url, title, current, changed: true }),
    isCurrentTab: () => current,
    modalStates: () => opts.modalStates ?? [],
    captureSnapshot: async () =>
      opts.ariaSnapshot === undefined
        ? null
        : { ariaSnapshot: opts.ariaSnapshot, modalStates: opts.modalStates ?? [] },
  } as unknown as Tab;
}

function textOf(built: Awaited<ReturnType<BrowserToolResult['build']>>): string {
  return (built.content[0] as { type: 'text'; text: string }).text;
}

function makeContext(tabs: Tab[], cdpTargets: CdpTarget[] = []): Context {
  return {
    tabs: () => tabs,
    currentTab: () => tabs.find(t => t.isCurrentTab()),
    cdpOnlyTargets: () => cdpTargets,
    allTabInfos: () => [
      ...tabs.map((tab, i) => ({ tab, index: i })),
      ...cdpTargets.map((cdpTarget, i) => ({ cdpTarget, index: tabs.length + i })),
    ],
  } as unknown as Context;
}

describe('BrowserToolResult', () => {
  describe('text output', () => {
    it('includes result text under Result section', async () => {
      const ctx = makeContext([makeTab('https://example.com', 'Example', true)]);
      const result = new BrowserToolResult(ctx);
      result.addTextResult('hello world');
      const built = await result.build();
      const text = (built.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('### Result');
      expect(text).toContain('hello world');
    });

    it('includes error text under Error section and sets isError', async () => {
      const ctx = makeContext([makeTab('https://example.com', 'Example', true)]);
      const result = new BrowserToolResult(ctx);
      result.addError('something went wrong');
      const built = await result.build();
      const text = (built.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('### Error');
      expect(text).toContain('something went wrong');
      expect(built.isError).toBe(true);
    });

    it('includes code under Ran Playwright code section with js codeframe', async () => {
      const ctx = makeContext([makeTab('https://example.com', 'Example', true)]);
      const result = new BrowserToolResult(ctx);
      result.addCode('await page.goto("https://example.com")');
      const built = await result.build();
      const text = (built.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('### Ran Playwright code');
      expect(text).toContain('```js');
      expect(text).toContain('await page.goto');
    });

    it('includes page URL and title in Page section', async () => {
      const ctx = makeContext([makeTab('https://example.com', 'Example', true)]);
      const result = new BrowserToolResult(ctx);
      const built = await result.build();
      const text = (built.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('### Page');
      expect(text).toContain('https://example.com');
      expect(text).toContain('Example');
    });

    it('shows Open tabs section when multiple tabs present', async () => {
      const ctx = makeContext([
        makeTab('https://example.com', 'Example', true),
        makeTab('https://github.com', 'GitHub', false),
      ]);
      const result = new BrowserToolResult(ctx);
      const built = await result.build();
      const text = (built.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('### Open tabs');
      expect(text).toContain('https://example.com');
      expect(text).toContain('https://github.com');
    });

    it('does not show Open tabs section with only one tab', async () => {
      const ctx = makeContext([makeTab('https://example.com', 'Example', true)]);
      const result = new BrowserToolResult(ctx);
      const built = await result.build();
      const text = (built.content[0] as { type: 'text'; text: string }).text;
      expect(text).not.toContain('### Open tabs');
    });

    it('includes CDP-only tabs in Open tabs section', async () => {
      const cdpTarget: CdpTarget = {
        type: 'page',
        url: 'https://other-window.com',
        title: 'Other Window',
        id: 'abc123',
        webSocketDebuggerUrl: 'ws://localhost:9222/...',
      };
      const ctx = makeContext(
        [makeTab('https://example.com', 'Example', true)],
        [cdpTarget]
      );
      const result = new BrowserToolResult(ctx);
      const built = await result.build();
      const text = (built.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('### Open tabs');
      expect(text).toContain('https://other-window.com');
    });
  });

  describe('image output', () => {
    it('encodes PNG image as base64 with correct mimeType', async () => {
      const ctx = makeContext([makeTab('https://example.com', 'Example', true)]);
      const result = new BrowserToolResult(ctx);
      const fakeImage = Buffer.from('fake-png-data');
      await result.registerImageResult(fakeImage, 'png');
      const built = await result.build();
      const imgBlock = built.content.find(c => c.type === 'image') as { type: 'image'; data: string; mimeType: string } | undefined;
      expect(imgBlock).toBeDefined();
      expect(imgBlock!.mimeType).toBe('image/png');
      expect(imgBlock!.data).toBe(fakeImage.toString('base64'));
    });

    it('encodes JPEG image with correct mimeType', async () => {
      const ctx = makeContext([makeTab('https://example.com', 'Example', true)]);
      const result = new BrowserToolResult(ctx);
      await result.registerImageResult(Buffer.from('fake-jpeg'), 'jpeg');
      const built = await result.build();
      const imgBlock = built.content.find(c => c.type === 'image') as { type: 'image'; mimeType: string } | undefined;
      expect(imgBlock!.mimeType).toBe('image/jpeg');
    });
  });

  describe('details', () => {
    it('includes tab headers in details', async () => {
      const ctx = makeContext([makeTab('https://example.com', 'Example', true)]);
      const result = new BrowserToolResult(ctx);
      const built = await result.build();
      expect(built.details.tabs).toHaveLength(1);
      expect(built.details.tabs[0].url).toBe('https://example.com');
    });

    it('sets isClose when no tabs are open', async () => {
      const ctx = makeContext([]);
      const result = new BrowserToolResult(ctx);
      const built = await result.build();
      expect(built.details.isClose).toBe(true);
    });
  });

  describe('snapshot is opt-in', () => {
    const tree = 'heading "Hello"\nbutton "Go"';

    it('omits the accessibility tree by default and says so on snapshot-capable tools', async () => {
      const ctx = makeContext([makeTab('https://example.com', 'Example', true, { ariaSnapshot: tree })]);
      const built = await new BrowserToolResult(ctx, true).build();
      const text = textOf(built);
      expect(text).not.toContain('button "Go"');
      expect(text).toContain('snapshot: true');
      expect(text).toContain('https://example.com');
    });

    it('stays silent about snapshots on tools that cannot return one', async () => {
      const ctx = makeContext([makeTab('https://example.com', 'Example', true, { ariaSnapshot: tree })]);
      expect(textOf(await new BrowserToolResult(ctx).build())).not.toContain('### Snapshot');
    });

    it('includes the full tree when asked', async () => {
      const ctx = makeContext([makeTab('https://example.com', 'Example', true, { ariaSnapshot: tree })]);
      const result = new BrowserToolResult(ctx, true);
      result.setIncludeSnapshot();
      const text = textOf(await result.build());
      expect(text).toContain('```yaml');
      expect(text).toContain('button "Go"');
    });

    it('reports modal state even when the tree is omitted', async () => {
      const modal = [{ type: 'dialog', description: '"confirm" dialog: "Delete?"' }];
      const ctx = makeContext([makeTab('https://example.com', 'Example', true, { ariaSnapshot: tree, modalStates: modal })]);
      const text = textOf(await new BrowserToolResult(ctx, true).build());
      expect(text).toContain('### Modal state');
      expect(text).toContain('Delete?');
    });
  });

  describe('oversized results spill to a file', () => {
    it('keeps a normal-sized result inline and untouched', async () => {
      const ctx = makeContext([makeTab('https://example.com', 'Example', true)]);
      const result = new BrowserToolResult(ctx);
      result.addTextResult('x'.repeat(1_000));
      const text = textOf(await result.build());
      expect(text).toContain('x'.repeat(1_000));
      expect(text).not.toContain('Full output written to');
    });

    it('writes the whole result to a file and returns an excerpt plus its path', async () => {
      const ctx = makeContext([makeTab('https://example.com', 'Example', true)]);
      const result = new BrowserToolResult(ctx);
      const needle = 'NEEDLE-AT-THE-END';
      result.addTextResult(`${'line of aria tree\n'.repeat(3_000)}${needle}`);
      const text = textOf(await result.build());

      const file = text.match(/Full output written to (\S+)/)?.[1];
      expect(file).toBeDefined();
      expect(text.length).toBeLessThan(6_000);
      const full = fs.readFileSync(file!, 'utf8');
      expect(full).toContain(needle);
      expect(full.length).toBeGreaterThan(50_000);
      fs.rmSync(file!, { force: true });
    });

    it('keeps the page header and modal state inline when another section is excerpted', async () => {
      const modal = [{ type: 'dialog', description: '"confirm" dialog: "Delete everything?"' }];
      const ctx = makeContext([
        makeTab('https://example.com', 'Example', true, { ariaSnapshot: 'button "b"\n'.repeat(4_000), modalStates: modal }),
      ]);
      const result = new BrowserToolResult(ctx, true);
      result.setIncludeSnapshot();
      const text = textOf(await result.build());

      expect(text).toContain('Delete everything?');
      expect(text).toContain('https://example.com');
      const file = text.match(/Full output written to (\S+)/)![1];
      fs.rmSync(file, { force: true });
    });

    it('excerpts an oversized Result section without losing the page header', async () => {
      const ctx = makeContext([makeTab('https://example.com', 'Example', true)]);
      const result = new BrowserToolResult(ctx);
      result.addTextResult('aria line\n'.repeat(5_000));
      const text = textOf(await result.build());

      expect(text).toContain('### Page');
      expect(text).toContain('https://example.com');
      const file = text.match(/Full output written to (\S+)/)![1];
      fs.rmSync(file, { force: true });
    });

    it('bounds a single monster line in the excerpt while keeping it whole in the file', async () => {
      const ctx = makeContext([makeTab('https://example.com', 'Example', true)]);
      const result = new BrowserToolResult(ctx);
      result.addTextResult(`text "${'a'.repeat(100_000)}"\nbutton "Go"`);
      const text = textOf(await result.build());

      expect(text).toMatch(/\[\+\d+ chars, see file\]/);
      expect(text).toContain('button "Go"');
      const file = text.match(/Full output written to (\S+)/)![1];
      expect(fs.readFileSync(file, 'utf8')).toContain('a'.repeat(100_000));
      fs.rmSync(file, { force: true });
    });
  });
});
