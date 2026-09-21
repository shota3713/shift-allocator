/**
 * 読み取りの確認。人×日の表を原本と見比べる画面。
 *
 * 未解決（赤）が1件でも残っていれば確定させない。埋めてしまうと、
 * 誰も気づかないまま出勤していない日に業務が割り当たる。
 *
 * 氏名列と日付行は固定して、横に長い表でも「誰の何日か」を見失わないようにする。
 */

import type { Ctx } from '../app';
import { el, openSheet, toast } from '../dom';
import {
  applyCellFix,
  applyNameFix,
  commitImport,
  type ImportReview,
  type ReviewCell,
  type ReviewRow,
} from '../../core/import';
import { FLAG } from '../../core/resolve';
import { WEEKDAY_LABELS } from '../../core/types';
import { defaultTasks } from '../../core/masters';
import { weekdayOf } from '../../core/plan';

export function renderReview(root: HTMLElement, ctx: Ctx): void {
  const review = ctx.state.review;
  if (!review) {
    root.append(
      el('div', { class: 'empty' }, el('p', { text: '確認するデータがありません。' })),
      el('button', {
        class: 'btn btn--quiet',
        type: 'button',
        text: '勤務表を読み込む',
        onclick: () => ctx.go('import'),
      }),
    );
    return;
  }

  const workingCodes = new Set(ctx.db.shiftTypes.filter((t) => t.isWorking).map((t) => t.code));

  root.replaceChildren(
    el('div', { style: 'padding-inline:var(--gutter)' },
      el('div', { class: 'tally' },
        tally(String(review.rows.length), '人', ''),
        tally(String(review.days.length), '日', ''),
        tally(String(review.blockCount), '未解決', review.blockCount > 0 ? 'blocked' : 'settled'),
        tally(String(review.reviewCount), '要確認', review.reviewCount > 0 ? 'caution' : 'settled')),
      review.blockCount > 0
        ? el('div', { class: 'notice notice--blocked', style: 'margin-top:var(--step-4)' },
            el('strong', { text: `赤い欄が ${review.blockCount} 件あります。` }),
            el('span', { text: 'タップして原本どおりに直すと確定できます。' }))
        : el('div', { class: 'notice notice--settled', style: 'margin-top:var(--step-4)' },
            el('strong', { text: '未解決はありません。' }),
            el('span', { text: '原本とざっと見比べて、問題なければ確定してください。' }))),
    buildSheet(review, workingCodes, ctx),
    el('div', { style: 'padding-inline:var(--gutter)' },
      el('div', { class: 'actions actions--sticky' },
        el('button', {
          class: 'btn btn--primary btn--block',
          type: 'button',
          disabled: review.blockCount > 0,
          text: review.blockCount > 0 ? `未解決が ${review.blockCount} 件あります` : 'この内容で確定する',
          onclick: () => confirmImport(ctx),
        }))),
  );
}

function tally(value: string, label: string, tone: string): HTMLElement {
  return el('div', { class: tone ? `tally__item tally__item--${tone}` : 'tally__item' },
    el('span', { class: 'tally__value', text: value }),
    el('span', { class: 'tally__label', text: label }));
}

function buildSheet(
  review: ImportReview,
  workingCodes: ReadonlySet<string>,
  ctx: Ctx,
): HTMLElement {
  const [yearText, monthText] = review.periodKey.split('-');
  const year = Number(yearText);
  const month = Number(monthText);

  const head = el('tr', {},
    el('th', { class: 'sheet__corner', text: '氏名' }),
    ...review.days.map((day) => {
      const weekday = Number.isFinite(year) && Number.isFinite(month)
        ? weekdayOf(year, month, day)
        : null;
      const label = weekday ? WEEKDAY_LABELS[weekday] : '';
      const rest = weekday === 'sat' || weekday === 'sun';
      return el('th', { class: rest ? 'sheet__day sheet__day--rest' : 'sheet__day', scope: 'col' },
        String(day), el('span', { text: label }));
    }));

  const body = el('tbody', {},
    ...review.rows.map((row) => renderRow(row, workingCodes, ctx)));

  return el('div', { class: 'sheet-scroll' },
    el('table', { class: 'sheet' }, el('thead', {}, head), body));
}

function renderRow(row: ReviewRow, workingCodes: ReadonlySet<string>, ctx: Ctx): HTMLElement {
  const nameCell = el('th', {
    class: 'sheet__name',
    scope: 'row',
    style: row.nameFlag === FLAG.BLOCK ? 'background:var(--blocked-wash);color:var(--blocked)' : '',
  },
    el('button', {
      class: 'btn btn--quiet btn--small',
      type: 'button',
      style: 'border:0;background:none;padding:0;min-height:0;font-weight:700;text-align:left',
      text: row.rawName,
      onclick: () => openNameFix(row, ctx),
    }),
    el('small', { text: row.nameFlag === FLAG.OK ? row.job : row.nameReason }));

  return el('tr', {}, nameCell,
    ...row.cells.map((cell) => el('td', {},
      el('button', {
        class: cellClass(cell, workingCodes),
        type: 'button',
        title: cell.reason || cell.raw,
        text: cellLabel(cell),
        onclick: () => openCellFix(row, cell, ctx),
      }))));
}

function cellClass(cell: ReviewCell, workingCodes: ReadonlySet<string>): string {
  const parts = ['cell'];
  if (cell.flag === FLAG.BLOCK) parts.push('cell--blocked');
  else if (cell.flag === FLAG.REVIEW) parts.push('cell--review');
  else if (cell.code && workingCodes.has(cell.code)) parts.push('cell--work');
  if (cell.memo) parts.push('cell--memo');
  return parts.join(' ');
}

function cellLabel(cell: ReviewCell): string {
  if (cell.flag === FLAG.BLOCK) return '？';
  if (!cell.code || cell.code === 'OFF') return '休';
  // 末尾の事業所コードは意味を持たないので表には出さない。
  return cell.code.replace(/_\d{3}(?:DS|SS)$/u, '');
}

function openCellFix(row: ReviewRow, cell: ReviewCell, ctx: Ctx): void {
  const types = ctx.db.shiftTypes;
  const select = el('select', { 'aria-label': '勤務区分' },
    el('option', { value: '', text: '選んでください', selected: !cell.code }),
    ...types.map((t) =>
      el('option', {
        value: t.code,
        text: `${t.code}（${t.isWorking ? '出勤' : '休み'}）`,
        selected: cell.code === t.code,
      })));

  const close = openSheet({
    title: `${row.rawName} ${cell.day}日`,
    lead: cell.raw ? `原本の文字: ${cell.raw}` : '原本にこの欄の文字がありません',
    body: el('div', {},
      cell.reason ? el('p', { class: 'notice', text: cell.reason }) : null,
      cell.memo ? el('p', { class: 'card__body', text: `業務メモ: ${cell.memo}` }) : null,
      el('div', { class: 'field' },
        el('label', { class: 'field__label', text: '勤務区分' }), select),
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: 'この値にする',
          onclick: () => {
            if (!select.value) {
              toast('勤務区分を選んでください', 'blocked');
              return;
            }
            const current = ctx.state.review;
            if (current) ctx.setReview(applyCellFix(current, row.rowNo, cell.day, select.value));
            close();
            ctx.refresh();
          },
        }),
        el('button', { class: 'btn btn--quiet', type: 'button', text: 'やめる', onclick: () => close() }))),
  });
}

function openNameFix(row: ReviewRow, ctx: Ctx): void {
  const select = el('select', { 'aria-label': '職員' },
    el('option', { value: '', text: '選んでください', selected: !row.staffId }),
    ...ctx.db.staff.map((s) =>
      el('option', { value: s.staffId, text: `${s.name}（${s.job}）`, selected: row.staffId === s.staffId })));

  const close = openSheet({
    title: row.rawName,
    lead: row.nameReason || '名簿の誰かを選びます',
    body: el('div', {},
      row.candidates.length > 0
        ? el('p', { class: 'card__body',
            text: `近い名前: ${row.candidates.map((c) => `${c.name}(${Math.round(c.score * 100)}%)`).join('、')}` })
        : null,
      el('div', { class: 'field', style: 'margin-top:var(--step-3)' },
        el('label', { class: 'field__label', text: '名簿の職員' }), select),
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: 'この人にする',
          onclick: () => {
            if (!select.value) {
              toast('職員を選んでください', 'blocked');
              return;
            }
            const current = ctx.state.review;
            if (current) ctx.setReview(applyNameFix(current, row.rowNo, select.value));
            close();
            ctx.refresh();
          },
        }),
        el('button', { class: 'btn btn--quiet', type: 'button', text: 'やめる', onclick: () => close() }))),
  });
}

function confirmImport(ctx: Ctx): void {
  const review = ctx.state.review;
  if (!review) return;
  try {
    ctx.update((db) => {
      const committed = commitImport(db, review);
      // 業務がまだ無ければ標準の9業務を入れる。初回に設定画面へ行かせないため。
      return committed.tasks.length > 0
        ? committed
        : { ...committed, tasks: defaultTasks(committed.settings.careJobs) };
    });
    ctx.setReview(null);
    toast('確定しました。次は割り振りです。');
    ctx.go('home', { period: review.periodKey });
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'blocked');
  }
}
