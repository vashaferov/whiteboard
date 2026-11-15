import { expect, test } from '@playwright/test';

import {
  activePageName,
  boardBox,
  createPage,
  drawRect,
  login,
  objectCount,
  selectPage,
  selectedShape,
  uniqueRoom,
  worldToScreen,
} from '../helpers.js';

test('mobile: toolbar is usable and drawing works on a phone viewport', async ({
  page,
}) => {
  const room = uniqueRoom('mobile');
  await login(page, { name: 'Учитель', role: 'teacher', room });

  // Pages panel is visible as a horizontal strip and the first page is active.
  await expect(page.locator('#pages-panel')).toBeVisible();
  expect(await activePageName(page)).toBe('Страница 1');

  const box = await boardBox(page);
  expect(box.width).toBeGreaterThan(200);
  expect(box.height).toBeGreaterThan(200);

  const tools = page.locator('#tools');
  await expect(tools).toBeVisible();
  await expect(page.locator('[data-tool="rect"]')).toBeVisible();
  await expect(page.locator('[data-tool="text"]')).toBeVisible();
  await expect(page.locator('[data-tool="select"]')).toBeVisible();

  // Touch-capable context: tapping the tool button works, then draw.
  await page.tap('[data-tool="rect"]');
  await drawRect(page, { x: 380, y: 260 }, { x: 560, y: 380 });
  expect(await objectCount(page)).toBe(1);

  // Text editing opens inside the viewport.
  await page.tap('[data-tool="text"]');
  const textPoint = await worldToScreen(page, { x: 420, y: 500 });
  await page.touchscreen.tap(textPoint.x, textPoint.y);
  await expect(page.locator('#text-editor')).toBeVisible();
  const editor = await page.locator('#text-editor').boundingBox();
  expect(editor.x).toBeGreaterThanOrEqual(0);
  expect(editor.y).toBeGreaterThanOrEqual(0);
  await page.fill('#text-editor', 'С телефона');
  await page.press('#text-editor', 'Enter');

  expect(await objectCount(page)).toBe(2);
  await page.tap('[data-tool="select"]');
  const rectCenter = await worldToScreen(page, { x: 470, y: 320 });
  await page.touchscreen.tap(rectCenter.x, rectCenter.y);
  expect((await selectedShape(page)).width).toBeGreaterThan(0);

  // Creating a page and switching back updates the active page name.
  await createPage(page, 'Мобильная');
  await expect.poll(() => activePageName(page)).toBe('Мобильная');
  await selectPage(page, 'Страница 1');
  await expect.poll(() => activePageName(page)).toBe('Страница 1');
});
