import { expect, test } from '@playwright/test';

import {
  clickWorld,
  dragBy,
  drawRect,
  lessonSetup,
  objectCount,
  openLesson,
  openRoom,
  signInWith,
  stageView,
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
  await expect.poll(() => objectCount(page)).toBe(2);

  await eraseAt(page, { x: 120, y: 95 }, { x: 280, y: 95 });
  await expect.poll(() => objectCount(page)).toBe(1);

  await context.close();
});

async function lockBadgeCount(page) {
  return page.evaluate(
    () => window.Konva.stages[0].getLayers()[1].find('.lock-badge').length,
  );
}

async function objectPosition(page, index = 0) {
  return page.evaluate((position) => {
    const group = window.Konva.stages[0]
      .getLayers()[1]
      .getChildren((node) => Boolean(node.id()))[position];
    return group ? { x: Math.round(group.x()), y: Math.round(group.y()) } : null;
  }, index);
}

async function shapePosition(page) {
  return page.evaluate(() => {
    const group = window.Konva.stages[0]
      .getLayers()[1]
      .getChildren((node) => Boolean(node.id()) && node.findOne('Rect'))
      .find((node) => !node.findOne('.frame-bg'));
    return group ? { x: Math.round(group.x()), y: Math.round(group.y()) } : null;
  });
}

async function firstPosition(page) {
  return page.evaluate(() => {
    const group = window.Konva.stages[0]
      .getLayers()[1]
      .getChildren((node) => Boolean(node.id()))[0];
    return group ? { x: Math.round(group.x()), y: Math.round(group.y()) } : null;
  });
}

test('lock: a student cannot move a locked block, teacher can unlock', async ({
  browser,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Lock block', student: true });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );
  try {
    await drawWithTool(student, 'process', { x: 200, y: 200 }, { x: 320, y: 280 });
    await expect.poll(() => objectCount(teacher)).toBe(1);

    await teacher.click('[data-tool="select"]');
    await clickWorld(teacher, { x: 260, y: 240 });
    await teacher.click('#lock-btn');
    await expect.poll(() => lockBadgeCount(student)).toBe(1);

    const before = await objectPosition(teacher);
    await student.click('[data-tool="select"]');
    const start = await worldToScreen(student, { x: 260, y: 240 });
    await dragBy(student, start, 120, 80);
    await expect.poll(async () => (await objectPosition(teacher)).x).toBe(before.x);

    await teacher.click('[data-tool="select"]');
    const teacherStart = await worldToScreen(teacher, { x: 260, y: 240 });
    await dragBy(teacher, teacherStart, 120, 80);
    await expect.poll(async () => (await objectPosition(teacher)).x).toBe(before.x);

    await teacher.click('#undo-btn');
    await expect.poll(() => lockBadgeCount(student)).toBe(0);
    const afterUnlock = await worldToScreen(student, { x: 260, y: 240 });
    await dragBy(student, afterUnlock, 120, 80);
    await expect
      .poll(async () => (await objectPosition(teacher)).x)
      .toBeGreaterThan(before.x + 60);
  } finally {
    await teacherContext.close();
    await studentContext.close();
  }
});

test('lock: a locked frame holds its children', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Lock frame', student: true });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );
  try {
    await drawWithTool(teacher, 'frame', { x: 100, y: 100 }, { x: 600, y: 500 });
    await drawWithTool(student, 'rect', { x: 200, y: 200 }, { x: 300, y: 280 });
    await expect.poll(() => objectCount(teacher)).toBe(2);

    await teacher.click('[data-tool="select"]');
    await clickWorld(teacher, { x: 560, y: 470 });
    await teacher.click('#lock-btn');
    await expect.poll(() => lockBadgeCount(student)).toBe(1);

    const before = await shapePosition(student);
    expect(before).not.toBeNull();
    await student.click('[data-tool="select"]');
    const start = await worldToScreen(student, { x: 250, y: 240 });
    await dragBy(student, start, 120, 80);
    await expect.poll(async () => (await shapePosition(student)).x).toBe(before.x);

    await teacher.click('#undo-btn');
    await expect.poll(() => lockBadgeCount(student)).toBe(0);
    const afterUnlock = await worldToScreen(student, { x: 250, y: 240 });
    await dragBy(student, afterUnlock, 120, 80);
    await expect
      .poll(async () => (await shapePosition(student)).x)
      .toBeGreaterThan(before.x + 60);
  } finally {
    await teacherContext.close();
    await studentContext.close();
  }
});



test('undo: removes a created shape and restores an erased stroke', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Undo', student: true });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );
  try {
    await drawRect(teacher, { x: 200, y: 200 }, { x: 300, y: 280 });
    await expect.poll(() => objectCount(student)).toBe(1);
    await teacher.click('#undo-btn');
    await expect.poll(() => objectCount(student)).toBe(0);

    await drawWithTool(student, 'brush', { x: 400, y: 300 }, { x: 600, y: 300 });
    await expect.poll(() => objectCount(teacher)).toBe(1);
    await eraseAt(student, { x: 420, y: 300 }, { x: 580, y: 300 });
    await expect.poll(() => objectCount(student)).toBe(0);
    await student.click('#undo-btn');
    await expect.poll(() => objectCount(student)).toBe(1);
    await expect.poll(() => objectCount(teacher)).toBe(1);
  } finally {
    await teacherContext.close();
    await studentContext.close();
  }
});

test('undo: ctrl+z works with a Cyrillic keyboard layout', async ({ page, request }) => {
  const setup = await lessonSetup(request, { name: 'Undo layout', student: false });
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);
  await drawRect(page, { x: 720, y: 400 }, { x: 900, y: 520 });
  await expect.poll(() => objectCount(page)).toBe(1);

  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'я',
        code: 'KeyZ',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect.poll(() => objectCount(page)).toBe(0);
});

test('undo: ctrl+z restores a moved object and empty history toasts', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Undo move', student: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await drawRect(page, { x: 100, y: 100 }, { x: 220, y: 180 });
  await page.click('[data-tool="select"]');
  const before = await firstPosition(page);
  const start = await worldToScreen(page, { x: 160, y: 140 });
  const scale = (await stageView(page)).scaleX;
  await dragBy(page, start, 140 * scale, 80 * scale);
  await expect.poll(async () => (await firstPosition(page)).x).toBeGreaterThan(before.x + 100);

  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await firstPosition(page)).x).toBe(before.x);

  await page.keyboard.press('Control+z');
  await expect.poll(() => objectCount(page)).toBe(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('#toast')).toHaveText('Нечего отменять');

  await context.close();
});
