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

test('flowchart: connectors follow blocks and disappear with them', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Connectors', student: false });
  const context = await browser.newContext();
  const teacher = await context.newPage();
  await signInWith(request, teacher, setup.teacherLogin);
  await openRoom(teacher, setup.room.id);

  const drawWithTool = async (tool, from, to) => {
    await teacher.click(`[data-tool="${tool}"]`);
    const start = await worldToScreen(teacher, from);
    const end = await worldToScreen(teacher, to);
    await teacher.mouse.move(start.x, start.y);
    await teacher.mouse.down();
    await teacher.mouse.move(end.x, end.y, { steps: 6 });
    await teacher.mouse.up();
  };

  await drawWithTool('process', { x: 200, y: 200 }, { x: 360, y: 300 });
  await drawWithTool('decision', { x: 520, y: 200 }, { x: 680, y: 320 });
  await expect.poll(() => objectCount(teacher)).toBe(2);

  await drawWithTool('arrow', { x: 280, y: 250 }, { x: 600, y: 260 });
  await expect.poll(() => objectCount(teacher)).toBe(3);

  const points = () =>
    teacher.evaluate(() => {
      const layer = window.Konva.stages[0].getLayers()[1];
      const arrow = layer.getChildren((node) => node.getClassName() === 'Arrow')[0];
      return arrow ? arrow.points() : null;
    });
  const before = await points();
  expect(before).toBeTruthy();

  await reloadAndWait(teacher);
  await expect.poll(() => objectCount(teacher)).toBe(3);
  expect(await points()).toBeTruthy();

  await teacher.click('[data-tool="select"]');
  const start = await worldToScreen(teacher, { x: 280, y: 250 });
  await teacher.mouse.move(start.x, start.y);
  await teacher.mouse.down();
  await teacher.mouse.move(start.x + 80, start.y + 40, { steps: 6 });
  await teacher.mouse.up();

  await expect
    .poll(async () => Math.abs((await points())[0] - before[0]))
    .toBeGreaterThan(20);

  const afterMove = await points();
  const anchor = await transformerAnchor(teacher, 'bottom-right');
  await dragBy(teacher, anchor, 40, 30);
  await expect
    .poll(async () => JSON.stringify(await points()))
    .not.toBe(JSON.stringify(afterMove));

  await teacher.keyboard.press('Delete');
  await expect.poll(() => objectCount(teacher)).toBe(1);

  await drawWithTool('arrow', { x: 250, y: 520 }, { x: 420, y: 620 });
  await expect.poll(() => objectCount(teacher)).toBe(2);

  await context.close();
});

async function drawWithTool(page, tool, from, to) {
  await page.click(`[data-tool="${tool}"]`);
  const start = await worldToScreen(page, from);
  const end = await worldToScreen(page, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
}

function rectPositions(page) {
  return page.evaluate(() =>
    window.Konva.stages[0]
      .getLayers()[1]
      .getChildren(
        (node) =>
          node.getClassName() === 'Group' &&
          !node.findOne('.frame-bg') &&
          !node.findOne('Text') &&
          node.getChildren().some((child) => child.getClassName() === 'Rect'),
      )
      .map((group) => ({ id: group.id(), x: group.x(), y: group.y() })),
  );
}

test('frames: backgrounds, captured children and moving together', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Frames', student: false });
  const context = await browser.newContext();
  const teacher = await context.newPage();
  await signInWith(request, teacher, setup.teacherLogin);
  await openRoom(teacher, setup.room.id);

  await drawWithTool(teacher, 'frame', { x: 150, y: 150 }, { x: 600, y: 550 });
  await expect.poll(() => objectCount(teacher)).toBe(1);

  await teacher.click('[data-tool="select"]');
  await clickWorld(teacher, { x: 560, y: 520 });
  await expect(teacher.locator('#frame-panel')).toBeVisible();

  await teacher.click('#frame-pattern-grid');
  await expect
    .poll(() =>
      teacher.evaluate(() => {
        const layer = window.Konva.stages[0].getLayers()[1];
        const frame = layer.getChildren((node) => Boolean(node.findOne('.frame-bg')))[0];
        return frame?.findOne('.frame-pattern')?.getAttr('pattern');
      }),
    )
    .toBe('grid');

  await teacher.locator('#frame-colors .frame-color').nth(2).click();

  await drawWithTool(teacher, 'rect', { x: 250, y: 250 }, { x: 380, y: 340 });
  await expect.poll(() => objectCount(teacher)).toBe(2);

  const before = await rectPositions(teacher);
  await teacher.click('[data-tool="select"]');
  const frameHandle = await worldToScreen(teacher, { x: 560, y: 520 });
  await teacher.mouse.move(frameHandle.x, frameHandle.y);
  await teacher.mouse.down();
  await teacher.mouse.move(frameHandle.x + 100, frameHandle.y + 60, { steps: 6 });
  await teacher.mouse.up();

  await expect
    .poll(async () => {
      const after = await rectPositions(teacher);
      return Math.round(after[0].x - before[0].x);
    })
    .toBeGreaterThan(50);

  await reloadAndWait(teacher);
  await expect.poll(() => objectCount(teacher)).toBe(2);
  await expect
    .poll(() =>
      teacher.evaluate(() => {
        const layer = window.Konva.stages[0].getLayers()[1];
        const frame = layer.getChildren((node) => Boolean(node.findOne('.frame-bg')))[0];
        return frame?.findOne('.frame-pattern')?.getAttr('pattern');
      }),
    )
    .toBe('grid');

  await context.close();
});

test('frames: dragging a child out detaches it and resize keeps children', async ({
  browser,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Frame detach', student: false });
  const context = await browser.newContext();
  const teacher = await context.newPage();
  await signInWith(request, teacher, setup.teacherLogin);
  await openRoom(teacher, setup.room.id);

  await drawWithTool(teacher, 'frame', { x: 100, y: 100 }, { x: 600, y: 500 });
  await drawWithTool(teacher, 'rect', { x: 200, y: 200 }, { x: 300, y: 280 });
  await expect.poll(() => objectCount(teacher)).toBe(2);

  await teacher.click('[data-tool="select"]');
  const rectCenter = await worldToScreen(teacher, { x: 250, y: 240 });
  await teacher.mouse.move(rectCenter.x, rectCenter.y);
  await teacher.mouse.down();
  await teacher.mouse.move(rectCenter.x + 500, rectCenter.y + 300, { steps: 8 });
  await teacher.mouse.up();

  await expect
    .poll(async () => (await rectPositions(teacher))[0].x)
    .toBeGreaterThan(600);
  const detached = await rectPositions(teacher);

  const frameHandle = await worldToScreen(teacher, { x: 550, y: 450 });
  await teacher.mouse.move(frameHandle.x, frameHandle.y);
  await teacher.mouse.down();
  await teacher.mouse.move(frameHandle.x + 50, frameHandle.y + 40, { steps: 6 });
  await teacher.mouse.up();

  await expect
    .poll(async () => (await rectPositions(teacher))[0].x)
    .toBeCloseTo(detached[0].x, 0);

  const anchor = await transformerAnchor(teacher, 'bottom-right');
  await dragBy(teacher, anchor, -80, -60);
  await expect
    .poll(async () => (await rectPositions(teacher))[0].x)
    .toBeCloseTo(detached[0].x, 0);

  await teacher.click('[data-tool="select"]');
  await clickWorld(teacher, { x: 300, y: 300 });
  teacher.once('dialog', (dialog) => dialog.accept());
  await teacher.keyboard.press('Delete');
  await expect.poll(() => objectCount(teacher)).toBe(1);

  await context.close();
});

test('frames: only the owner or staff can erase a frame with foreign content', async ({
  browser,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Frame rights' });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );

  await drawWithTool(student, 'frame', { x: 150, y: 150 }, { x: 500, y: 450 });
  await waitForObjectCount(teacher, 1);
  await drawRect(teacher, { x: 250, y: 250 }, { x: 350, y: 330 });
  await waitForObjectCount(student, 2);

  await student.click('[data-tool="eraser"]');
  await eraseAt(student, { x: 150, y: 300 });
  await expect.poll(() => objectCount(student)).toBe(2);

  await teacher.click('[data-tool="eraser"]');
  await eraseAt(teacher, { x: 150, y: 300 });
  await expect.poll(() => objectCount(teacher)).toBe(0);
  await expect.poll(() => objectCount(student)).toBe(0);

  await teacherContext.close();
  await studentContext.close();
});

test('eraser: removes a block together with its arrows', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Eraser block', student: false });
  const context = await browser.newContext();
  const teacher = await context.newPage();
  await signInWith(request, teacher, setup.teacherLogin);
  await openRoom(teacher, setup.room.id);

  await drawWithTool(teacher, 'process', { x: 200, y: 200 }, { x: 360, y: 300 });
  await drawWithTool(teacher, 'decision', { x: 520, y: 200 }, { x: 680, y: 320 });
  await drawWithTool(teacher, 'arrow', { x: 280, y: 250 }, { x: 600, y: 260 });
  await expect.poll(() => objectCount(teacher)).toBe(3);

  await teacher.click('[data-tool="eraser"]');
  await eraseAt(teacher, { x: 280, y: 250 });
  await expect.poll(() => objectCount(teacher)).toBe(1);

  await context.close();
});
