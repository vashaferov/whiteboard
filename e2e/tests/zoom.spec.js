import { expect, test } from '@playwright/test';

import {
  lessonSetup,
  objectCount,
  openRoom,
  signInWith,
  stageView,
  worldToScreen,
} from '../helpers.js';

async function openTeacherRoom(page, request) {
  const setup = await lessonSetup(request, { student: false });
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);
}

test('zoom controls change the view and reset to fit', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  const initialText = await page.locator('#zoom-reset').textContent();
  const fit = await stageView(page);

  await page.click('#zoom-in');
  await expect(page.locator('#zoom-reset')).not.toHaveText(initialText);
  const zoomed = await stageView(page);
  expect(zoomed.scaleX / fit.scaleX).toBeCloseTo(1.25, 2);

  await page.click('#zoom-reset');
  await expect(page.locator('#zoom-reset')).toHaveText(initialText);
  expect((await stageView(page)).scaleX).toBeCloseTo(fit.scaleX, 3);

  while (!(await page.locator('#zoom-out').isDisabled())) await page.click('#zoom-out');
  await expect(page.locator('#zoom-reset')).toHaveText('10%');

  while (!(await page.locator('#zoom-in').isDisabled())) await page.click('#zoom-in');
  await expect(page.locator('#zoom-reset')).toHaveText('400%');
});

test('dragging the empty canvas pans a zoomed board', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  await page.click('#zoom-in');
  await page.click('#zoom-in');
  await page.click('[data-tool="select"]');
  const before = await stageView(page);
  const box = await page.locator('#board-stage').boundingBox();
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 160, start.y - 120, { steps: 10 });
  await page.mouse.up();
  const after = await stageView(page);
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(10);
  expect(after.scaleX).toBeCloseTo(before.scaleX, 3);
});

test('drawing after zoom uses world coordinates', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  const initialText = await page.locator('#zoom-reset').textContent();
  await page.click('#zoom-in');
  await expect(page.locator('#zoom-reset')).not.toHaveText(initialText);
  await page.click('#zoom-in');

  const target = { x: 800, y: 450 };
  const screen = await worldToScreen(page, target);
  await page.click('[data-tool="brush"]');
  await page.mouse.move(screen.x, screen.y);
  await page.mouse.down();
  await page.mouse.move(screen.x + 60, screen.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => objectCount(page)).toBe(1);

  const first = await page.evaluate(() => {
    const layer = window.Konva.stages[0].getLayers()[1];
    const node = layer.getChildren((item) => item.className === 'Line' && item.id())[0];
    return node ? node.points().slice(0, 2) : null;
  });
  expect(Math.abs(first[0] - target.x)).toBeLessThan(2);
  expect(Math.abs(first[1] - target.y)).toBeLessThan(2);
});

test('resizing keeps the zoom', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  await page.click('#zoom-in');
  await page.click('#zoom-in');
  const zoomText = await page.locator('#zoom-reset').textContent();
  const before = await stageView(page);

  await page.setViewportSize({ width: 900, height: 600 });
  await expect(page.locator('#zoom-reset')).toHaveText(zoomText);
  const after = await stageView(page);
  expect(after.scaleX).toBeCloseTo(before.scaleX, 3);
});

test('export keeps the current zoom', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  const start = await worldToScreen(page, { x: 720, y: 400 });
  const end = await worldToScreen(page, { x: 880, y: 500 });
  await page.click('[data-tool="rect"]');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => objectCount(page)).toBe(1);

  await page.click('#zoom-in');
  const zoomText = await page.locator('#zoom-reset').textContent();
  const before = await stageView(page);

  await page.click('#room-more-btn');
  const download = page.waitForEvent('download');
  await page.click('#pdf-btn');
  await download;

  await expect(page.locator('#zoom-reset')).toHaveText(zoomText);
  const after = await stageView(page);
  expect(after.scaleX).toBeCloseTo(before.scaleX, 3);
  expect(after.x).toBeCloseTo(before.x, 1);
  expect(after.y).toBeCloseTo(before.y, 1);
});

async function worldUnderPagePoint(page, point) {
  return page.evaluate(({ pageX, pageY }) => {
    const stage = window.Konva.stages[0];
    const box = document.querySelector('#board').getBoundingClientRect();
    return {
      x: (pageX - box.x - stage.x()) / stage.scaleX(),
      y: (pageY - box.y - stage.y()) / stage.scaleY(),
    };
  }, point);
}

test('ctrl+wheel zooms around the cursor', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  const box = await page.locator('#board').boundingBox();
  const point = { pageX: box.x + box.width * 0.4, pageY: box.y + box.height * 0.4 };
  const before = await worldUnderPagePoint(page, point);

  await page.evaluate(({ pageX, pageY }) => {
    document.querySelector('#board-stage').dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -120,
        ctrlKey: true,
        clientX: pageX,
        clientY: pageY,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, point);

  await expect(page.locator('#zoom-reset')).not.toHaveText('100%');
  const after = await worldUnderPagePoint(page, point);
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
});

test('wheel pans a zoomed board', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  await page.click('#zoom-in');
  await page.click('#zoom-in');
  const before = await stageView(page);

  await page.evaluate(() => {
    document.querySelector('#board-stage').dispatchEvent(
      new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }),
    );
  });

  const after = await stageView(page);
  expect(after.y).toBeCloseTo(before.y - 120, 0);
  expect(after.x).toBeCloseTo(before.x, 0);
});

test('two fingers pinch, pan and do not leave stray objects', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  const before = await stageView(page);
  const box = await page.locator('#board').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });

  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: cx - 60, y: cy, id: 1 },
      { x: cx + 60, y: cy, id: 2 },
    ],
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: cx - 120, y: cy, id: 1 },
      { x: cx + 120, y: cy, id: 2 },
    ],
  });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  const after = await stageView(page);
  expect(after.scaleX / before.scaleX).toBeCloseTo(2, 1);
  expect(await objectCount(page)).toBe(0);

  // The room starts in Select; choose the brush for the one-finger stroke.
  await page.click('[data-tool="brush"]');
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: cx, y: cy, id: 3 }],
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: cx + 80, y: cy + 40, id: 3 }],
  });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => objectCount(page)).toBe(1);
});

test('keyboard zooms and resets', async ({ page, request }) => {
  await openTeacherRoom(page, request);
  const initialText = await page.locator('#zoom-reset').textContent();
  await page.keyboard.press('=');
  await expect(page.locator('#zoom-reset')).not.toHaveText(initialText);
  await page.keyboard.press('-');
  await expect(page.locator('#zoom-reset')).toHaveText(initialText);
  await page.keyboard.press('-');
  await expect(page.locator('#zoom-reset')).not.toHaveText(initialText);
  await page.keyboard.press('0');
  await expect(page.locator('#zoom-reset')).toHaveText(initialText);
});
