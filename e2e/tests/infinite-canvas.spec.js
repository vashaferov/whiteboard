import { expect, test } from '@playwright/test';

import {
  lessonSetup,
  objectCount,
  openRoom,
  reloadAndWait,
  signInWith,
  worldToScreen,
} from '../helpers.js';

test('infinite page pans past the old sheet, keeps drawing and fits content', async ({
  page,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Infinite canvas', student: false });
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await expect(page.locator('#zoom-reset')).toHaveText(/^\d+%$/);
  const paperVisible = await page.evaluate(
    () => window.Konva.stages[0].getLayers()[0].getChildren()[0].visible(),
  );
  expect(paperVisible).toBe(false);

  const box = await page.locator('#board-stage').boundingBox();
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await page.click('[data-tool="brush"]');
  const outside = await worldToScreen(page, { x: -400, y: 300 });
  await page.mouse.move(outside.x, outside.y);
  await page.mouse.down();
  await page.mouse.move(outside.x + 60, outside.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => objectCount(page)).toBe(1);
  const firstPoint = await page.evaluate(() => {
    const layer = window.Konva.stages[0].getLayers()[1];
    const node = layer.getChildren((item) => item.className === 'Line' && item.id())[0];
    return node ? node.points().slice(0, 2) : null;
  });
  expect(firstPoint[0]).toBeLessThan(0);

  await page.click('[data-tool="select"]');
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 600, center.y + 400, { steps: 12 });
  await page.mouse.up();

  await page.click('[data-tool="brush"]');
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 80, center.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => objectCount(page)).toBe(2);

  const beforeFit = await page.evaluate(() => {
    const stage = window.Konva.stages[0];
    return { x: stage.x(), y: stage.y(), scale: stage.scaleX() };
  });
  await page.click('#zoom-reset');
  const afterFit = await page.evaluate(() => {
    const stage = window.Konva.stages[0];
    return { x: stage.x(), y: stage.y(), scale: stage.scaleX() };
  });
  expect(afterFit).not.toEqual(beforeFit);
  expect(afterFit.scale).toBeLessThanOrEqual(1);

  await reloadAndWait(page);
  await expect.poll(() => objectCount(page)).toBe(2);
});
