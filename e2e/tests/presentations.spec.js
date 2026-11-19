import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { lessonSetup, objectCount, openRoom, signInWith, worldToScreen } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDF = path.resolve(__dirname, '../../backend/tests/fixtures/two-slides.pdf');

async function drawBrush(page, from, to) {
  await page.click('[data-tool="brush"]');
  const start = await worldToScreen(page, from);
  const end = await worldToScreen(page, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

async function slideName(page) {
  return page.evaluate(() => {
    const layer = window.Konva.stages[0].getLayers()[0];
    const node = layer.findOne('.slide-bg');
    return node ? node.attrs.width && node.attrs.height : null;
  });
}

test('presentation: teacher uploads a PDF, edits slides and a student only watches', async ({
  browser,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Presentation', student: true });
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();
  await signInWith(request, teacher, setup.teacherLogin);
  await openRoom(teacher, setup.room.id);
  await signInWith(request, student, setup.studentLogin);
  await openRoom(student, setup.room.id);

  await teacher.setInputFiles('#presentation-input', PDF);
  await expect.poll(() => teacher.locator('.page--presentation').count()).toBe(1);
  await expect.poll(() => teacher.locator('#slide-counter').textContent()).toBe('1 / 2');
  await expect.poll(() => slideName(teacher)).not.toBeNull();

  const visibleTools = teacher.locator('[data-tool]:visible');
  await expect(visibleTools).toHaveCount(1);
  await expect(visibleTools.first()).toHaveAttribute('data-tool', 'brush');

  const slideCanvas = await teacher.evaluate(() => {
    const layer = window.Konva.stages[0].getLayers()[0];
    const background = layer.findOne('.slide-bg');
    return {
      width: background.width(),
      height: background.height(),
      naturalWidth: background.image().naturalWidth,
      naturalHeight: background.image().naturalHeight,
      paper: layer.getChildren()[0].visible(),
      grid: layer.getChildren()[1].visible(),
    };
  });
  expect(slideCanvas.width).toBe(slideCanvas.naturalWidth);
  expect(slideCanvas.height).toBe(slideCanvas.naturalHeight);
  expect(slideCanvas.paper).toBe(false);
  expect(slideCanvas.grid).toBe(false);

  await drawBrush(teacher, { x: 120, y: 120 }, { x: 320, y: 120 });
  await expect.poll(() => objectCount(teacher)).toBe(1);

  await teacher.click('#slide-next');
  await expect.poll(() => teacher.locator('#slide-counter').textContent()).toBe('2 / 2');
  await expect.poll(() => objectCount(teacher)).toBe(0);
  await drawBrush(teacher, { x: 420, y: 220 }, { x: 620, y: 220 });
  await expect.poll(() => objectCount(teacher)).toBe(1);
  await expect(teacher.locator('#undo-btn')).toBeVisible();
  await teacher.click('#undo-btn');
  await expect.poll(() => objectCount(teacher)).toBe(0);
  await drawBrush(teacher, { x: 420, y: 220 }, { x: 620, y: 220 });
  await expect.poll(() => objectCount(teacher)).toBe(1);

  await teacher.click('#slide-prev');
  await expect.poll(() => teacher.locator('#slide-counter').textContent()).toBe('1 / 2');
  await expect.poll(() => objectCount(teacher)).toBe(1);

  await student.locator('.page--presentation .page__select').click();
  await expect.poll(() => student.locator('#slide-counter').textContent()).toBe('1 / 2');
  await expect.poll(() => slideName(student)).not.toBeNull();
  await expect(student.locator('[data-tool]:visible')).toHaveCount(0);
  await expect(student.locator('#slide-next')).toBeHidden();
  await expect(student.locator('#slide-prev')).toBeHidden();
  await expect(student.locator('#page-presentation')).toBeHidden();
  await expect.poll(() => objectCount(student)).toBe(1);

  const start = await worldToScreen(student, { x: 200, y: 300 });
  await student.mouse.move(start.x, start.y);
  await student.mouse.down();
  await student.mouse.move(start.x + 120, start.y + 80, { steps: 8 });
  await student.mouse.up();
  await student.waitForTimeout(300);
  expect(await objectCount(student)).toBe(1);

  await expect(student.locator('#undo-btn')).toBeHidden();
  await teacher.click('#undo-btn');
  await expect.poll(() => objectCount(teacher)).toBe(0);
  await expect.poll(() => objectCount(student)).toBe(0);

  await student.click('#zoom-in');
  await expect(student.locator('#zoom-reset')).toHaveText('125%');
  await expect(student.locator('#slide-next')).toBeHidden();

  await teacher.click('#slide-next');
  await expect.poll(() => student.locator('#slide-counter').textContent()).toBe('2 / 2');
  await expect.poll(() => objectCount(student)).toBe(1);

  await teacher.locator('.page', { hasText: 'Страница 1' }).locator('.page__select').click();
  await expect
    .poll(() =>
      teacher.evaluate(() => window.Konva.stages[0].getLayers()[0].getChildren()[0].visible()),
    )
    .toBe(false);

  await teacherContext.close();
  await studentContext.close();
});
