import { expect, test } from '@playwright/test';

import {
  createPage,
  lessonSetup,
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
