import { expect, test } from '@playwright/test';

import {
  drawRect,
  lessonSetup,
  objectCount,
  openRoom,
  openLesson,
  signInWith,
  worldToScreen,
} from '../helpers.js';

async function eraseAt(page, point) {
  await page.click('[data-tool="eraser"]');
  const screen = await worldToScreen(page, point);
  await page.mouse.move(screen.x, screen.y);
  await page.mouse.down();
  await page.mouse.up();
}

test('eraser removes shapes and frame contents but keeps the frame', async ({ page, request }) => {
  const setup = await lessonSetup(request, { name: 'Eraser all', student: false });
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await drawRect(page, { x: 600, y: 300 }, { x: 800, y: 420 });
  await expect.poll(() => objectCount(page)).toBe(1);
  await eraseAt(page, { x: 700, y: 360 });
  await expect.poll(() => objectCount(page)).toBe(0);

  await page.click('[data-tool="frame"]');
  const frameStart = await worldToScreen(page, { x: 500, y: 250 });
  const frameEnd = await worldToScreen(page, { x: 1000, y: 700 });
  await page.mouse.move(frameStart.x, frameStart.y);
  await page.mouse.down();
  await page.mouse.move(frameEnd.x, frameEnd.y, { steps: 8 });
  await page.mouse.up();
  await drawRect(page, { x: 650, y: 350 }, { x: 750, y: 450 });
  await expect.poll(() => objectCount(page)).toBe(2);

  await eraseAt(page, { x: 700, y: 400 });
  await expect.poll(() => objectCount(page)).toBe(1);

  await eraseAt(page, { x: 500, y: 500 });
  await expect.poll(() => objectCount(page)).toBe(0);
});

test('lasso moves and deletes a group with one undo', async ({ page, request }) => {
  const setup = await lessonSetup(request, { name: 'Lasso', student: false });
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await drawRect(page, { x: 600, y: 300 }, { x: 700, y: 380 });
  await drawRect(page, { x: 760, y: 300 }, { x: 860, y: 380 });
  await expect.poll(() => objectCount(page)).toBe(2);

  await page.click('[data-tool="lasso"]');
  const from = await worldToScreen(page, { x: 560, y: 260 });
  const to = await worldToScreen(page, { x: 900, y: 420 });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();

  await expect
    .poll(() =>
      page.evaluate(() => window.Konva.stages[0].findOne('Transformer').nodes().length),
    )
    .toBe(2);

  const dragFrom = await worldToScreen(page, { x: 650, y: 340 });
  await page.mouse.move(dragFrom.x, dragFrom.y);
  await page.mouse.down();
  await page.mouse.move(dragFrom.x + 80, dragFrom.y + 60, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  await page.keyboard.press('Delete');
  await expect.poll(() => objectCount(page)).toBe(0);
  await page.keyboard.press('Control+z');
  await expect.poll(() => objectCount(page)).toBe(2);
});

test('lasso does not select foreign objects for a student', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Lasso rights' });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );

  await drawRect(teacher, { x: 600, y: 300 }, { x: 760, y: 400 });
  await expect.poll(() => objectCount(student)).toBe(1);

  await student.click('[data-tool="lasso"]');
  const from = await worldToScreen(student, { x: 560, y: 260 });
  const to = await worldToScreen(student, { x: 820, y: 440 });
  await student.mouse.move(from.x, from.y);
  await student.mouse.down();
  await student.mouse.move(to.x, to.y, { steps: 10 });
  await student.mouse.up();

  await expect
    .poll(() =>
      student.evaluate(() => window.Konva.stages[0].findOne('Transformer').nodes().length),
    )
    .toBe(0);
  await student.keyboard.press('Delete');
  await student.waitForTimeout(200);
  expect(await objectCount(student)).toBe(1);

  await teacherContext.close();
  await studentContext.close();
});
