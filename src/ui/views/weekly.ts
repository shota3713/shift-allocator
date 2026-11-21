/**
 * 週ごとの表。割り振りの結果を1週1ページの「業務 × 曜日」で見て、
 * 備考を書き足してから PDF に保存する。
 *
 * 画面に出している表をそのまま印刷する。見たものと保存されるものが違うと、
 * 確かめた意味がなくなる。PDFを自前で組まないのは、日本語フォントを抱えると
 * 数MBになるから。ブラウザの印刷なら「PDFに保存」を選ぶだけで済む。
 *
 * 紙は折らずに1枚で見渡したいので、1週を必ず1ページに収める。行の多い週ほど
 * 文字を小さくする（sheetEm）。A3 を選べば同じ行数でも大きな字で刷れる。
 */

import type { Ctx } from '../app';
import { el } from '../dom';
import { buildPlan } from '../../core/plan';
import { buildWeeklySheets, type AttendanceCell, type WeekRow, type WeekSheet } from '../../core/weekly';
import { SLOT_LABELS, WEEKDAY_LABELS } from '../../core/types';
import { PAPER_SIZES, dayNotesFor, setDayNote, updateDatabase, type PaperSize } from '../../store/db';

/** 印刷の余白（mm）。 */
const PAGE_MARGIN_MM = 8;

/**
 * 「残り全員」の欄に1行で並べる人数の目安。ページに収める計算に使う。
 * A4横の1日の欄は 4〜5字の名前が2つ並ぶ幅。少なめに見積もって、はみ出さない側に倒す。
 */
const NAMES_PER_LINE = 2;

export function renderWeekly(root: HTMLElement, ctx: Ctx): void {
  const db = ctx.db;
  const period = ctx.state.period;
  const plan = buildPlan(db, period);
  const runs = db.runs.filter((r) => r.period === period)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const run = runs.find((r) => r.runId === ctx.state.runId) ?? runs[0];

  if (!run) {
    root.append(
      el('div', { class: 'empty' }, el('p', { text: 'この月はまだ割り振っていません。' })),
      el('div', { class: 'actions' },
        el('button', { class: 'btn btn--primary', type: 'button', text: '割り振りへ', onclick: () => ctx.go('assign') })),
    );
    return;
  }

  const paper = db.settings.paperSize;
  applyPageSize(paper);

  const monthLabel = `${plan.year}年${plan.month}月`;
  const sheets = buildWeeklySheets(plan, run.assignments, dayNotesFor(db, period));
  const saveNote = (day: number, text: string): void => {
    updateDatabase((current) => setDayNote(current, period, day, text));
  };

  root.append(
    el('p', { class: 'weekly-lead no-print',
      text: '内容を確かめて、必要なら下の備考に書き足してから「PDFで保存」を押してください。備考は自動で残ります。'
        + '1週が1枚に収まるように、行の多い週は文字を小さくして刷ります。' }),
    el('div', { class: 'weekly-paper no-print', role: 'radiogroup', 'aria-label': '用紙' },
      el('span', { class: 'weekly-paper__label', text: '用紙（横向き）' }),
      ...PAPER_SIZES.map((size) => el('button', {
        class: size === paper ? 'weekly-paper__option weekly-paper__option--on' : 'weekly-paper__option',
        type: 'button',
        role: 'radio',
        'aria-checked': size === paper ? 'true' : 'false',
        text: size,
        onclick: () => ctx.update((current) => ({
          ...current,
          settings: { ...current.settings, paperSize: size },
        })),
      }))),
    el('div', { class: `weekly-sheets weekly-sheets--${paper}` },
      ...sheets.map((sheet, index) => renderSheet(sheet, monthLabel, index + 1, sheets.length, saveNote))),
    el('div', { class: 'actions actions--sticky no-print' },
      el('button', {
        class: 'btn btn--primary btn--block',
        type: 'button',
        text: `PDFで保存（${paper}横）`,
        onclick: () => savePdf(monthLabel),
      }),
      el('button', {
        class: 'btn btn--quiet btn--block',
        type: 'button',
        text: '割り振りの結果に戻る',
        onclick: () => ctx.go('assign', { runId: run.runId }),
      })),
  );
}

/**
 * 用紙の向きと大きさ。@page は CSS 変数を受けないので、選んだ用紙の
 * 規則をその都度差し込む。
 */
function applyPageSize(paper: PaperSize): void {
  const id = 'weekly-page-size';
  const style = document.getElementById(id) ?? document.head.appendChild(el('style', { id }));
  style.textContent = `@media print { @page { size: ${paper} landscape; margin: ${PAGE_MARGIN_MM}mm; } }`;
}

function savePdf(monthLabel: string): void {
  // 書きかけの備考を確定させてから印刷する（change は focus が外れたときに出る）。
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

  // 保存するときのファイル名の元になる。
  const previousTitle = document.title;
  document.title = `業務割り振り_${monthLabel}`;
  const restore = (): void => {
    document.title = previousTitle;
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
}

/** 1行あたりの高さ（em）。行の高さ = 欄の中の行数 × 行送り + 上下の余白。 */
const LINE_EM = 1.25;
const PAD_EM = 0.5;

function rowEm(lines: number): number {
  return Math.max(1, lines) * LINE_EM + PAD_EM;
}

function cellLines(row: WeekRow, names: readonly string[] | null): number {
  if (!names) return 1;
  return row.derive === 'rest' ? Math.ceil(names.length / NAMES_PER_LINE) : names.length;
}

/**
 * その週の表の高さを em で見積もる。印刷ではページの高さをこれで割って
 * 文字の大きさを決めるので、行の多い週でも1枚に収まる。
 */
export function sheetEm(sheet: WeekSheet): number {
  const header = rowEm(1);
  const attendance = sheet.attendance
    .reduce((sum, row) => sum + rowEm(Math.max(...row.cells.map((c) => c?.length ?? 1))), 0);
  const tasks = sheet.rows
    .reduce((sum, row) => sum + rowEm(Math.max(...row.cells.map((c) => cellLines(row, c)))), 0);
  const notes = rowEm(2);
  return header + attendance + tasks + notes;
}

function renderSheet(
  sheet: WeekSheet,
  monthLabel: string,
  page: number,
  pages: number,
  saveNote: (day: number, text: string) => void,
): HTMLElement {
  const days = sheet.columns.map((c) => c.day).filter((d): d is number => d !== null);
  const range = days.length > 0 ? `${days[0]}日〜${days[days.length - 1]}日` : '';

  return el('section', { class: 'weekly-sheet', style: `--sheet-em:${sheetEm(sheet).toFixed(2)}` },
    el('header', { class: 'weekly-sheet__head' },
      el('h2', { class: 'weekly-sheet__title', text: `${monthLabel} 業務割り振り` }),
      el('span', { class: 'weekly-sheet__range', text: `第${page}週 ${range}（${page}/${pages}）` })),
    el('div', { class: 'weekly-scroll' },
      el('table', { class: 'weekly-table' },
        el('colgroup', {},
          el('col', { class: 'weekly-table__col-task' }),
          ...sheet.columns.map(() => el('col', {}))),
        el('thead', {},
          el('tr', {},
            el('th', { class: 'weekly-table__task', text: '業務' }),
            ...sheet.columns.map((column) => el('th', {
              class: `weekly-table__day weekly-table__day--${column.weekday}`,
              text: column.day === null ? '' : `${column.day}（${WEEKDAY_LABELS[column.weekday]}）`,
            })))),
        renderAttendance(sheet),
        ...renderTaskGroups(sheet),
        el('tbody', { class: 'weekly-group weekly-group--notes' },
          el('tr', { class: 'weekly-table__notes' },
            el('th', { class: 'weekly-table__task', scope: 'row', text: '備考' }),
            ...sheet.columns.map((column, i) =>
              renderNote(column.day, sheet.notes[i] ?? null, saveNote)))))));
}

/** 出勤の欄。区分ごとに1行、色と区切り線で分ける。 */
function renderAttendance(sheet: WeekSheet): HTMLElement | null {
  if (sheet.attendance.length === 0) return null;
  return el('tbody', { class: 'weekly-group weekly-group--attend' },
    ...sheet.attendance.map((row, i) => el('tr', { class: `weekly-attend weekly-attend--${row.kind}` },
      el('th', { class: 'weekly-table__task', scope: 'row' },
        i === 0 ? el('span', { class: 'weekly-table__slot', text: '出勤' }) : null,
        row.label),
      ...row.cells.map((cell) => renderAttendCell(cell)))));
}

function renderAttendCell(cell: readonly AttendanceCell[] | null): HTMLElement {
  if (cell === null) return el('td', { class: 'weekly-table__none' });
  return el('td', {},
    ...cell.map((entry) => el('div', {
      class: `weekly-attend__entry weekly-attend__entry--${entry.status}`,
    },
      entry.startTime ? el('span', { class: 'weekly-attend__time', text: entry.startTime }) : null,
      entry.name,
      entry.status === 'added' ? el('span', { class: 'weekly-attend__tag', text: '追加' }) : null,
      entry.status === 'changed' ? el('span', { class: 'weekly-attend__tag', text: '変更' }) : null)));
}

/** 業務を時間帯ごとの塊にする。塊の間は太い線、業務の間は線と地の色で分ける。 */
function renderTaskGroups(sheet: WeekSheet): HTMLElement[] {
  const groups: WeekRow[][] = [];
  for (const row of sheet.rows) {
    const last = groups[groups.length - 1];
    if (last && last[0]?.slot === row.slot) last.push(row);
    else groups.push([row]);
  }
  return groups.map((rows) => el('tbody', { class: `weekly-group weekly-group--${rows[0]?.slot ?? 'PM'}` },
    ...rows.map((row, i) => el('tr', { class: 'weekly-task' },
      el('th', { class: 'weekly-table__task', scope: 'row' },
        i === 0 ? el('span', { class: 'weekly-table__slot', text: SLOT_LABELS[row.slot] }) : null,
        row.name),
      ...row.cells.map((names) => renderCell(row, names))))));
}

function renderCell(row: WeekRow, names: readonly string[] | null): HTMLElement {
  if (names === null) return el('td', { class: 'weekly-table__none' });
  if (row.derive === 'rest') {
    // 洗面のように人数の多い欄は、1人1行にすると表が縦に伸びるので詰めて並べる。
    return el('td', { class: 'weekly-table__rest' },
      ...names.map((name) => el('span', { class: 'weekly-table__name', text: name })));
  }
  return el('td', {},
    ...names.map((name) => el('div', {
      class: name ? 'weekly-table__name' : 'weekly-table__name weekly-table__name--empty',
      text: name || '空き',
    })));
}

/**
 * 備考の欄。画面では書き込め、印刷では文字だけを出す。
 * textarea をそのまま印刷すると枠からはみ出た行が切れるので、写しの div を持つ。
 */
function renderNote(
  day: number | null,
  text: string | null,
  saveNote: (day: number, text: string) => void,
): HTMLElement {
  if (day === null) return el('td', { class: 'weekly-table__none' });

  const printed = el('div', { class: 'weekly-note__print', text: text ?? '' });
  const input = el('textarea', {
    class: 'weekly-note__input',
    rows: 2,
    'aria-label': `${day}日の備考`,
    oninput: (event: Event) => {
      printed.textContent = (event.currentTarget as HTMLTextAreaElement).value;
    },
    onchange: (event: Event) => saveNote(day, (event.currentTarget as HTMLTextAreaElement).value),
  });
  input.value = text ?? '';
  return el('td', { class: 'weekly-note' }, input, printed);
}
