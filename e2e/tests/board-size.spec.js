import { expect, test } from '@playwright/test';

import {
  createPage,
  lessonSetup,
  openLesson,
  openRoom,
  reloadAndWait,
  selectPage,
  signInWith,
} from '../helpers.js';

function paper(page) {
  return page.evaluate(() => {
    const node = window.Konva.stages[0].getLayers()[0].getChildren()[0];
    return { width: node.width(), height: node.height(), visible: node.visible() };
  });
}

function background(page) {
  return page.evaluate(() => ({
    color: getComputedStyle(document.querySelector('#board')).backgroundColor,
    custom: document.querySelector('#board').classList.contains('has-custom-bg'),
  }));
}

function setColor(page, value) {
  return page.locator('#board-color').evaluate((el, color) => {
    el.value = color;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test('teacher colors the canvas and the student sees the same color', async ({
  browser,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Canvas color' });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );

  await teacher.click('#zoom-in');
  const zoomBefore = await teacher.evaluate(() => window.Konva.stages[0].scaleX());

  await teacher.click('#room-more-btn');
  await teacher.click('#board-size-btn');
  await setColor(teacher, '#123456');
  const expected = { color: 'rgb(18, 52, 86)', custom: true };
  await expect.poll(() => background(teacher)).toEqual(expected);
  await expect.poll(() => background(student)).toEqual(expected);
  expect(await teacher.evaluate(() => window.Konva.stages[0].scaleX())).toBe(zoomBefore);

  await reloadAndWait(teacher);
  await expect.poll(() => background(teacher)).toEqual(expected);

  await teacher.click('#room-more-btn');
  await teacher.click('#board-size-btn');
  await teacher.uncheck('#canvas-infinite');
  await teacher.fill('#board-width', '1200');
  await teacher.fill('#board-height', '800');
  await teacher.click('#board-size-apply');
  const paperFill = (page) =>
    page.evaluate(() => window.Konva.stages[0].getLayers()[0].getChildren()[0].attrs.fill);
  await expect.poll(() => paperFill(teacher)).toBe('#123456');
  await expect.poll(() => paperFill(student)).toBe('#123456');

  await teacher.click('#board-size-btn');
  await teacher.click('#board-color-reset');
  await expect.poll(() => background(teacher).then((value) => value.custom)).toBe(false);
  await expect.poll(() => background(student).then((value) => value.custom)).toBe(false);

  await teacherContext.close();
  await studentContext.close();
});

test('page canvas switches between infinite and fixed and remembers the mode', async ({
  page,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Page canvas', student: false });
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  expect((await paper(page)).visible).toBe(false);

  await page.click('#room-more-btn');
  await page.click('#board-size-btn');
  await page.uncheck('#canvas-infinite');
  await page.fill('#board-width', '1200');
  await page.fill('#board-height', '800');
  await page.click('#board-size-apply');
  await expect.poll(() => paper(page)).toEqual({ width: 1200, height: 800, visible: true });

  await reloadAndWait(page);
  expect(await paper(page)).toEqual({ width: 1200, height: 800, visible: true });

  await createPage(page, 'Вторая');
  expect((await paper(page)).visible).toBe(false);

  await selectPage(page, 'Страница 1');
  await expect.poll(() => paper(page)).toEqual({ width: 1200, height: 800, visible: true });
});
