# Вставка из буфера и PDF-экспорт: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вставлять изображения из буфера обмена через `Ctrl+V` и экспортировать текущую страницу доски в PDF с пропорциями 16:9.

**Architecture:** Вставка переиспользует существующий `POST /api/upload` и общий помощник размещения картинки. PDF собирается на клиенте: Konva рендерит страницу в canvas, JPEG встраивается в минимальный PDF 1.4 без новых зависимостей.

**Tech Stack:** Konva.js, ES-модули, Canvas/Blob, Playwright, существующий FastAPI-upload.

**Spec:** `docs/superpowers/specs/2026-11-17-clipboard-pdf-design.md`

## Global Constraints

- Новых зависимостей и CDN не добавлять.
- Backend не меняется; используется `POST /api/upload` с текущими лимитами.
- Все пользовательские тексты — на русском.
- Код в стиле `frontend/js/*`; комментарии по-русски.
- PDF-кнопка видна только `teacher`/`admin`.
- E2E запускать из `e2e`: `$env:PYTHON='D:\Dev\whiteboard\.venv\Scripts\python.exe'; npx.cmd playwright test`.

## Review Focus

- Вставка при фокусе в поле ввода или редакторе текста не должна перехватываться.
- Несколько картинок из буфера не должны накладываться друг на друга и теряться.
- PDF пустой страницы не должен создавать пустой файл.
- Экспорт не должен включать курсоры, Transformer, сетку и значки замка.
- Внешняя картинка без CORS может «испортить» canvas — пользователь должен увидеть тост, а не молчаливый сбой.

---

### Task 1: Вставка изображений из буфера

**Files:**
- Modify: `frontend/js/main.js` (`uploadImage`, `bindToolbar`, `bindWindowEvents`/`init`)
- Test: `e2e/tests/clipboard-pdf.spec.js` (create)

**Interfaces:**
- Produces:
  - `uploadImageFile(file: File): Promise<{url: string, width: number, height: number}>`
  - `placeUploadedImage(data, { offset?: number }): string` — добавляет объект, выбирает его, возвращает `objectId`.
  - `handlePaste(event: ClipboardEvent): Promise<void>`

- [ ] **Step 1: Написать падающие E2E-тесты**

```js
// e2e/tests/clipboard-pdf.spec.js
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function imageCount(page) {
  return page.evaluate(
    () => window.Konva.stages[0].getLayers()[1].getChildren((n) => n.findOne('Image')).length,
  );
}

async function pasteImage(page, name = 'shot.png') {
  await page.evaluate(
    ({ data, filename }) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], filename, { type: 'image/png' }));
      document.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { data: PNG_1X1.toString('base64'), filename: name },
  );
}

test('clipboard: Ctrl+V pastes one and several images', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'Paste', student: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await pasteImage(page);
  await expect.poll(() => imageCount(page)).toBe(1);

  await page.evaluate(
    ({ data }) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'a.png', { type: 'image/png' }));
      transfer.items.add(new File([bytes], 'b.png', { type: 'image/png' }));
      document.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { data: PNG_1X1.toString('base64') },
  );
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
  await pasteImage(page);
  await page.waitForTimeout(300);
  expect(await imageCount(page)).toBe(0);

  await context.close();
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx.cmd playwright test tests/clipboard-pdf.spec.js -g "clipboard:" --timeout=15000`
Expected: FAIL — изображения не появляются (0 вместо 1/3); второй тест проходит.

- [ ] **Step 3: Вынести общий загрузчик**

В `frontend/js/main.js`:

```js
async function uploadImageFile(file) {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch('/api/upload', { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.detail;
    throw new Error(
      typeof detail === 'string' ? detail : detail?.message || 'Не удалось загрузить изображение',
    );
  }
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
    image.src = data.url;
  });
  const maxWidth = Math.min(480, state.board.width * 0.6);
  const scale = Math.min(1, maxWidth / image.naturalWidth);
  return {
    url: data.url,
    width: Math.max(40, image.naturalWidth * scale),
    height: Math.max(40, image.naturalHeight * scale),
  };
}

function placeUploadedImage(data, { offset = 0 } = {}) {
  const x = Math.max(0, (state.board.width - data.width) / 2 + offset);
  const y = Math.max(0, (state.board.height - data.height) / 2 + offset);
  const objectId = newId();
  state.board.addObject({
    id: objectId,
    type: 'image',
    url: data.url,
    x,
    y,
    width: data.width,
    height: data.height,
    author: state.user?.id ?? null,
  });
  state.board.selectObject(objectId);
  sendWorkspace({
    type: 'image_add',
    objectId,
    url: data.url,
    x: round(x),
    y: round(y),
    width: round(data.width),
    height: round(data.height),
  });
  return objectId;
}
```

`uploadImage` вызывает `uploadImageFile` и `placeUploadedImage`; поведение кнопки не меняется.

- [ ] **Step 4: Реализовать `handlePaste`**

```js
async function handlePaste(event) {
  if (!state.board || !state.ready) return;
  if (!els.textEditor.hidden) return;
  const target = event.target;
  if (
    target &&
    (target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  ) {
    return;
  }
  const files = [...(event.clipboardData?.items ?? [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  event.preventDefault();
  let lastId = null;
  for (const [index, file] of files.entries()) {
    try {
      lastId = placeUploadedImage(await uploadImageFile(file), { offset: index * 24 });
    } catch (error) {
      toast(error.message || 'Не удалось вставить изображение');
    }
  }
  if (lastId) selectTool('select');
}
```

Подписка: `document.addEventListener('paste', (event) => void handlePaste(event));` в `bindWindowEvents` или `init`.

- [ ] **Step 5: Прогнать тесты**

Run: `npx.cmd playwright test tests/clipboard-pdf.spec.js -g "clipboard:"`
Expected: PASS (2 теста).

- [ ] **Step 6: Коммит**

```bash
git add frontend/js/main.js e2e/tests/clipboard-pdf.spec.js
git commit -m "feat: paste images from the clipboard"
```

---

### Task 2: PDF-экспорт текущей страницы

**Files:**
- Create: `frontend/js/export.js`
- Modify: `frontend/js/board.js` (метод `exportCanvas`)
- Modify: `frontend/js/main.js` (кнопка, видимость, экспорт)
- Modify: `frontend/index.html` (кнопка `#pdf-btn`)
- Test: `e2e/tests/clipboard-pdf.spec.js`

**Interfaces:**
- Consumes: `Board.objects`, `Board.width`, `Board.height`, `Board.stage`, `Board.contentLayer`, `Board.overlayLayer`, `Board.transformer`, `Board.grid`, `Board.paper`.
- Produces:
  - `Board.exportCanvas(): Promise<HTMLCanvasElement>` — снимок 2× без сетки, курсоров, Transformer и значков замка.
  - `pdfPageSize(width: number, height: number): {width: number, height: number}` — 960 pt по ширине.
  - `buildPdf(jpeg: Uint8Array, {pixelWidth, pixelHeight, pageWidth, pageHeight}): Uint8Array`
  - `exportWorkspacePdf(board, name: string): Promise<void>` — скачивает файл.

- [ ] **Step 1: Написать падающие E2E-тесты**

Добавить в `clipboard-pdf.spec.js`:

```js
import fs from 'node:fs';

test('pdf: a teacher downloads the current workspace', async ({ browser, request }) => {
  const setup = await lessonSetup(request, { name: 'PDF', student: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWith(request, page, setup.teacherLogin);
  await openRoom(page, setup.room.id);

  await drawRect(page, { x: 200, y: 200 }, { x: 360, y: 300 });
  await expect(page.locator('#pdf-btn')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.click('#pdf-btn');
  const download = await downloadPromise;
  const bytes = fs.readFileSync(await download.path());
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  const text = bytes.toString('latin1');
  expect(text).toContain('/MediaBox [0 0 960 540]');
  expect(text).toContain('/Subtype /Image');
  expect(download.suggestedFilename()).toMatch(/^whiteboard-.+\.pdf$/);

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
  await expect(teacher.locator('#pdf-btn')).toBeVisible();

  await teacher.click('#pdf-btn');
  await expect(teacher.locator('#toast')).toHaveText('На странице нет объектов');

  await teacherContext.close();
  await studentContext.close();
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx.cmd playwright test tests/clipboard-pdf.spec.js -g "pdf:"`
Expected: FAIL — кнопки `#pdf-btn` нет.

- [ ] **Step 3: Добавить кнопку и видимость**

В `frontend/index.html` рядом с `#image-btn`:

```html
<button id="pdf-btn" class="btn btn--ghost" type="button" title="Экспортировать страницу в PDF" hidden>
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v5h5" />
    <path d="M9 14h6M9 17h4" />
  </svg>
  <span>PDF</span>
</button>
```

В `frontend/js/main.js`: `els.pdfBtn = $('#pdf-btn');` и в `updateToolbar`:

```js
els.pdfBtn.hidden = !isStaff(state.user?.role);
```

- [ ] **Step 4: Реализовать PDF-writer**

`frontend/js/export.js`:

```js
export function pdfPageSize(width, height) {
  const pageWidth = 960;
  return { width: pageWidth, height: Math.round((pageWidth * height) / width) };
}

export function buildPdf(jpeg, { pixelWidth, pixelHeight, pageWidth, pageHeight }) {
  // объект 1 — каталог, 2 — страницы, 3 — страница, 4 — поток контента,
  // 5 — JPEG XObject. xref считает байтовые смещения.
}
```

Требования к `buildPdf`:

- заголовок `%PDF-1.4` и бинарный маркер;
- `/MediaBox [0 0 pageWidth pageHeight]`;
- `/XObject << /Im0 5 0 R >>`, контент `q ... cm /Im0 Do Q`;
- JPEG: `/Filter /DCTDecode`, `/Width pixelWidth`, `/Height pixelHeight`;
- корректные `xref`, `trailer`, `startxref`, `%%EOF`;
- функция возвращает `Uint8Array`.

`exportWorkspacePdf`:

```js
export async function exportWorkspacePdf(board, name) {
  const canvas = await board.exportCanvas();
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.92),
  );
  if (!blob) throw new Error('Не удалось подготовить изображение');
  const page = pdfPageSize(board.width, board.height);
  const pdf = buildPdf(new Uint8Array(await blob.arrayBuffer()), {
    pixelWidth: canvas.width,
    pixelHeight: canvas.height,
    ...page,
  });
  const safe = (name || 'board').replace(/[\\/:*?"<>|]+/g, ' ').trim().replace(/\s+/g, '-');
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `whiteboard-${safe || 'board'}-${date}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

- [ ] **Step 5: Реализовать `Board.exportCanvas`**

В `frontend/js/board.js`:

- сохранить `stage.width/height/scale/position`, видимость `overlayLayer`, `transformer`, `grid`, `paper.shadowEnabled`;
- дождаться загрузки всех Konva.Image (`node.image()?.decode?.()`);
- скрыть overlay, transformer и значки `.lock-badge`; выключить сетку и тень бумаги;
- выставить `stage.size({width: board.width, height: board.height})`, `scale(1)`, `position(0,0)`;
- получить `stage.toCanvas({ pixelRatio: 2 })`;
- в `finally` восстановить всё и вызвать `fit()`;
- вернуть canvas.

В `main.js` добавить обработчик:

```js
async function exportPdf() {
  if (!state.board || state.tools?.isDrawing()) return;
  if (state.board.objects.size === 0) {
    toast('На странице нет объектов');
    return;
  }
  els.pdfBtn.disabled = true;
  try {
    const page = state.workspaces.find((item) => item.id === state.workspaceId);
    await exportWorkspacePdf(state.board, page?.name || 'board');
  } catch {
    toast('Не удалось экспортировать PDF');
  } finally {
    els.pdfBtn.disabled = false;
  }
}
```

и `els.pdfBtn.addEventListener('click', exportPdf);`.

- [ ] **Step 6: Прогнать тесты**

Run: `npx.cmd playwright test tests/clipboard-pdf.spec.js`
Expected: PASS (4 теста).

- [ ] **Step 7: Коммит**

```bash
git add frontend/js/export.js frontend/js/board.js frontend/js/main.js frontend/index.html e2e/tests/clipboard-pdf.spec.js
git commit -m "feat: export the current workspace to PDF"
```

---

### Task 3: Документация и регрессия

**Files:**
- Modify: `README.md`
- Modify: `plan.md`

- [ ] **Step 1: Обновить README**

В разделе возможностей: вставка картинок из буфера (`Ctrl+V`) и экспорт текущей
страницы в PDF учителем/администратором.

- [ ] **Step 2: Обновить plan.md**

Добавить пункт P8 с чекбоксами и фактическими числами тестов.

- [ ] **Step 3: Полный прогон**

- `e2e`: `npx.cmd playwright test` — все сценарии зелёные.
- `backend`: `..\.venv\Scripts\python.exe -m pytest -q -p no:warnings`.
- `ruff` и `black --check`.

- [ ] **Step 4: Коммит**

```bash
git add README.md plan.md
git commit -m "docs: describe clipboard paste and PDF export"
```

---

## Self-Review

- **Покрытие спеки:** вставка (Task 1), PDF (Task 2), права/пустая страница (Task 2),
  документация (Task 3).
- **Review Focus → тесты:** вставка в редакторе (Task 1), несколько картинок
  (Task 1), пустая страница (Task 2), права (Task 2). Скрытие служебных слоёв
  проверяется реализацией `exportCanvas` и визуально при приёмке.
- **Типы:** `placeUploadedImage` принимает `{url,width,height}` и возвращает id;
  `exportWorkspacePdf` использует `board.exportCanvas()` и `board.width/height`.
- **Пропорция:** шаги задают сигнатуры и проверки, тело PDF-writer не приводится
  полностью — алгоритм определяется форматом PDF.
