import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { screenshot } from '../src/tools/screenshot';
import { BrowserToolResult } from '../src/response';
import type { Context } from '../src/context';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function makeContext(): Context {
  const tab = {
    actionTimeoutOptions: {},
    page: { screenshot: async () => PNG },
    refLocator: async ({ selector }: { selector: string }) => ({
      locator: {
        screenshot: async () => PNG,
        evaluate: async () => (selector === '#scroller'
          ? { clientH: 200, scrollH: 2500, clientW: 320, scrollW: 320 }
          : { clientH: 100, scrollH: 100, clientW: 100, scrollW: 100 }),
      },
      resolved: `locator(${JSON.stringify(selector)})`,
    }),
  };
  return {
    ensureTab: async () => tab,
    tabs: () => [],
    currentTab: () => undefined,
    cdpOnlyTargets: () => [],
  } as unknown as Context;
}

describe('browser_take_screenshot filename', () => {
  const written: string[] = [];
  afterEach(() => {
    for (const f of written) fs.rmSync(f, { force: true });
    written.length = 0;
  });

  it('writes the image to disk and reports the resolved path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-browser-shot-'));
    const target = path.join(dir, 'nested', 'shot.png');
    written.push(dir);
    const ctx = makeContext();
    const result = new BrowserToolResult(ctx);

    await screenshot.handle(ctx, { filename: target }, result);

    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target)).toEqual(PNG);
    const built = await result.build();
    const text = (built.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain(`Screenshot saved to ${path.resolve(target)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not write a file when filename is omitted', async () => {
    const ctx = makeContext();
    const result = new BrowserToolResult(ctx);
    await screenshot.handle(ctx, {}, result);
    const built = await result.build();
    const text = (built.content[0] as { type: 'text'; text: string }).text;
    expect(text).not.toContain('Screenshot saved to');
  });
});

describe('browser_take_screenshot format', () => {
  const mimeOf = async (params: Record<string, any>) => {
    const ctx = makeContext();
    const result = new BrowserToolResult(ctx);
    await screenshot.handle(ctx, params, result);
    const built = await result.build();
    return (built.content.find(c => c.type === 'image') as { mimeType: string }).mimeType;
  };

  it('defaults to jpeg', async () => expect(await mimeOf({})).toBe('image/jpeg'));
  it('honours an explicit png request', async () => expect(await mimeOf({ type: 'png' })).toBe('image/png'));
  it('follows a .png filename', async () => expect(await mimeOf({ filename: path.join(os.tmpdir(), 'pi-browser-test-shot.png') })).toBe('image/png'));
});

describe('element screenshots report what they could not capture', () => {
  const textFor = async (params: Record<string, any>) => {
    const ctx = makeContext();
    const result = new BrowserToolResult(ctx);
    await screenshot.handle(ctx, params, result);
    return ((await result.build()).content[0] as { text: string }).text;
  };

  it('warns when content overflows the element box and names the fix', async () => {
    const text = await textFor({ selector: '#scroller', fullPage: true });
    expect(text).toContain('320x2500 of content in a 320x200 box');
    expect(text).toContain('inner content element');
  });

  it('says fullPage does not apply to element screenshots', async () => {
    expect(await textFor({ selector: '#fits', fullPage: true })).toContain('fullPage does not apply');
  });
});
