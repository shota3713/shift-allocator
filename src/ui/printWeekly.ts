/**
 * 割り振りの結果を、1週1ページの表にして印刷ダイアログを開く。
 * 「PDFに保存」を選べばそのままPDFになる。
 *
 * PDFを自前で組まないのは、日本語フォントを抱えると数MBになるから。
 * ブラウザの印刷なら端末のフォントでそのまま出て、スマホでもPCでも同じ操作で済む。
 * 別ウィンドウも開かない（ポップアップを止められる端末がある）。
 */

import { el } from './dom';
import { buildWeeklySheets, type WeekSheet, type WeeklyAssignment } from '../core/weekly';
import { SLOT_LABELS, WEEKDAY_LABELS, type Plan } from '../core/types';

const ROOT_CLASS = 'print-root';

export function printWeekly(plan: Plan, assignments: readonly WeeklyAssignment[]): void {
  document.querySelector(`.${ROOT_CLASS}`)?.remove();

  const sheets = buildWeeklySheets(plan, assignments);
  const monthLabel = `${plan.year}年${plan.month}月`;
  const root = el('div', { class: ROOT_CLASS, 'aria-hidden': 'true' },
    ...sheets.map((sheet, index) => renderSheet(sheet, monthLabel, index + 1, sheets.length)));
  document.body.appendChild(root);

  // 保存するときのファイル名の元になる。
  const previousTitle = document.title;
  document.title = `業務割り振り_${monthLabel}`;

  const cleanup = (): void => {
    document.title = previousTitle;
    root.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
}

function renderSheet(sheet: WeekSheet, monthLabel: string, page: number, pages: number): HTMLElement {
  const days = sheet.columns.map((c) => c.day).filter((d): d is number => d !== null);
  const range = days.length > 0 ? `${days[0]}日〜${days[days.length - 1]}日` : '';

  return el('section', { class: 'print-sheet' },
    el('header', { class: 'print-sheet__head' },
      el('h1', { class: 'print-sheet__title', text: `${monthLabel} 業務割り振り` }),
      el('span', { class: 'print-sheet__range', text: `第${page}週 ${range}（${page}/${pages}）` })),
    el('table', { class: 'print-table' },
      el('thead', {},
        el('tr', {},
          el('th', { class: 'print-table__task', text: '業務' }),
          ...sheet.columns.map((column) => el('th', {
            class: `print-table__day print-table__day--${column.weekday}`,
            text: column.day === null ? '' : `${column.day}（${WEEKDAY_LABELS[column.weekday]}）`,
          })))),
      el('tbody', {},
        ...sheet.rows.map((row) => el('tr', {},
          el('th', { class: 'print-table__task', scope: 'row' },
            el('span', { class: 'print-table__slot', text: SLOT_LABELS[row.slot] }),
            row.name),
          ...row.cells.map((names) => renderCell(names)))))));
}

function renderCell(names: readonly string[] | null): HTMLElement {
  if (names === null) return el('td', { class: 'print-table__none' });
  return el('td', {},
    ...names.map((name) => el('div', {
      class: name ? 'print-table__name' : 'print-table__name print-table__name--empty',
      text: name || '空き',
    })));
}
