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

function textNode(page) {
  return page.evaluate(() => {
    const node = window.Konva.stages[0].getLayers()[1].findOne('Text');
    return node
      ? {
          text: node.text(),
          fontFamily: node.fontFamily(),
          fontStyle: node.fontStyle(),
          textDecoration: node.textDecoration(),
          fontSize: node.fontSize(),
          fill: node.fill(),
        }
      : null;
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
  await teacher.press('#text-editor', 'Control+Enter');
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

test('text: multiline, bold, italic, underline, size and color', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Text style' });
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();
  await signInWith(request, teacher, setup.teacherLogin);
  await signInWith(request, student, setup.studentLogin);
  await openRoom(teacher, setup.room.id);
  await openRoom(student, setup.room.id);

  await teacher.click('[data-tool="text"]');
  await teacher.fill('#font-size', '32');
  await teacher.press('#font-size', 'Tab');
  await teacher.click('#text-bold');
  await teacher.click('#text-italic');
  await teacher.click('#text-underline');
  await teacher.click('#style-btn');
  await teacher.click('.swatch[data-color="#dc2626"]');

  const point = await worldToScreen(teacher, { x: 320, y: 240 });
  await teacher.mouse.click(point.x, point.y);
  await teacher.fill('#text-editor', 'Первая');
  await teacher.press('#text-editor', 'Enter');
  await teacher.type('#text-editor', 'Вторая');
  await expect(teacher.locator('#text-editor')).toBeVisible();
  await expect(teacher.locator('#text-editor')).toHaveValue('Первая\nВторая');
  await teacher.press('#text-editor', 'Control+Enter');

  await expect.poll(() => objectCount(teacher)).toBe(1);
  await expect.poll(async () => (await textNode(teacher))?.text).toBe('Первая\nВторая');
  const created = await textNode(teacher);
  expect(created.fontStyle).toBe('bold italic');
  expect(created.textDecoration).toBe('underline');
  expect(created.fontSize).toBe(32);
  expect(created.fill).toBe('#dc2626');
  await expect.poll(async () => (await textNode(student))?.text).toBe('Первая\nВторая');
  await expect.poll(async () => (await textNode(student))?.fontStyle).toBe('bold italic');

  await teacher.click('[data-tool="select"]');
  await teacher.mouse.click(point.x + 2, point.y + 2);
  await expect(teacher.locator('#text-bold')).toHaveAttribute('aria-pressed', 'true');
  await expect(teacher.locator('#text-italic')).toHaveAttribute('aria-pressed', 'true');
  await expect(teacher.locator('#text-underline')).toHaveAttribute('aria-pressed', 'true');
  await expect(teacher.locator('#font-size')).toHaveValue('32');

  await teacher.click('#text-bold');
  await teacher.fill('#font-size', '20');
  await teacher.press('#font-size', 'Tab');
  await teacher.click('#style-btn');
  await teacher.click('.swatch[data-color="#16a34a"]');

  await expect.poll(async () => (await textNode(teacher))?.fontStyle).toBe('italic');
  await expect.poll(async () => (await textNode(teacher))?.fontSize).toBe(20);
  await expect.poll(async () => (await textNode(teacher))?.fill).toBe('#16a34a');
  await expect.poll(async () => (await textNode(student))?.fontStyle).toBe('italic');
  await expect.poll(async () => (await textNode(student))?.fill).toBe('#16a34a');

  await reloadAndWait(teacher);
  await expect(teacher.locator('#font-select')).toBeHidden();
  await expect.poll(async () => (await textNode(teacher))?.text).toBe('Первая\nВторая');
  await expect.poll(async () => (await textNode(teacher))?.fontStyle).toBe('italic');
  await expect.poll(async () => (await textNode(teacher))?.fontSize).toBe(20);
  await expect.poll(async () => (await textNode(teacher))?.fill).toBe('#16a34a');

  await teacherContext.close();
  await studentContext.close();
});
