/**
 * Manual live verification against a real Chromium: `npx jiti@2 scripts/live-check.ts`.
 * Not part of the vitest suite — it launches a browser and hits the network.
 * Covers the things unit tests cannot: terse vs full result sizes on a real page,
 * the spill file, hover-intent popovers, and screenshot format/scroll-container notes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserSession } from '../src/browser-session.ts';
import { BrowserToolResult } from '../src/response.ts';
import type { Context } from '../src/context.ts';
import navigateTools from '../src/tools/navigate.ts';
import snapshotTools from '../src/tools/snapshot.ts';
import screenshotTools from '../src/tools/screenshot.ts';

const tools = new Map(
  [...navigateTools, ...snapshotTools, ...screenshotTools].map(t => [t.schema.name, t])
);
const SNAPSHOT_CAPABLE = new Set(['browser_navigate', 'browser_click', 'browser_hover']);

const session = new BrowserSession();

async function call(name: string, params: Record<string, any> = {}) {
  if (!session.context)
    await session.connect({ type: 'launch', browserName: 'chromium' }, { timeouts: { action: 10000, navigation: 30000 } });
  const ctx = session.context as Context;
  const result = new BrowserToolResult(ctx, SNAPSHOT_CAPABLE.has(name));
  if (params.snapshot) result.setIncludeSnapshot();
  await tools.get(name)!.handle(ctx, params, result);
  const built = await result.build();
  const text = (built.content[0] as any).text as string;
  const images = built.content.filter(c => c.type === 'image') as any[];
  return { text, bytes: Buffer.byteLength(text, 'utf8'), images };
}

const report = (label: string, r: { text: string; bytes: number }) =>
  console.log(`\n=== ${label} — ${r.bytes} bytes ===\n${r.text.slice(0, 700)}${r.text.length > 700 ? '\n…[cut for this log]' : ''}`);

const fixture = path.join(os.tmpdir(), 'pi-browser-live-fixture.html');
fs.writeFileSync(fixture, `<!doctype html><title>Live fixture</title>
<style>#tall{height:3000px;width:300px;background:linear-gradient(#fee,#eef)}#pop{display:none}</style>
<button id="btn">Open</button><div id="out"></div>
<div id="hoverme">hover target</div><div id="pop" role="note">POPOVER OPENED</div>
<div id="tall">tall element</div>
<div id="scrollbox" style="height:200px;width:320px;overflow:auto"><div style="height:2500px">scrolling content</div></div>
<div id="monster">${'x'.repeat(120000)}</div>
<ul>${Array.from({ length: 400 }, (_, i) => `<li><a href="#r${i}">row ${i} with some reasonably long label text</a></li>`).join('')}</ul>
<script>
  btn.onclick = () => out.textContent = 'CLICKED';
  // hover-intent: only opens after the pointer moves and then rests
  let t; hoverme.addEventListener('mousemove', () => { clearTimeout(t); t = setTimeout(() => pop.style.display = 'block', 250); });
</script>`);

// 1. Real page: terse navigate vs snapshot:true (the old unconditional behaviour)
const terseNav = await call('browser_navigate', { url: 'https://playwright.dev/' });
report('navigate playwright.dev (terse, new default)', terseNav);
const fullNav = await call('browser_navigate', { url: 'https://playwright.dev/', snapshot: true });
console.log(`\n=== navigate playwright.dev (snapshot: true, == old behaviour) — ${fullNav.bytes} bytes ===`);

// 2. Local fixture: click terse, explicit snapshot still full, oversized spills
await call('browser_navigate', { url: 'file://' + fixture });
const click = await call('browser_click', { selector: '#btn' });
report('click #btn (terse)', click);
console.log('clicked?', (await call('browser_snapshot', { selector: '#out' })).text.includes('CLICKED'));

const bigSnap = await call('browser_snapshot');
report('browser_snapshot full page (oversized → spill)', bigSnap);
const spillFile = bigSnap.text.match(/Full output written to (\S+)/)?.[1];
console.log('spill file bytes:', spillFile ? fs.statSync(spillFile).size : 'NONE');
console.log('spill file contains monster node whole:', spillFile ? fs.readFileSync(spillFile, 'utf8').includes('x'.repeat(120000)) : false);
console.log('spill file greppable for row 399:', spillFile ? fs.readFileSync(spillFile, 'utf8').includes('row 399') : false);

// 3. hover-intent popover
await call('browser_navigate', { url: 'file://' + fixture });
await call('browser_hover', { selector: '#hoverme' });
console.log('\npopover opened by browser_hover:', (await call('browser_snapshot', { selector: '#pop' })).text.includes('POPOVER'));

// 4. screenshots: default format + fullPage×selector
const png = await call('browser_take_screenshot', {});
console.log('default screenshot mime:', png.images[0].mimeType, 'bytes:', Buffer.from(png.images[0].data, 'base64').length);
const jpeg = await call('browser_take_screenshot', { type: 'jpeg' });
console.log('jpeg screenshot bytes:', Buffer.from(jpeg.images[0].data, 'base64').length);
const { execSync } = await import('node:child_process');
const tallPath = path.join(os.tmpdir(), 'pi-browser-tall.jpg');
const tallShot = await call('browser_take_screenshot', { selector: '#tall', fullPage: true, filename: tallPath });
console.log('tall element, fullPage+selector:', execSync(`file ${tallPath}`).toString().split(',').slice(-1)[0].trim());
console.log(tallShot.text.split('\n').filter(l => l.startsWith('Note:')).join('\n') || '(no note)');
const boxShot = await call('browser_take_screenshot', { selector: '#scrollbox' });
console.log('scroll container note:', boxShot.text.split('\n').filter(l => l.startsWith('Note:')).join('\n') || '(no note)');

await session.disconnect();
