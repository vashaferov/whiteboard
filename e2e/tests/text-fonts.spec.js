import { expect, test } from '@playwright/test';

import {
  lessonSetup,
  objectCount,
  openRoom,
  reloadAndWait,
  signInWith,
  worldToScreen,
} from '../helpers.js';

function textFont(page) {
  return page.evaluate(() => {
    const node = window.Konva.stages[0].getLayers()[1].findOne('Text');
    return node ? node.fontFamily() : null;
  });
}

test('text: font applies to new and selected text and is shared', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Fonts' });
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();
  await signInWith(request, teacher, setup.teacherLogin);
  await signInWith(request, student, setup.studentLogin);
  await openRoom(teacher, setup.room.id);
  await openRoom(student, setup.room.id);

  await teacher.click('[data-tool="text"]');
  await teacher.selectOption('#font-select', 'serif');
  const point = await worldToScreen(teacher, { x: 320, y: 240 });
  await teacher.mouse.click(point.x, point.y);
  await teacher.fill('#text-editor', 'Заголовок');
  await teacher.press('#text-editor', 'Enter');
  await expect.poll(() => objectCount(teacher)).toBe(1);
  await expect.poll(() => textFont(teacher)).toContain('Georgia');
  await expect.poll(() => textFont(student)).toContain('Georgia');

  await teacher.click('[data-tool="select"]');
  await teacher.mouse.click(point.x + 2, point.y + 2);
  await expect(teacher.locator('#font-select')).toHaveValue('serif');
  await teacher.selectOption('#font-select', 'mono');
  await expect.poll(() => textFont(teacher)).toContain('Consolas');
  await expect.poll(() => textFont(student)).toContain('Consolas');

  await reloadAndWait(teacher);
  await expect(teacher.locator('#font-select')).toBeHidden();
  await expect.poll(() => textFont(teacher)).toContain('Consolas');

  await teacherContext.close();
  await studentContext.close();
});
