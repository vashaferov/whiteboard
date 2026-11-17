import { expect, test } from '@playwright/test';

import {
  clickWorld,
  drawRect,
  lessonSetup,
  objectCount,
  openRoom,
  signInWith,
  worldToScreen,
} from '../helpers.js';

async function drawWithTool(page, tool, from, to) {
  await page.click(`[data-tool="${tool}"]`);
  const start = await worldToScreen(page, from);
  const end = await worldToScreen(page, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

async function eraseAt(page, from, to) {
  await page.click('[data-tool="eraser"]');
  const start = await worldToScreen(page, from);
  const end = await worldToScreen(page, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
}

test('eraser: removes brush strokes and leaves other objects', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Eraser strokes', student: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await drawWithTool(page, 'brush', { x: 100, y: 100 }, { x: 300, y: 100 });
  await drawRect(page, { x: 400, y: 300 }, { x: 520, y: 380 });
  await drawWithTool(page, 'process', { x: 600, y: 300 }, { x: 720, y: 380 });
  await expect.poll(() => objectCount(page)).toBe(3);

  await eraseAt(page, { x: 450, y: 330 }, { x: 480, y: 350 });
  await expect.poll(() => objectCount(page)).toBe(3);

  await eraseAt(page, { x: 120, y: 95 }, { x: 280, y: 95 });
  await expect.poll(() => objectCount(page)).toBe(2);

  await context.close();
});
