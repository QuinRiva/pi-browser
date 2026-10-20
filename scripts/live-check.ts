/**
 * Manual live verification against a real Chromium: `npx jiti@2 scripts/live-check.ts`.
 * Not part of the vitest suite — it launches a browser and hits the network.
 * Covers the things unit tests cannot: terse vs full result sizes on a real page,
 * the spill file, hover-intent popovers, screenshot format/scroll-container notes,
 * and click-by-ref. Calls go through the extension's registered tools (a stub pi),
 * so error hints and wiring are the real ones; pi's batch scheduling is not exercised.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import extension from '../index.ts';

const tools = new Map<string, any>();
const shutdown: Function[] = [];
extension({
  registerTool: (t: any) => tools.set(t.name, t),
  registerCommand: () => {},
  on: (event: string, fn: Function) => { if (event === 'session_shutdown') shutdown.push(fn); },
} as any);

async function call(name: string, params: Record<string, any> = {}) {
  const built = await tools.get(name)!.execute('live', params);
  const text = (built.content[0] as any).text as string;
  const images = built.content.filter((c: any) => c.type === 'image') as any[];
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

// 5. click by ref: refs from a full-page and a selector-scoped snapshot both resolve
await call('browser_navigate', { url: 'file://' + fixture });
const full = await call('browser_snapshot');
const fullText = fs.readFileSync(full.text.match(/Full output written to (\S+)/)?.[1] ?? '/dev/null', 'utf8') || full.text;
const fullRef = fullText.match(/button "Open" \[ref=(e\d+)\]/)?.[1];
console.log('\nfull snapshot ref for #btn:', fullRef);
const refClick = await call('browser_click', { ref: fullRef });
console.log(refClick.text.split('\n').find(l => l.includes('aria-ref')));
console.log('clicked by full-snapshot ref?', (await call('browser_evaluate', { function: '() => out.textContent' })).text.includes('CLICKED'));

await call('browser_navigate', { url: 'file://' + fixture });
const scoped = await call('browser_snapshot', { selector: '#btn' });
console.log('scoped snapshot:', scoped.text.trim());
const scopedRef = scoped.text.match(/\[ref=(e\d+)\]/)?.[1];
await call('browser_click', { ref: scopedRef });
console.log('clicked by scoped-snapshot ref?', (await call('browser_evaluate', { function: '() => out.textContent' })).text.includes('CLICKED'));

// 6. failures carry the snapshot-and-ref hint, within the action timeout
await call('browser_navigate', { url: 'file://' + fixture });
for (const [label, params] of [
  ['stale ref (after navigate)', { ref: scopedRef }],
  ['selector matching nothing', { selector: '#nope' }],
  ['ambiguous selector (strict mode)', { selector: 'li' }],
] as const) {
  const t0 = Date.now();
  const err = await call('browser_click', params).then(() => null, (e: Error) => e.message);
  console.log(`\n${label}: failed=${err !== null} after ${Date.now() - t0}ms, hint=${!!err?.includes('use its ref (e.g. ref: "e12")')}\n  ${err?.split('\n')[0]}\n  ${err?.split('\n').slice(-1)[0]}`);
}

// 7. cost of the [ref=eN] markers: raw full-page snapshot, default vs ai mode
const browser = await chromium.launch();
const page = await browser.newPage();
for (const url of ['file://' + fixture, 'https://playwright.dev/', 'https://github.com/microsoft/playwright']) {
  await page.goto(url, { waitUntil: 'load' });
  const [d, a] = [await page.locator(':root').ariaSnapshot(), await page.locator(':root').ariaSnapshot({ mode: 'ai' })];
  const [db, ab] = [Buffer.byteLength(d), Buffer.byteLength(a)];
  console.log(`snapshot bytes ${url}: default ${db}, ai ${ab} (+${((ab / db - 1) * 100).toFixed(0)}%)`);
}
await browser.close();

for (const fn of shutdown) await fn();
