// Headless-browser check for a rendered dependency graph.
// Usage: node check_graph.cjs <graph.html> <ticket-id-to-hover> [screenshot.png]
// Needs playwright-core and a local Chrome. Paths come from env vars, with the
// symphony-alpha checkout as the default source of playwright-core:
//   PLAYWRIGHT_CORE  path to the playwright-core package directory
//   CHROME_PATH      path to the Chrome executable
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const PW = process.env.PLAYWRIGHT_CORE ||
  path.join(process.env.HOME, 'Source/symphony-alpha/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const { chromium } = require(PW);

(async () => {
  const [file, hoverId, shot] = process.argv.slice(2);
  if (!file || !hoverId) {
    console.error('usage: node check_graph.cjs <graph.html> <ticket-id> [screenshot.png]');
    process.exit(2);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file://' + path.resolve(file));

  const structure = await page.evaluate(() => {
    const ids = new Set([...document.querySelectorAll('g.node')].map((g) => g.dataset.id));
    const edges = [...document.querySelectorAll('path.edge')];
    return {
      nodes: ids.size,
      edges: edges.length,
      danglingEdges: edges.filter((e) => !ids.has(e.dataset.from) || !ids.has(e.dataset.to)).length,
    };
  });
  const expected = await page.evaluate((id) => ({
    up: document.querySelectorAll(`path.edge[data-to="${id}"]`).length,
    down: document.querySelectorAll(`path.edge[data-from="${id}"]`).length,
  }), hoverId);

  const counts = () => page.evaluate(() => ({
    up: document.querySelectorAll('path.edge.up').length,
    down: document.querySelectorAll('path.edge.down').length,
    dimmed: document.querySelector('.depgraph svg').classList.contains('dimmed'),
  }));
  const node = page.locator(`g.node[data-id="${hoverId}"]`);
  await node.scrollIntoViewIfNeeded();
  await node.hover();
  const hover = await counts();
  if (shot) await page.screenshot({ path: shot, fullPage: true });
  await node.click();
  await page.mouse.move(2, 2);
  const pinned = await counts();
  const block = page.locator('.depgraph-block').first();
  const svgSize = () => block.locator('.depgraph svg').evaluate((svg) => ({
    width: svg.getBoundingClientRect().width,
    height: svg.getBoundingClientRect().height,
  }));
  const original = await svgSize();
  // The graph opens zoomed to fit its frame; that zoom is what reset and 0 return to.
  const fitLabel = await block.locator('.dg-zoom-reset').innerText();
  const fit = await block.evaluate((element) => element.__dgZoom.fit);
  await block.locator('.dg-zoom-in').click();
  const enlarged = await svgSize();
  assert(enlarged.width > original.width && enlarged.height > original.height, 'Zoom in must enlarge the drawing');
  assert.deepEqual(await counts(), pinned, 'Zoom must preserve the pinned chain');
  await block.locator('.dg-zoom-out').click();
  assert(Math.abs((await svgSize()).width - original.width) < 1, 'Zoom out must undo zoom in');
  await block.locator('.depgraph').focus();
  await page.keyboard.press('-');
  assert((await svgSize()).width < original.width, 'Keyboard minus must zoom out');
  await page.keyboard.press('0');
  assert(Math.abs((await svgSize()).width - original.width) < 1, 'Keyboard zero must reset zoom');

  // Pinch/Ctrl-wheel zooms, while unmodified wheel events remain scroll events.
  const wheel = (ctrlKey) => block.locator('.depgraph').evaluate((viewport, modified) => {
    const rect = viewport.getBoundingClientRect();
    const event = new WheelEvent('wheel', {
      deltaY: -40, ctrlKey: modified, cancelable: true, bubbles: true,
      clientX: rect.left + 150, clientY: rect.top + 150,
    });
    viewport.dispatchEvent(event);
    return event.defaultPrevented;
  }, ctrlKey);
  assert.equal(await wheel(false), false, 'Normal scrolling must remain native');
  assert(Math.abs((await svgSize()).width - original.width) < 1);
  assert.equal(await wheel(true), true, 'Modified wheel must zoom within the graph');
  assert((await svgSize()).width > original.width);
  await block.locator('.dg-zoom-reset').click();

  // Limits prevent unbounded sizes and disable the corresponding control.
  for (let i = 0; i < 16; i++) {
    if (await block.locator('.dg-zoom-in').isDisabled()) break;
    await block.locator('.dg-zoom-in').click();
  }
  assert.equal(await block.locator('.dg-zoom-reset').innerText(), '300%');
  assert(await block.locator('.dg-zoom-in').isDisabled());
  await block.locator('.dg-zoom-reset').click();
  for (let i = 0; i < 16; i++) {
    if (await block.locator('.dg-zoom-out').isDisabled()) break;
    await block.locator('.dg-zoom-out').click();
  }
  assert.equal(await block.locator('.dg-zoom-reset').innerText(), Math.round(Math.min(.25, fit) * 100) + '%');
  assert(await block.locator('.dg-zoom-out').isDisabled());
  await block.locator('.dg-zoom-reset').click();
  await page.keyboard.press('Escape');
  const cleared = await counts();

  // Stub refresh locally; never call ClosedLoop while running browser checks.
  let refreshZoom = null;
  if (await block.locator('.dg-reload').count()) {
    await block.locator('.dg-zoom-in').click();
    const beforeRefresh = await block.locator('.dg-zoom-reset').innerText();
    const html = await block.evaluate((element) => element.outerHTML);
    await page.route('http://127.0.0.1:*/refresh?**', (route) => route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ ok: true, html, summary: 'Test refresh. No changes.', changes: [] }),
    }));
    await block.locator('.dg-reload').click();
    await block.locator('.dg-dialog[open]').waitFor();
    refreshZoom = await block.locator('.dg-zoom-reset').innerText();
    assert.equal(refreshZoom, beforeRefresh, 'Refresh must retain the current zoom');
    await block.locator('.dg-dialog button').click();
    await block.locator('.dg-zoom-out').click();
    assert.equal(await block.locator('.dg-zoom-reset').innerText(), fitLabel, 'Refreshed controls must remain live');
  }

  // Save menu: one toolbar menu open at a time, Save Image downloads a PNG, Copy Image puts one on the clipboard.
  let saved = null;
  if (await block.locator('.dg-save').count()) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const saveMenu = block.locator('.dg-save-menu');
    await block.locator('.dg-save').click();
    assert(await saveMenu.isVisible(), 'The save button must open its menu');
    if (await block.locator('.dg-gear').count()) {
      await block.locator('.dg-gear').click();
      assert(await saveMenu.isHidden(), 'Opening the gear menu must close the save menu');
      await block.locator('.dg-save').click();
    }
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      block.locator('.dg-save-menu [data-action="save"]').click(),
    ]);
    const png = fs.readFileSync(await download.path());
    assert.equal(png.subarray(1, 4).toString(), 'PNG', 'Save Image must download a PNG');
    await block.locator('.dg-save').click();
    await block.locator('.dg-save-menu [data-action="copy"]').click();
    await block.locator('.dg-status', { hasText: 'copied' }).waitFor();
    const clipboard = await page.evaluate(async () => (await navigator.clipboard.read())[0].types);
    assert(clipboard.includes('image/png'), 'Copy Image must put a PNG on the clipboard');
    saved = { file: download.suggestedFilename(), width: png.readUInt32BE(16), height: png.readUInt32BE(20), clipboard };
  }

  const ok = structure.danglingEdges === 0 && errors.length === 0 &&
    hover.up === expected.up && hover.down === expected.down &&
    pinned.up >= expected.up && pinned.down >= expected.down && !cleared.dimmed;
  console.log(JSON.stringify({ ok, structure, expected, hover, pinned, cleared, zoom: { fit: fitLabel, original, enlarged, refreshZoom }, saved, errors }, null, 1));
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });
