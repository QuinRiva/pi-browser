/**
 * BrowserToolResult - pi-compatible result builder for browser tools.
 *
 * Mirrors the section-building logic from playwright-core Response class
 * but outputs pi's { content, details } shape instead of MCP's CallToolResult.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context } from './context';

/** Results larger than this spill to a file instead of living in the agent's context. */
const SPILL_THRESHOLD_BYTES = 20_000;
/** How much of an oversized section is kept inline. */
const EXCERPT_BYTES = 4_000;
/** Per-line bound applied to the inline excerpt only; the spill file keeps every character. */
const MAX_LINE_CHARS = 600;

export type PiToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  details: Record<string, any>;
  isError?: boolean;
};

type Section = {
  title: string;
  content: string[];
  isError?: boolean;
  codeframe?: 'yaml' | 'js';
};

export class BrowserToolResult {
  private _results: string[] = [];
  private _errors: string[] = [];
  private _code: string[] = [];
  private _context: Context;
  private _includeSnapshot = false;
  private _imageResults: Array<{ data: Buffer; imageType: 'png' | 'jpeg' }> = [];
  private _isClose = false;
  private _snapshotCapable: boolean;

  constructor(context: Context, snapshotCapable = false) {
    this._context = context;
    this._snapshotCapable = snapshotCapable;
  }

  addTextResult(text: string) {
    this._results.push(text);
  }

  addError(error: string) {
    this._errors.push(error);
  }

  addCode(code: string) {
    this._code.push(code);
  }

  setIncludeSnapshot() {
    this._includeSnapshot = true;
  }

  async registerImageResult(data: Buffer, imageType: 'png' | 'jpeg') {
    this._imageResults.push({ data, imageType });
  }

  setClose() {
    this._isClose = true;
  }

  async build(): Promise<PiToolResult> {
    const sections: Section[] = [];

    if (this._errors.length)
      sections.push({ title: 'Error', content: this._errors, isError: true });

    if (this._results.length)
      sections.push({ title: 'Result', content: this._results });

    if (this._code.length)
      sections.push({ title: 'Ran Playwright code', content: this._code, codeframe: 'js' });

    // Tab headers — Playwright-controlled tabs
    const tabHeaders = await Promise.all(
      this._context.tabs().map(tab => tab.headerSnapshot())
    );
    // Also include CDP-only tabs (other windows)
    const cdpHeaders: TabHeader[] = this._context.cdpOnlyTargets().map(t => ({
      title: t.title,
      url: t.url,
      current: false,
    }));
    const allHeaders = [...tabHeaders, ...cdpHeaders];

    if (allHeaders.length > 1)
      sections.push({ title: 'Open tabs', content: renderTabsMarkdown(allHeaders) });

    if (tabHeaders.length > 0) {
      const current = tabHeaders.find(h => h.current) ?? tabHeaders[0];
      sections.push({ title: 'Page', content: renderTabMarkdown(current) });
    }

    if (this._context.tabs().length === 0)
      this._isClose = true;

    // Modal state comes before the snapshot: a dialog or file chooser blocks every
    // later action, so it is the one thing that must never be pushed out of sight.
    const currentTab = this._context.currentTab();
    const modalStates = currentTab?.modalStates() ?? [];
    if (modalStates.length) {
      sections.push({
        title: 'Modal state',
        content: modalStates.map(s => `- [${s.description}]: use appropriate tool to handle`),
      });
    }

    // Snapshot — opt-in. Interaction tools say so rather than silently omitting it.
    if (this._includeSnapshot && currentTab) {
      const tabSnapshot = await currentTab.captureSnapshot(undefined);
      if (tabSnapshot?.ariaSnapshot)
        sections.push({ title: 'Snapshot', content: [tabSnapshot.ariaSnapshot], codeframe: 'yaml' });
    } else if (currentTab && this._snapshotCapable) {
      sections.push({
        title: 'Snapshot',
        content: ['Omitted. Pass snapshot: true to this tool, or call browser_snapshot, when you need the accessibility tree.'],
      });
    }

    const content: PiToolResult['content'] = [
      { type: 'text', text: spillIfOversized(sections) },
    ];

    for (const img of this._imageResults) {
      content.push({
        type: 'image',
        data: img.data.toString('base64'),
        mimeType: img.imageType === 'png' ? 'image/png' : 'image/jpeg',
      });
    }

    return {
      content,
      details: {
        tabs: tabHeaders,
        isClose: this._isClose,
      },
      isError: sections.some(s => s.isError),
    };
  }
}

function renderSections(sections: Section[]): string {
  const lines: string[] = [];
  for (const section of sections) {
    if (!section.content.length) continue;
    lines.push(`### ${section.title}`);
    if (section.codeframe) lines.push(`\`\`\`${section.codeframe}`);
    lines.push(...section.content);
    if (section.codeframe) lines.push('```');
  }
  return lines.join('\n');
}

/**
 * Oversized results are written in full to a file and represented inline by bounded
 * excerpts plus that path, so the agent can rg the file instead of carrying it in
 * context. Excerpting is per section: only the sections that are actually big get cut,
 * so the page header, errors and modal state always survive inline.
 */
function spillIfOversized(sections: Section[]): string {
  const text = renderSections(sections);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= SPILL_THRESHOLD_BYTES) return text;

  const dir = path.join(os.tmpdir(), 'pi-browser-results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(file, text, 'utf8');

  const excerpted = sections.map(s =>
    Buffer.byteLength(s.content.join('\n'), 'utf8') > EXCERPT_BYTES ? { ...s, content: [excerpt(s.content)] } : s
  );
  return [
    renderSections(excerpted),
    '',
    `[Result excerpted: ${Math.round(bytes / 1024)}KB total. Full output written to ${file} — read or rg that file for the rest.]`,
  ].join('\n');
}

/** First EXCERPT_BYTES of a section, with long lines bounded so one giant node cannot fill it. */
function excerpt(content: string[]): string {
  const clamped = content
    .join('\n')
    .split('\n')
    .map(l => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)} … [+${l.length - MAX_LINE_CHARS} chars, see file]` : l))
    .join('\n');
  const buf = Buffer.from(clamped, 'utf8');
  // Bounding long lines can already bring a section under the limit; only drop a trailing
  // line when the cut actually lands mid-content.
  return buf.length <= EXCERPT_BYTES ? clamped : buf.subarray(0, EXCERPT_BYTES).toString('utf8').replace(/\n[^\n]*$/, '');
}

export type TabHeader = {
  title: string;
  url: string;
  current: boolean;
};

function renderTabMarkdown(tab: TabHeader): string[] {
  const lines = [`- Page URL: ${tab.url}`];
  if (tab.title) lines.push(`- Page Title: ${tab.title}`);
  return lines;
}

function renderTabsMarkdown(tabs: TabHeader[]): string[] {
  if (!tabs.length)
    return ['No open tabs. Use browser_navigate to open a URL.'];
  return tabs.map((tab, i) => {
    const cur = tab.current ? ' (current)' : '';
    return `- ${i}:${cur} [${tab.title}](${tab.url})`;
  });
}
