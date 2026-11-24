import { expect, test } from '@playwright/test';

import {
  dblclickWorld,
  lessonSetup,
  objectCount,
  openRoom,
  reloadAndWait,
  settleBoard,
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

function textSegments(page) {
  return page.evaluate(() => {
    const layer = window.Konva.stages[0].getLayers()[1];
    const group = layer
      .getChildren((node) => Boolean(node.id()))
      .find((node) => node.find('Text').length > 0);
    if (!group) return [];
    return group
      .find('Text')
      .filter((node) => node.name() !== 'lock-badge')
      .map((node) => ({
        text: node.text(),
        fontFamily: node.fontFamily(),
        fontStyle: node.fontStyle(),
        textDecoration: node.textDecoration(),
        fontSize: node.fontSize(),
        fill: node.fill(),
      }));
  });
}

function editorText(page) {
  return page.evaluate(() => document.getElementById('text-editor').textContent);
}

async function selectEditorText(page, from, to) {
  await page.evaluate(
    ({ start, end }) => {
      const root = document.getElementById('text-editor');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let offset = 0;
      let startPoint = null;
      let endPoint = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.nodeValue.length;
        if (!startPoint && start <= offset + length) {
          startPoint = { node, offset: start - offset };
        }
        if (!endPoint && end <= offset + length) {
          endPoint = { node, offset: end - offset };
        }
        offset += length;
      }
      const range = document.createRange();
      range.setStart(startPoint.node, startPoint.offset);
      range.setEnd(endPoint.node, endPoint.offset);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      root.focus();
    },
    { start: from, end: to },
  );
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
  await expect.poll(() => editorText(teacher)).toBe('Первая\nВторая');
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

test('text: formatting applies only to the selected fragment', async ({
  browser,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Text ranges' });
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();
  await signInWith(request, teacher, setup.teacherLogin);
  await signInWith(request, student, setup.studentLogin);
  await openRoom(teacher, setup.room.id);
  await openRoom(student, setup.room.id);

  const point = await worldToScreen(teacher, { x: 320, y: 240 });
  await teacher.click('[data-tool="text"]');
  await teacher.click('#style-btn');
  await teacher.click('.swatch[data-color="#111827"]');
  await teacher.mouse.click(point.x, point.y);
  await teacher.fill('#text-editor', 'Привет мир');
  await teacher.press('#text-editor', 'Control+Enter');
  await expect.poll(() => objectCount(teacher)).toBe(1);

  await teacher.click('[data-tool="select"]');
  await expect(teacher.locator('.font-control')).toBeHidden();
  await settleBoard(teacher);
  const textPoint = await worldToScreen(teacher, { x: 340, y: 255 });
  await teacher.mouse.click(textPoint.x, textPoint.y);
  await expect(teacher.locator('.font-control')).toBeVisible();
  await settleBoard(teacher);
  await dblclickWorld(teacher, { x: 340, y: 255 });
  await expect(teacher.locator('#text-editor')).toBeVisible();

  await selectEditorText(teacher, 7, 10);
  await teacher.click('#text-bold');
  await teacher.fill('#font-size', '32');
  await teacher.press('#font-size', 'Tab');
  await teacher.selectOption('#font-select', 'serif');
  await teacher.click('#style-btn');
  await teacher.click('.swatch[data-color="#dc2626"]');
  await teacher.press('#text-editor', 'Control+Enter');

  const expectFragment = async (page) => {
    await expect
      .poll(async () => (await textSegments(page)).map((item) => item.text).join(''))
      .toBe('Привет мир');
    const segments = await textSegments(page);
    expect(segments).toHaveLength(2);
    const plain = segments.find((item) => item.text === 'Привет ');
    const highlighted = segments.find((item) => item.text === 'мир');
    expect(plain.fontStyle).toBe('normal');
    expect(plain.fontSize).toBe(24);
    expect(plain.fill).toBe('#111827');
    expect(highlighted.fontStyle).toBe('bold');
    expect(highlighted.fontSize).toBe(32);
    expect(highlighted.fill).toBe('#dc2626');
    expect(highlighted.fontFamily).toContain('Georgia');
  };

  await expectFragment(teacher);
  await expectFragment(student);

  await reloadAndWait(teacher);
  await expectFragment(teacher);

  await teacherContext.close();
  await studentContext.close();
});
