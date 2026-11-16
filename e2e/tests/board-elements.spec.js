import { expect, test } from '@playwright/test';

import {
  lessonSetup,
  openLesson,
  reloadAndWait,
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
