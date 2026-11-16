import { expect, test } from '@playwright/test';

import {
  clickWorld,
  dblclickWorld,
  dragBy,
  drawRect,
  lessonSetup,
  objectCount,
  openLesson,
  openRoom,
  reloadAndWait,
  signInWith,
  transformerAnchor,
  waitForObjectCount,
  worldToScreen,
} from '../helpers.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function imageGroup(page) {
  return page.evaluate(() => {
    const layer = window.Konva.stages[0].getLayers()[1];
    const group = layer
      .getChildren((node) => node.getClassName() === 'Group' && node.findOne('Image'))
      .at(-1);
    if (!group) return null;
    const image = group.findOne('Image');
    return {
      id: group.id(),
      x: group.x(),
      y: group.y(),
      width: image.width(),
      height: image.height(),
      draggable: group.draggable(),
    };
  });
}

test('images: a student moves a freshly uploaded image', async ({
  browser,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Images' });
  const { teacherContext, studentContext, student } = await openLesson(
    request,
    browser,
    setup,
  );

  await student.setInputFiles('#file-input', {
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  });
  await expect
    .poll(() =>
      student.evaluate(
        () =>
          window.Konva.stages[0]
            .getLayers()[1]
            .getChildren(
              (node) => node.getClassName() === 'Group' && node.findOne('Image'),
            ).length,
      ),
    )
    .toBe(1);

  await expect.poll(async () => (await imageGroup(student))?.draggable).toBe(true);
  const before = await imageGroup(student);
  expect(before).toBeTruthy();

  const from = await worldToScreen(student, {
    x: before.x + before.width / 2,
    y: before.y + before.height / 2,
  });
  await student.mouse.move(from.x, from.y);
  await student.mouse.down();
  await student.mouse.move(from.x + 120, from.y + 80, { steps: 8 });
  await student.mouse.up();

  await expect
    .poll(async () => (await imageGroup(student))?.x)
    .toBeGreaterThan(before.x + 50);
  const moved = await imageGroup(student);

  await reloadAndWait(student);
  await expect
    .poll(async () => (await imageGroup(student))?.x)
    .toBeCloseTo(moved.x, 0);

  await teacherContext.close();
  await studentContext.close();
});

async function eraseAt(page, point) {
  const target = await worldToScreen(page, point);
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x + 3, target.y + 3, { steps: 2 });
  await page.mouse.up();
}

async function uploadImage(page) {
  await page.setInputFiles('#file-input', {
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.Konva.stages[0]
            .getLayers()[1]
            .getChildren((node) => node.findOne('Image')).length,
      ),
    )
    .toBe(1);
}

test('eraser: removes strokes, shapes, text and images', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Eraser' });
  const context = await browser.newContext();
  const teacher = await context.newPage();
  await signInWith(request, teacher, setup.teacherLogin);
  await openRoom(teacher, setup.room.id);

  // Brush stroke.
  await teacher.click('[data-tool="brush"]');
  const from = await worldToScreen(teacher, { x: 120, y: 700 });
  const to = await worldToScreen(teacher, { x: 320, y: 700 });
  await teacher.mouse.move(from.x, from.y);
  await teacher.mouse.down();
  await teacher.mouse.move(to.x, to.y, { steps: 10 });
  await teacher.mouse.up();
  await expect.poll(() => objectCount(teacher)).toBe(1);

  await teacher.click('[data-tool="eraser"]');
  await eraseAt(teacher, { x: 220, y: 700 });
  await expect.poll(() => objectCount(teacher)).toBe(0);

  // Rectangle.
  await drawRect(teacher, { x: 220, y: 220 }, { x: 340, y: 320 });
  await expect.poll(() => objectCount(teacher)).toBe(1);
  await teacher.click('[data-tool="eraser"]');
  await eraseAt(teacher, { x: 280, y: 270 });
  await expect.poll(() => objectCount(teacher)).toBe(0);

  // Text.
  await teacher.click('[data-tool="text"]');
  await clickWorld(teacher, { x: 800, y: 600 });
  await teacher.fill('#text-editor', 'Стереть меня');
  await teacher.press('#text-editor', 'Enter');
  await expect.poll(() => objectCount(teacher)).toBe(1);
  await teacher.click('[data-tool="eraser"]');
  await eraseAt(teacher, { x: 830, y: 608 });
  await expect.poll(() => objectCount(teacher)).toBe(0);

  // Image.
  await uploadImage(teacher);
  await teacher.click('[data-tool="eraser"]');
  await eraseAt(teacher, { x: 800, y: 450 });
  await expect.poll(() => objectCount(teacher)).toBe(0);

  await context.close();
});

test('eraser: a student cannot erase foreign objects', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Eraser rights' });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );

  await drawRect(teacher, { x: 220, y: 220 }, { x: 340, y: 320 });
  await drawRect(student, { x: 700, y: 500 }, { x: 820, y: 600 });
  await waitForObjectCount(teacher, 2);
  await waitForObjectCount(student, 2);

  await student.click('[data-tool="eraser"]');
  await eraseAt(student, { x: 280, y: 270 });
  await expect.poll(() => objectCount(student)).toBe(2);

  await eraseAt(student, { x: 760, y: 550 });
  await expect.poll(() => objectCount(student)).toBe(1);
  await expect.poll(() => objectCount(teacher)).toBe(1);

  await teacher.click('[data-tool="eraser"]');
  await eraseAt(teacher, { x: 280, y: 270 });
  await expect.poll(() => objectCount(teacher)).toBe(0);

  await teacherContext.close();
  await studentContext.close();
});

test('flowchart: blocks with labels and free arrows', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Flow', student: false });
  const context = await browser.newContext();
  const teacher = await context.newPage();
  await signInWith(request, teacher, setup.teacherLogin);
  await openRoom(teacher, setup.room.id);

  const drawBlock = async (tool, from, to) => {
    await teacher.click(`[data-tool="${tool}"]`);
    const start = await worldToScreen(teacher, from);
    const end = await worldToScreen(teacher, to);
    await teacher.mouse.move(start.x, start.y);
    await teacher.mouse.down();
    await teacher.mouse.move(end.x, end.y, { steps: 6 });
    await teacher.mouse.up();
  };

  await drawBlock('process', { x: 180, y: 180 }, { x: 340, y: 280 });
  await drawBlock('decision', { x: 420, y: 180 }, { x: 580, y: 300 });
  await drawBlock('terminator', { x: 660, y: 180 }, { x: 820, y: 260 });
  await expect.poll(() => objectCount(teacher)).toBe(3);

  await teacher.click('[data-tool="select"]');
  await dblclickWorld(teacher, { x: 260, y: 230 });
  await expect(teacher.locator('#text-editor')).toBeVisible();
  await teacher.fill('#text-editor', 'Процесс');
  await teacher.press('#text-editor', 'Enter');

  const hasLabel = () =>
    teacher.evaluate(
      () =>
        window.Konva.stages[0]
          .getLayers()[1]
          .getChildren((node) => Boolean(node.id()))
          .some((node) => node.findOne('Text')?.text() === 'Процесс'),
    );
  await expect.poll(hasLabel).toBe(true);

  const rotateEnabled = () =>
    teacher.evaluate(() =>
      window.Konva.stages[0].getLayers()[1].findOne('Transformer').rotateEnabled(),
    );
  await expect.poll(rotateEnabled).toBe(false);

  const anchor = await transformerAnchor(teacher, 'bottom-right');
  await dragBy(teacher, anchor, 60, 40);

  await drawBlock('arrow', { x: 180, y: 420 }, { x: 380, y: 520 });
  await expect.poll(() => objectCount(teacher)).toBe(4);

  await reloadAndWait(teacher);
  await expect.poll(() => objectCount(teacher)).toBe(4);
  await expect.poll(hasLabel).toBe(true);

  await context.close();
});
