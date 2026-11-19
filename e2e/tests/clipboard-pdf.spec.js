import fs from 'node:fs';

import { expect, test } from '@playwright/test';

import {
  clickWorld,
  drawRect,
  lessonSetup,
  openLesson,
  openRoom,
  signInWith,
} from '../helpers.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function imageCount(page) {
  return page.evaluate(
    () => window.Konva.stages[0].getLayers()[1].getChildren((node) => node.findOne('Image')).length,
  );
}

async function pasteFiles(page, names) {
  await page.evaluate(
    ({ data, filenames }) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      for (const filename of filenames) {
        transfer.items.add(new File([bytes], filename, { type: 'image/png' }));
      }
      document.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { data: PNG_1X1.toString('base64'), filenames: names },
  );
}

test('clipboard: Ctrl+V pastes one and several images', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Paste', student: false });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await pasteFiles(page, ['shot.png']);
  await expect.poll(() => imageCount(page)).toBe(1);

  await pasteFiles(page, ['a.png', 'b.png']);
  await expect.poll(() => imageCount(page)).toBe(3);

  await context.close();
});

test('clipboard: paste inside the text editor is left to the editor', async ({
  browser,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'Paste editor', student: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await page.click('[data-tool="text"]');
  await clickWorld(page, { x: 400, y: 300 });
  await expect(page.locator('#text-editor')).toBeFocused();
  await pasteFiles(page, ['shot.png']);
  await page.waitForTimeout(300);
  expect(await imageCount(page)).toBe(0);

  await context.close();
});

test('pdf: a teacher downloads the current workspace', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'PDF', student: false });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await drawRect(page, { x: 200, y: 200 }, { x: 360, y: 300 });
  await page.click('#room-more-btn');
  await expect(page.locator('#pdf-btn')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.click('#pdf-btn');
  const download = await downloadPromise;
  const bytes = fs.readFileSync(await download.path());
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  const text = bytes.toString('latin1');
  const mediaBox = /\/MediaBox \[0 0 960 ([\d.]+)\]/.exec(text);
  expect(mediaBox).not.toBeNull();
  const pageHeight = Number(mediaBox[1]);
  expect(pageHeight).toBeGreaterThan(400);
  expect(pageHeight).toBeLessThan(1100);
  expect(text).toContain('/Subtype /Image');
  expect(download.suggestedFilename()).toMatch(/^whiteboard-.+\.pdf$/);
  await expect.poll(() => page.evaluate(
    () => window.Konva.stages[0].getLayers()[1].getChildren((node) => Boolean(node.id())).length,
  )).toBe(1);

  await context.close();
});

test('pdf: a student has no export button and an empty page is not exported', async ({
  browser,
  request,
}) => {
  const setup = await lessonSetup(request, { name: 'PDF rights', student: true });
  const { teacherContext, studentContext, teacher, student } = await openLesson(
    request,
    browser,
    setup,
  );
  await expect(student.locator('#pdf-btn')).toBeHidden();
  await teacher.click('#room-more-btn');
  await expect(teacher.locator('#pdf-btn')).toBeVisible();

  await teacher.click('#pdf-btn');
  await expect(teacher.locator('#toast')).toHaveText('На странице нет объектов');

  await teacherContext.close();
  await studentContext.close();
});
