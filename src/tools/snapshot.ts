import { defineTool, defineTabTool } from '../tool';

export const snapshot = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_snapshot',
    title: 'Page snapshot',
    description: [
      'Capture the accessibility tree of the current page to identify elements for interaction.',
      'Use this to find element refs before clicking, typing, or filling forms.',
      'Action tools no longer return a tree unless you pass snapshot: true, so call this when you need one — but prefer the selector param to scope it, or browser_evaluate to read one specific value, since a whole-page tree is the most expensive thing a browser tool can return.',
      'Oversized output is excerpted inline and written in full to a file whose path is returned; rg that file for the rest.',
    ].join(' '),
    type: 'readOnly',
  },
  handle: async (context, params, result) => {
    await context.ensureTab();
    const tab = context.currentTabOrDie();
    const snap = await tab.captureSnapshot(params.selector);
    // Oversized trees are excerpted and spilled to a file by the result builder.
    result.addTextResult(snap?.ariaSnapshot || '(empty snapshot)');
  },
});

export const click = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_click',
    title: 'Click',
    description: 'Perform a click on a web page element',
    type: 'input',
  },
  handle: async (tab, params, result) => {
    const { locator, resolved } = await tab.refLocator(params);
    const options: Record<string, any> = {};
    if (params.button) options.button = params.button;
    if (params.modifiers) options.modifiers = params.modifiers;
    if (Object.keys(options).length > 0)
      Object.assign(options, tab.actionTimeoutOptions);
    else
      Object.assign(options, tab.actionTimeoutOptions);

    if (params.doubleClick) {
      await tab.waitForCompletion(() => locator.dblclick(options));
      result.addCode(`await page.${resolved}.dblclick();`);
    } else {
      await tab.waitForCompletion(() => locator.click(options));
      result.addCode(`await page.${resolved}.click();`);
    }
  },
});

export const hover = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_hover',
    title: 'Hover mouse',
    description: 'Hover over an element on the page. Dispatches a real pointer move and then waits (default 400ms, override with settleMs) so hover-intent popovers and tooltips actually open.',
    type: 'input',
  },
  handle: async (tab, params, result) => {
    const { locator, resolved } = await tab.refLocator(params);
    await tab.waitForCompletion(() => locator.hover(tab.actionTimeoutOptions));
    // Playwright's hover() lands a single synthetic move, which hover-intent UIs
    // (Base UI, Radix) ignore. Nudge the real mouse across the element and settle.
    const box = await locator.boundingBox();
    if (box) {
      const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
      await tab.page.mouse.move(x - Math.min(20, box.width / 2), y);
      await tab.page.mouse.move(x, y, { steps: 6 });
    }
    await tab.page.waitForTimeout(Math.min(5000, params.settleMs ?? 400));
    result.addCode(`await page.${resolved}.hover();`);
  },
});

export const selectOption = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_select_option',
    title: 'Select option',
    description: 'Select an option in a dropdown',
    type: 'input',
  },
  handle: async (tab, params, result) => {
    const { locator, resolved } = await tab.refLocator(params);
    await tab.waitForCompletion(async () => { await locator.selectOption(params.values, tab.actionTimeoutOptions); });
    result.addCode(`await page.${resolved}.selectOption(${JSON.stringify(params.values)});`);
  },
});

export const drag = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_drag',
    title: 'Drag mouse',
    description: 'Perform drag and drop between two elements',
    type: 'input',
  },
  handle: async (tab, params, result) => {
    const start = await tab.refLocator({ ref: params.startRef, selector: params.startSelector, element: params.startElement });
    const end = await tab.refLocator({ ref: params.endRef, selector: params.endSelector, element: params.endElement });
    await tab.waitForCompletion(async () => { await start.locator.dragTo(end.locator, tab.actionTimeoutOptions); return; });
    result.addCode(`await page.${start.resolved}.dragTo(page.${end.resolved});`);
  },
});

export default [snapshot, click, hover, selectOption, drag];
