/**
 * 設定。毎月は触らないものを置く。
 *
 * 初回にやることは2つ。業務ごとに担当できる人を選ぶことと、勤務区分の
 * 半日の扱い（フリーかどうか）を確かめること。この2つが決まれば、あとは
 * 毎月「読み込む → 確認する → 割り振る」だけで回る。
 */

import type { Ctx } from '../app';
import { el, openSheet, toast } from '../dom';
import { describeRules } from '../../core/learn';
import { defaultTasks } from '../../core/masters';
import { taskIdsFor } from '../../core/skills';
import { exportBackup, importBackup, saveDatabase, type Database } from '../../store/db';
import { SLOT_LABELS, SLOT_ORDER, type Task } from '../../core/types';
import { renderCapability } from './capability';
import { renderShiftTypes } from './shiftTypes';

export function renderSettings(root: HTMLElement, ctx: Ctx): void {
  const db = ctx.db;

  root.append(
    el('h2', { class: 'section-title', text: '業務' }),
    db.tasks.length === 0
      ? el('div', { class: 'card' },
          el('p', { class: 'card__body', text: 'まだ業務がありません。' }),
          el('div', { class: 'actions', style: 'margin-top:var(--step-3)' },
            el('button', {
              class: 'btn btn--primary',
              type: 'button',
              text: '標準の業務を作る',
              onclick: () => {
                ctx.update((current) => ({ ...current, tasks: defaultTasks(current.settings.careJobs) }));
                toast('標準の9業務を作りました。');
              },
            })))
      : el('div', { class: 'rows' }, ...db.tasks.map((task) => renderTaskRow(task, ctx))),
  );

  renderCapability(root, ctx);
  renderShiftTypes(root, ctx);

  root.append(
    el('h2', { class: 'section-title', text: '職員' }),
    el('div', { class: 'card' },
      el('p', { class: 'card__body', text: `${db.staff.length}人が登録されています。` }),
      el('div', { class: 'actions', style: 'margin-top:var(--step-3)' },
        el('button', {
          class: 'btn btn--quiet btn--small',
          type: 'button',
          text: '一覧を見る',
          onclick: () => openStaffList(ctx),
        }))),
  );

  const rules = describeRules(db);
  root.append(
    el('h2', { class: 'section-title', text: '学習したルール' }),
    rules.length === 0
      ? el('div', { class: 'card' },
          el('p', { class: 'card__body', text: 'まだありません。担当を手で変えたときに作られます。' }))
      : el('div', { class: 'rows' }, ...rules.map((view) =>
          el('div', { class: 'row' },
            el('div', { class: 'row__main' },
              el('span', { class: 'row__title', text: view.label }),
              el('span', { class: 'row__note',
                text: `${view.rule.evidenceCount}回の修正から / 強さ ${view.rule.weight}` })),
            el('label', { class: 'switch' },
              el('input', {
                type: 'checkbox',
                checked: view.rule.enabled,
                'aria-label': `${view.label} を有効にする`,
                onchange: (event: Event) => {
                  const enabled = (event.currentTarget as HTMLInputElement).checked;
                  ctx.update((current) => ({
                    ...current,
                    rules: current.rules.map((r) =>
                      r.ruleId === view.rule.ruleId ? { ...r, enabled } : r),
                  }));
                },
              }),
              el('span', { text: view.rule.enabled ? '有効' : '無効' }))))),
  );

  root.append(
    el('h2', { class: 'section-title', text: 'データ' }),
    el('div', { class: 'card' },
      el('p', { class: 'card__body',
        text: 'データはこの端末のブラウザにだけあります。別の端末で使うときは書き出して読み込みます。' }),
      el('div', { class: 'actions', style: 'margin-top:var(--step-3)' },
        el('button', {
          class: 'btn btn--quiet btn--small',
          type: 'button',
          text: '書き出す',
          onclick: () => downloadBackup(db),
        }),
        el('label', { class: 'btn btn--quiet btn--small' }, '読み込む',
          el('input', {
            type: 'file',
            accept: 'application/json,.json',
            style: 'display:none',
            onchange: (event: Event) => {
              const file = (event.currentTarget as HTMLInputElement).files?.[0];
              if (file) void restoreBackup(file, ctx);
            },
          })),
        el('button', {
          class: 'btn btn--danger btn--small',
          type: 'button',
          text: 'すべて消す',
          onclick: () => confirmWipe(ctx),
        }))),
  );

  root.append(el('p', { class: 'footnote', text: 'シフト振り分け v2' }));
}

function renderTaskRow(task: Task, ctx: Ctx): HTMLElement {
  const db = ctx.db;
  const capable = db.staff.filter((s) =>
    taskIdsFor(s.staffId, s.job, db.tasks, db.skills).includes(task.taskId)).length;

  return el('button', {
    class: capable < task.headcount ? 'row row--caution' : 'row',
    type: 'button',
    style: 'text-align:left;cursor:pointer',
    onclick: () => openTaskEditor(task, ctx),
  },
    el('div', { class: 'row__main' },
      el('span', { class: 'row__title', text: task.name }),
      el('span', { class: 'row__note',
        text: `${SLOT_LABELS[task.slot]} / ${task.headcount}人必要 / 担当できる人 ${capable}人` }),
      task.note ? el('span', { class: 'row__note', text: task.note }) : null),
    el('span', { class: task.active ? 'pill pill--settled' : 'pill', text: task.active ? '有効' : '停止' }));
}

function openTaskEditor(task: Task, ctx: Ctx): void {
  const name = el('input', { type: 'text', value: task.name });
  const slot = el('select', {}, ...SLOT_ORDER.map((s) =>
    el('option', { value: s, text: SLOT_LABELS[s], selected: task.slot === s })));
  const headcount = el('input', { type: 'number', min: '1', max: '20', value: String(task.headcount) });
  const weight = el('input', { type: 'number', min: '0.5', max: '5', step: '0.5', value: String(task.weight) });
  const jobs = el('input', { type: 'text', value: task.eligibleJob.join('、') });
  const active = el('input', { type: 'checkbox', checked: task.active });

  const close = openSheet({
    title: task.name,
    lead: '人ごとの担当可否は「担当できる人」で選びます。ここは業務そのものの形。',
    body: el('div', {},
      field('業務名', name),
      field('時間帯', slot),
      field('必要人数', headcount),
      field('負担の重み', weight, 'リーダー業務ほど大きく。公平さの計算に使います。'),
      field('職種の初期値', jobs, 'まだ選んでいない人をこの職種で判断します。「、」で区切ります。'),
      task.preferOrder.length > 0
        ? el('p', { class: 'field__hint', style: 'margin-bottom:var(--step-4)',
            text: `優先順: ${task.note || task.preferOrder.join(' → ')}` })
        : null,
      el('label', { class: 'switch' }, active, el('span', { text: 'この業務を割り振る' })),
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: '保存する',
          onclick: () => {
            ctx.update((db) => ({
              ...db,
              tasks: db.tasks.map((t) => t.taskId !== task.taskId ? t : {
                ...t,
                name: name.value.trim() || t.name,
                slot: slot.value as Task['slot'],
                headcount: Math.max(1, Number(headcount.value) || 1),
                weight: Number(weight.value) || 1,
                eligibleJob: jobs.value.split(/[、,|]/u).map((s) => s.trim()).filter(Boolean),
                active: active.checked,
              }),
            }));
            close();
            toast('保存しました。');
          },
        }),
        el('button', { class: 'btn btn--quiet', type: 'button', text: 'やめる', onclick: () => close() }))),
  });
}

function openStaffList(ctx: Ctx): void {
  const close = openSheet({
    title: `職員 ${ctx.db.staff.length}人`,
    lead: '取り込んだ勤務表から起こした名簿です。',
    body: el('div', {},
      el('div', { class: 'rows' }, ...ctx.db.staff.map((s) =>
        el('div', { class: 'row' },
          el('div', { class: 'row__main' },
            el('span', { class: 'row__title', text: s.name }),
            el('span', { class: 'row__note', text: s.job })),
          el('span', { class: s.active ? 'pill pill--settled' : 'pill', text: s.active ? '在籍' : '停止' })))),
      el('div', { class: 'actions' },
        el('button', { class: 'btn btn--quiet', type: 'button', text: '閉じる', onclick: () => close() }))),
  });
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return el('div', { class: 'field' },
    el('label', { class: 'field__label', text: label }),
    hint ? el('span', { class: 'field__hint', text: hint }) : null,
    control);
}

function downloadBackup(db: Database): void {
  const blob = new Blob([exportBackup(db)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: `shift-backup-${new Date().toISOString().slice(0, 10)}.json` });
  link.click();
  URL.revokeObjectURL(url);
}

async function restoreBackup(file: File, ctx: Ctx): Promise<void> {
  try {
    const restored = importBackup(await file.text());
    saveDatabase(restored);
    ctx.refresh();
    toast('読み込みました。');
  } catch (error) {
    toast(`読み込めませんでした（${error instanceof Error ? error.message : String(error)}）`, 'blocked');
  }
}

function confirmWipe(ctx: Ctx): void {
  const close = openSheet({
    title: 'すべて消しますか？',
    lead: '職員・取り込み・割り振り・学習したルールが消えます。元に戻せません。',
    body: el('div', { class: 'actions' },
      el('button', {
        class: 'btn btn--danger',
        type: 'button',
        text: '消す',
        onclick: () => {
          ctx.update(() => ({
            version: 2, staff: [], aliases: [], tasks: [], shiftTypes: [], skills: [],
            confirmed: [], runs: [], corrections: [], rules: [], settings: ctx.db.settings,
          }));
          close();
          ctx.go('home');
          toast('消しました。');
        },
      }),
      el('button', { class: 'btn btn--quiet', type: 'button', text: 'やめる', onclick: () => close() })),
  });
}
