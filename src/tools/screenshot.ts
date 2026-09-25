import fs from 'node:fs';
import path from 'node:path';
import { defineTabTool } from '../tool';

export const screenshot = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_take_screenshot',
    title: 'Take a screenshot',
    description: "Take a screenshot of the current page. You can't interact based on screenshots; use browser_snapshot for that. Defaults to PNG so small text and thin lines stay crisp; type: 'jpeg' (q80) costs the same tokens and about a third of the bytes when size on disk or on the wire matters more than fidelity. Pass filename to also save the image to disk (e.g. for evidence in a report); the saved path is returned in the result, and the format follows the filename extension unless type says otherwise. With a selector the element is captured in full (fullPage applies to the page only); if content overflows the element's box the result says so and names the fix.",
    type: 'readOnly',
  },
  handle: async (tab, params, result) => {
    const fromFilename = /\.jpe?g$/i.test(String(params.filename ?? '')) ? 'jpeg' : undefined;
    const imageType: 'png' | 'jpeg' = (params.type ?? fromFilename) === 'jpeg' ? 'jpeg' : 'png';
    const options: Record<string, any> = {
      type: imageType,
      scale: 'css',
      ...tab.actionTimeoutOptions,
    };
    if (imageType === 'jpeg') options.quality = 80;

    let data: Buffer;
    let codeTarget: string;
    if (params.selector) {
      // An element screenshot captures the whole element, so fullPage says nothing here —
      // except when content overflows the element's box, which silently loses the rest.
      const { locator, resolved } = await tab.refLocator({ selector: params.selector });
      data = await locator.screenshot(options);
      codeTarget = `page.${resolved}.screenshot(...)`;
      const box = await locator.evaluate(el => ({
        clientH: el.clientHeight, scrollH: el.scrollHeight,
        clientW: el.clientWidth, scrollW: el.scrollWidth,
      }));
      if (box.scrollH > box.clientH + 1 || box.scrollW > box.clientW + 1)
        result.addTextResult(`Note: ${params.selector} holds ${box.scrollW}x${box.scrollH} of content in a ${box.clientW}x${box.clientH} box, so the image shows the element box only. Screenshot the inner content element to capture the rest${params.fullPage ? ' (fullPage does not apply to element screenshots)' : ''}.`);
      else if (params.fullPage)
        result.addTextResult('Note: fullPage does not apply to element screenshots; the element was captured in full.');
    } else {
      if (params.fullPage !== undefined) options.fullPage = params.fullPage;
      data = await tab.page.screenshot(options);
      codeTarget = 'page.screenshot(...)';
    }

    result.addCode(`// ${codeTarget}`);

    if (params.filename) {
      const savePath = path.resolve(String(params.filename));
      await fs.promises.mkdir(path.dirname(savePath), { recursive: true });
      await fs.promises.writeFile(savePath, data);
      result.addTextResult(`Screenshot saved to ${savePath}`);
    }

    await result.registerImageResult(data, imageType);
  },
});

export default [screenshot];
