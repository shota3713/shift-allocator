/**
 * 週ごとの表。割り振りの結果を1週1ページの「業務 × 曜日」で見て、
 * 備考を書き足してから PDF に保存する。
 *
 * 画面に出している表をそのまま印刷する。見たものと保存されるものが違うと、
 * 確かめた意味がなくなる。PDFを自前で組まないのは、日本語フォントを抱えると
 * 数MBになるから。ブラウザの印刷なら「PDFに保存」を選ぶだけで済む。
 */

import type { Ctx } from '../app';
import { el } from '../dom';
import { buildPlan } from '../../core/plan';
import { buildWeeklySheets, type WeekSheet } from '../../core/weekly';
import { SLOT_LABELS, WEEKDAY_LABELS } from '../../core/types';
import { dayNotesFor, setDayNote, updateDatabase } from '../../store/db';

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

  const monthLabel = `${plan.year}年${plan.month}月`;
  const sheets = buildWeeklySheets(plan, run.assignments, dayNotesFor(db, period));
  const saveNote = (day: number, text: string): void => {
    updateDatabase((current) => setDayNote(current, period, day, text));
  };

  root.append(
    el('p', { class: 'weekly-lead no-print',
      text: '内容を確かめて、必要なら下の備考に書き足してから「PDFで保存」を押してください。備考は自動で残ります。' }),
    ...sheets.map((sheet, index) => renderSheet(sheet, monthLabel, index + 1, sheets.length, saveNote)),
    el('div', { class: 'actions actions--sticky no-print' },
      el('button', {
        class: 'btn btn--primary btn--block',
        type: 'button',
        text: 'PDFで保存',
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

function renderSheet(
  sheet: WeekSheet,
  monthLabel: string,
  page: number,
  pages: number,
  saveNote: (day: number, text: string) => void,
): HTMLElement {
  const days = sheet.columns.map((c) => c.day).filter((d): d is number => d !== null);
  const range = days.length > 0 ? `${days[0]}日〜${days[days.length - 1]}日` : '';

  return el('section', { class: 'weekly-sheet' },
    el('header', { class: 'weekly-sheet__head' },
      el('h2', { class: 'weekly-sheet__title', text: `${monthLabel} 業務割り振り` }),
      el('span', { class: 'weekly-sheet__range', text: `第${page}週 ${range}（${page}/${pages}）` })),
    el('div', { class: 'weekly-scroll' },
      el('table', { class: 'weekly-table' },
        el('thead', {},
          el('tr', {},
            el('th', { class: 'weekly-table__task', text: '業務' }),
            ...sheet.columns.map((column) => el('th', {
              class: `weekly-table__day weekly-table__day--${column.weekday}`,
              text: column.day === null ? '' : `${column.day}（${WEEKDAY_LABELS[column.weekday]}）`,
            })))),
        el('tbody', {},
          ...sheet.rows.map((row) => el('tr', {},
            el('th', { class: 'weekly-table__task', scope: 'row' },
              el('span', { class: 'weekly-table__slot', text: SLOT_LABELS[row.slot] }),
              row.name),
            ...row.cells.map(renderCell))),
          el('tr', { class: 'weekly-table__notes' },
            el('th', { class: 'weekly-table__task', scope: 'row', text: '備考' }),
            ...sheet.columns.map((column, i) =>
              renderNote(column.day, sheet.notes[i] ?? null, saveNote)))))));
}

function renderCell(names: readonly string[] | null): HTMLElement {
  if (names === null) return el('td', { class: 'weekly-table__none' });
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
