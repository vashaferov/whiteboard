/**
 * Снимок текущей страницы доски в PDF без внешних зависимостей.
 * PDF состоит из одной страницы с JPEG-изображением (DCTDecode).
 */

export function pdfPageSize(width, height) {
  const pageWidth = 960;
  return { width: pageWidth, height: Math.round((pageWidth * height) / width) };
}

export function buildPdf(jpeg, { pixelWidth, pixelHeight, pageWidth, pageHeight }) {
  if (!jpeg?.length) throw new Error('Пустое изображение');
  const encoder = new TextEncoder();
  const parts = [];
  const offsets = [];
  let length = 0;

  const write = (data) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (number, body, stream = null) => {
    offsets[number] = length;
    write(`${number} 0 obj\n${body}\n`);
    if (stream) {
      write('stream\n');
      write(stream);
      write('\nendstream\n');
    }
    write('endobj\n');
  };

  write('%PDF-1.4\n');
  write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
  );

  const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`;
  object(4, `<< /Length ${content.length} >>`, content);

  object(
    5,
    `<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
    jpeg,
  );

  const xrefOffset = length;
  write('xref\n0 6\n0000000000 65535 f \n');
  for (let number = 1; number <= 5; number += 1) {
    write(`${String(offsets[number]).padStart(10, '0')} 00000 n \n`);
  }
  write(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const pdf = new Uint8Array(length);
  let position = 0;
  for (const part of parts) {
    pdf.set(part, position);
    position += part.length;
  }
  return pdf;
}

export async function exportWorkspacePdf(board, name) {
  const { canvas, width, height } = await board.exportCanvas();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) throw new Error('Не удалось подготовить изображение');

  const page = pdfPageSize(width, height);
  const pdf = buildPdf(new Uint8Array(await blob.arrayBuffer()), {
    pixelWidth: canvas.width,
    pixelHeight: canvas.height,
    pageWidth: page.width,
    pageHeight: page.height,
  });

  const safe =
    (name || 'board')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'board';
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `whiteboard-${safe}-${date}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
