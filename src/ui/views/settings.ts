/**
 * 設定。毎月は触らないものを置く。
 *
 * 初回にやることは2つ。業務ごとに担当できる人を選ぶことと、勤務区分の
 * 半日の扱い（フリーかどうか）を確かめること。この2つが決まれば、あとは
 * 毎月「読み込む → 確認する → 割り振る」だけで回る。
 */

import type { Ctx } from '../app';
import { buildId, el, openSheet, toast } from '../dom';
import { DEFAULT_DIFFICULTY, DIFFICULTY_LEVELS, labelOf } from '../../core/difficulty';
import { describeRules } from '../../core/learn';
import { defaultTasks } from '../../core/masters';
import { taskIdsFor } from '../../core/skills';
import { exportBackup, importBackup, newId, saveDatabase, type Database } from '../../store/db';
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
                toast(`標準の${defaultTasks(ctx.db.settings.careJobs).length}業務を作りました。`);
              },
            })))
      : el('div', { class: 'rows' }, ...db.tasks.map((task) => renderTaskRow(task, ctx))),
    el('div', { class: 'actions', style: 'margin-top:var(--step-3)' },
      el('button', {
        class: 'btn btn--quiet btn--small',
        type: 'button',
        text: '業務を追加する',
        onclick: () => openTaskPicker(ctx),
      })),
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

  root.append(el('p', { class: 'footnote', text: `シフト振り分け v2 / 版 ${buildId()}` }));
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
        text: `${SLOT_LABELS[task.slot]} / ${task.headcount}人必要 / 難易度 ${task.difficulty}（${labelOf(task.difficulty)}） / 担当できる人 ${capable}人` }),
      task.note ? el('span', { class: 'row__note', text: task.note }) : null),
    el('span', { class: task.active ? 'pill pill--settled' : 'pill', text: task.active ? '有効' : '停止' }));
}

function openTaskEditor(task: Task, ctx: Ctx, isNew = false): void {
  const name = el('input', { type: 'text', value: task.name, placeholder: '例）手作業' });
  const slot = el('select', {}, ...SLOT_ORDER.map((s) =>
    el('option', { value: s, text: SLOT_LABELS[s], selected: task.slot === s })));
  const headcount = el('input', { type: 'number', min: '1', max: '20', value: String(task.headcount) });
  const minHeadcount = el('input', {
    type: 'number', min: '1', max: '20', value: String(task.minHeadcount),
  });
  const difficulty = el('select', { 'aria-label': '難易度' },
    ...DIFFICULTY_LEVELS.map((level) =>
      el('option', {
        value: String(level.level),
        text: `${level.level}. ${level.label} — ${level.hint}`,
        selected: level.level === task.difficulty,
      })));
  const jobs = el('input', { type: 'text', value: task.eligibleJob.join('、') });
  const active = el('input', { type: 'checkbox', checked: task.active });

  const close = openSheet({
    title: isNew ? '業務を追加する' : task.name,
    lead: '人ごとの担当可否は「担当できる人」で選びます。ここは業務そのものの形。',
    body: el('div', {},
      field('業務名', name),
      field('時間帯', slot),
      field('必要人数', headcount),
      field('人が足りない日の最低人数', minHeadcount,
        '出られる人が少ない日は、ここまで人数を落として枠を立てます。減らしたくなければ必要人数と同じに。'),
      field('難易度', difficulty, '5段階。高いほど、同じ人に続けて当たらないようにします。'),
      field('職種の初期値', jobs, 'まだ選んでいない人をこの職種で判断します。「、」で区切ります。'),
      task.preferOrder.length > 0 || task.allowSameSlot
        ? el('p', { class: 'field__hint', style: 'margin-bottom:var(--step-4)', text: task.note })
        : null,
      el('label', { class: 'switch' }, active, el('span', { text: 'この業務を割り振る' })),
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: isNew ? '追加する' : '保存する',
          onclick: () => {
            const head = Math.max(1, Number(headcount.value) || 1);
            const patch = {
              name: name.value.trim() || task.name,
              slot: slot.value as Task['slot'],
              headcount: head,
              minHeadcount: Math.min(head, Math.max(1, Number(minHeadcount.value) || head)),
              difficulty: Number(difficulty.value) as Task['difficulty'],
              eligibleJob: jobs.value.split(/[、,|]/u).map((s) => s.trim()).filter(Boolean),
              active: active.checked,
            };
            if (isNew && !patch.name.trim()) {
              toast('業務名を入れてください。', 'blocked');
              return;
            }
            ctx.update((db) => ({
              ...db,
              tasks: isNew
                ? [...db.tasks, { ...task, ...patch }]
                : db.tasks.map((t) => (t.taskId !== task.taskId ? t : { ...t, ...patch })),
            }));
            close();
            toast(isNew ? `${patch.name} を追加しました。` : '保存しました。');
          },
        }),
        el('button', { class: 'btn btn--quiet', type: 'button', text: 'やめる', onclick: () => close() }),
        isNew
          ? null
          : el('button', {
              class: 'btn btn--danger btn--small',
              type: 'button',
              text: 'この業務を消す',
              onclick: () => {
                ctx.update((db) => ({
                  ...db,
                  tasks: db.tasks.filter((t) => t.taskId !== task.taskId),
                  skills: db.skills.map((s) => ({
                    ...s,
                    taskIds: s.taskIds.filter((id) => id !== task.taskId),
                  })),
                }));
                close();
                toast(`${task.name} を消しました。`);
              },
            }))),
  });
}

/**
 * 業務を足す。
 *
 * 標準の業務でまだ入っていないものを先に出す。名前と時間帯を毎回
 * 打ち直させる意味がない。無ければ白紙から作る。
 */
function openTaskPicker(ctx: Ctx): void {
  const existing = new Set(ctx.db.tasks.map((t) => t.taskId));
  const missing = defaultTasks(ctx.db.settings.careJobs).filter((t) => !existing.has(t.taskId));

  const blank: Task = {
    taskId: newId('task'),
    name: '',
    slot: SLOT_ORDER[0] as Task['slot'],
    difficulty: DEFAULT_DIFFICULTY,
    headcount: 1,
    minHeadcount: 1,
    allowSameSlot: false,
    avoidWith: [],
    eligibleJob: [...ctx.db.settings.careJobs],
    preferOrder: [],
    exclusiveGroup: '',
    appliesTo: 'all',
    active: true,
    note: '',
  };

  const close = openSheet({
    title: '業務を追加する',
    lead: missing.length > 0
      ? '標準の業務でまだ入っていないものです。'
      : '標準の業務はすべて入っています。',
    body: el('div', {},
      ...missing.map((task) =>
        el('button', {
          class: 'row',
          type: 'button',
          style: 'text-align:left;cursor:pointer;width:100%',
          onclick: () => {
            ctx.update((db) => ({ ...db, tasks: [...db.tasks, task] }));
            close();
            toast(`${task.name} を追加しました。`);
          },
        },
          el('div', { class: 'row__main' },
            el('span', { class: 'row__title', text: task.name }),
            el('span', { class: 'row__note',
              text: `${SLOT_LABELS[task.slot]} / ${task.headcount}人 / ${labelOf(task.difficulty)}` })),
          el('span', { class: 'pill', text: '追加' }))),
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: '白紙から作る',
          onclick: () => {
            close();
            openTaskEditor(blank, ctx, true);
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
