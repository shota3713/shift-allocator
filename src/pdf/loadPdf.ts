/**
 * PDF ファイルから「文字と座標」を取り出す。pdf.js に触るのはここだけ。
 *
 * 表の組み立て（shiftTable.ts）は座標だけを見るので、この層を差し替えても
 * 読み取りロジックは変わらない。テストも座標データだけで書ける。
 */

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PageText, TextItem } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** PDF を読み、ページごとの文字と座標を返す。 */
export async function readPdfText(file: ArrayBuffer): Promise<PageText[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(file) }).promise;
  try {
    const pages: PageText[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: TextItem[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const transform = item.transform as number[];
        items.push({
          x: transform[4] as number,
          y: transform[5] as number,
          w: item.width,
          h: item.height,
          str: item.str,
        });
      }
      pages.push({ width: viewport.width, height: viewport.height, items });
      page.cleanup();
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}
