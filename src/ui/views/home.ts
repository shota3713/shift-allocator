/**
 * ホーム。今月やることを上から3つ並べる。
 *
 * 状態（未着手・要確認・済み）は色と文で両方出す。色だけだと
 * 明るい屋外や色覚の違いで伝わらない。
 */

import { chevronIcon, type Ctx, type ViewName } from '../app';
import { el } from '../dom';

interface StepSpec {
  readonly index: number;
  readonly label: string;
  readonly state: string;
  readonly tone: 'idle' | 'current' | 'done' | 'blocked';
  readonly to: ViewName;
  readonly disabled?: boolean;
}

function periodLabel(period: string): string {
  const [year, month] = period.split('-');
  return `${year}年${Number(month)}月`;
}

export function renderHome(root: HTMLElement, ctx: Ctx): void {
  const db = ctx.db;
  const period = ctx.state.period;
  const confirmedDays = new Set(
    db.confirmed.filter((c) => c.period === period).map((c) => c.day),
  ).size;
  const runs = db.runs.filter((r) => r.period === period);
  const review = ctx.state.review;

  const steps: StepSpec[] = [
    {
      index: 1,
      label: '勤務表を読み込む',
      state: review
        ? `読み取り済み（${review.rows.length}人）`
        : confirmedDays > 0
          ? `${confirmedDays}日ぶん取り込み済み`
          : 'PDFを選ぶ',
      tone: review || confirmedDays > 0 ? 'done' : 'current',
      to: 'import',
    },
    {
      index: 2,
      label: '確認して確定する',
      state: review
        ? review.blockCount > 0
          ? `未解決が ${review.blockCount} 件`
          : '確認待ち'
        : confirmedDays > 0
          ? '確定済み'
          : '先に読み込んでください',
      tone: review
        ? review.blockCount > 0 ? 'blocked' : 'current'
        : confirmedDays > 0 ? 'done' : 'idle',
      to: 'review',
      disabled: !review,
    },
    {
      index: 3,
      label: '業務を割り振る',
      state: runs.length > 0
        ? `${runs.length}件の結果`
        : confirmedDays > 0
          ? '実行できます'
          : '先に確定してください',
      tone: runs.length > 0 ? 'done' : confirmedDays > 0 ? 'current' : 'idle',
      to: 'assign',
      disabled: confirmedDays === 0,
    },
  ];

  root.append(
    el(
      'div',
      { class: 'period' },
      el('span', { class: 'period__value', text: periodLabel(period) }),
      el('span', {
        class: 'period__note',
        text: db.staff.length > 0 ? `職員 ${db.staff.length}人` : 'はじめての取り込み',
      }),
    ),
    el('p', {
      class: 'card__body',
      style: 'margin-bottom:var(--step-5)',
      text: '上から順にやれば終わります。',
    }),
    el('div', { class: 'steps' }, ...steps.map((step) => renderStep(step, ctx))),
  );

  if (db.rules.length > 0) {
    root.append(
      el('h2', { class: 'section-title', text: '学習したこと' }),
      el(
        'div',
        { class: 'card' },
        el('p', {
          class: 'card__body',
          text: `${db.rules.filter((r) => r.enabled).length}件のルールが割り振りに効いています。`,
        }),
        el(
          'div',
          { class: 'actions', style: 'margin-top:var(--step-3)' },
          el('button', {
            class: 'btn btn--quiet btn--small',
            type: 'button',
            text: '設定で見る',
            onclick: () => ctx.go('settings'),
          }),
        ),
      ),
    );
  }

  root.append(
    el('p', {
      class: 'footnote',
      text: 'データはこの端末のブラウザにだけ保存されます。',
    }),
  );
}

function renderStep(step: StepSpec, ctx: Ctx): HTMLElement {
  const toneClass = step.tone === 'idle' ? '' : ` step--${step.tone}`;
  return el(
    'button',
    {
      class: `step${toneClass}`,
      type: 'button',
      disabled: step.disabled === true,
      onclick: () => ctx.go(step.to),
    },
    el('span', {
      class: 'step__mark',
      text: step.tone === 'done' ? '✓' : String(step.index),
      'aria-hidden': 'true',
    }),
    el(
      'span',
      { class: 'step__main' },
      el('span', { class: 'step__label', text: step.label }),
      el('span', { class: 'step__state', text: step.state }),
    ),
    el('span', { class: 'step__chevron' }, chevronIcon()),
  );
}
