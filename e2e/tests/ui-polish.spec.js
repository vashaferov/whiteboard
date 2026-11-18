import { expect, test } from '@playwright/test';

import {
  lessonSetup,
  moveWorld,
  openLesson,
  openRoom,
  signInWith,
} from '../helpers.js';

const LONG_NAME = 'Александра Константинопольская';

test('sidebar: a long participant name can be revealed by resizing', async ({ browser, request }) => {
  const setup = await lessonSetup(request, {
    name: 'Sidebar',
    teacherName: LONG_NAME,
    student: false,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  const panel = page.locator('#users-panel');
  const name = page.locator('#user-list .user__name').first();
  await expect(name).toHaveAttribute('title', LONG_NAME);

  const before = await panel.boundingBox();
  expect(before.width).toBeLessThan(300);

  const handle = await page.locator('#users-resizer').boundingBox();
  const y = handle.y + handle.height / 2;
  const startX = handle.x + handle.width / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX - 220, y, { steps: 10 });
  await page.mouse.up();

  const expectedWidth = await page.evaluate(
    (target) => Math.min(560, Math.floor(window.innerWidth * 0.5), target),
    before.width + 220,
  );
  const immediate = (await panel.boundingBox()).width;
  expect(Math.abs(immediate - expectedWidth)).toBeLessThanOrEqual(1);

  await expect
    .poll(async () => (await panel.boundingBox()).width)
    .toBeGreaterThan(before.width + 150);
  expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  const saved = await page.evaluate(() => Number(localStorage.getItem('wb:usersPanelWidth')));
  expect(saved).toBeGreaterThan(before.width + 150);

  await context.close();
});

test('sidebar: pages and participants collapse and remember the state', async ({
  page,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Sidebar toggle', student: false });
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  const pages = page.locator('#pages-panel');
  const users = page.locator('#users-panel');
  const board = page.locator('#board');
  const widthOf = async (locator) => (await locator.boundingBox()).width;

  const initialBoard = await widthOf(board);
  expect(await widthOf(pages)).toBeGreaterThan(150);

  await page.click('#pages-toggle');
  await expect.poll(() => widthOf(pages)).toBeLessThan(60);
  await expect(page.locator('.page-list')).toBeHidden();
  await expect.poll(() => widthOf(board)).toBeGreaterThan(initialBoard + 100);

  const afterPages = await widthOf(board);
  await page.click('#users-toggle');
  await expect.poll(() => widthOf(users)).toBeLessThan(60);
  await expect(page.locator('#users-resizer')).toBeHidden();
  await expect.poll(() => widthOf(board)).toBeGreaterThan(afterPages + 100);

  await openRoom(page, setup.room.id);
  await expect.poll(() => widthOf(pages)).toBeLessThan(60);
  await expect.poll(() => widthOf(users)).toBeLessThan(60);

  await page.click('#pages-toggle');
  await expect.poll(() => widthOf(pages)).toBeGreaterThan(150);
  await page.click('#users-toggle');
  await expect.poll(() => widthOf(users)).toBeGreaterThan(150);
  await expect(page.locator('#users-resizer')).toBeVisible();
});

test('cursor: ink stays contrasting for light and dark participant colors', async ({
  browser,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Cursor', student: true });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );

  const ink = await student.evaluate(async () => {
    const module = await import('/js/board.js');
    return {
      white: module.cursorInk('#ffffff'),
      dark: module.cursorInk('#111827'),
      orange: module.cursorInk('#f59e0b'),
    };
  });
  expect(ink.white).not.toBe('#ffffff');
  expect(ink.dark).not.toBe('#111827');
  expect(ink.orange).not.toBe('#f59e0b');

  await moveWorld(teacher, { x: 700, y: 420 }, 10);
  await student.waitForFunction(
    () => window.Konva.stages[0].getLayers()[2].getChildren().length > 0,
  );
  const cursor = await student.evaluate(async () => {
    const group = window.Konva.stages[0].getLayers()[2].getChildren().at(-1);
    const pointer = group.findOne('Path');
    const tag = group.findOne('Rect');
    const text = group.findOne('Text');
    const module = await import('/js/board.js');
    return {
      fill: pointer.fill(),
      stroke: pointer.stroke(),
      tagStroke: tag.stroke(),
      textFill: text.fill(),
      expected: module.cursorInk(pointer.fill()),
    };
  });
  expect(cursor.stroke).toBe(cursor.expected);
  expect(cursor.tagStroke).toBe(cursor.expected);
  expect(cursor.textFill).toBe(cursor.expected);

  await teacherContext.close();
  await studentContext.close();
});
