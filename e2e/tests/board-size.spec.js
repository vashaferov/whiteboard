import { expect, test } from '@playwright/test';

import { lessonSetup, openRoom, reloadAndWait, signInWith } from '../helpers.js';

function boardSize(page) {
  return page.evaluate(() => {
    const paper = window.Konva.stages[0].getLayers()[0].getChildren()[0];
    return { width: paper.width(), height: paper.height() };
  });
}

test('board size changes for everyone and survives reload', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Board size' });
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();
  await signInWith(request, teacher, setup.teacherLogin);
  await signInWith(request, student, setup.studentLogin);
  await openRoom(teacher, setup.room.id);
  await openRoom(student, setup.room.id);

  await teacher.click('#board-size-btn');
  await teacher.fill('#board-width', '1200');
  await teacher.fill('#board-height', '800');
  await teacher.click('#board-size-apply');
  await expect.poll(() => boardSize(student)).toEqual({ width: 1200, height: 800 });

  await reloadAndWait(teacher);
  expect(await boardSize(teacher)).toEqual({ width: 1200, height: 800 });

  await teacherContext.close();
  await studentContext.close();
});
