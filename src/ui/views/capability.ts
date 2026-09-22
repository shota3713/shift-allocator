/**
 * 「誰が何を担当できるか」の設定。
 *
 * ここが無いと、清掃専任の人に昼担当が乗り、ドライバーが連絡帳係になる。
 * 職種だけでは決まらないので、最後は人が選ぶ。
 *
 * 同じ設定を2つの入り口から触れるようにしてある。業務から見て「リハ担当は
 * この3人」と決めることもあれば、人から見て「この人は入浴と体操だけ」と
 * 決めることもある。どちらも同じ1つの表を書き換える。
 */

import type { Ctx } from '../app';
import { el, openSheet, toast } from '../dom';
import { isConfigured, setSkills, setTaskMembers, taskIdsFor } from '../../core/skills';
import { SLOT_LABELS, type Staff, type Task } from '../../core/types';

/** ある業務を担当できる人の staffId。 */
function membersOf(ctx: Ctx, taskId: string): string[] {
  const db = ctx.db;
  return db.staff
    .filter((s) => taskIdsFor(s.staffId, s.job, db.tasks, db.skills).includes(taskId))
    .map((s) => s.staffId);
}

export function renderCapability(root: HTMLElement, ctx: Ctx): void {
  const db = ctx.db;

  root.append(el('h2', { class: 'section-title', text: '担当できる人' }));

  if (db.tasks.length === 0 || db.staff.length === 0) {
    root.append(el('div', { class: 'card' },
      el('p', { class: 'card__body',
        text: '業務と職員がそろうと、ここで「誰が何をできるか」を選べます。' })));
    return;
  }

  const unset = db.staff.filter((s) => !isConfigured(s.staffId, db.skills)).length;
  root.append(
    el('p', { class: 'card__body',
      text: unset > 0
        ? `${unset}人はまだ未設定で、職種から自動で判断しています。選ぶとその内容が優先されます。`
        : '全員ぶん選んであります。' }),
    el('p', { class: 'card__body', style: 'margin-bottom:var(--step-3)',
      text: '一度選べば、来月の勤務表を取り込んだあともそのまま使います。同じ名前の人に引き継ぎます。' }),
    el('div', { class: 'rows' }, ...db.tasks.map((task) => renderTaskRow(task, ctx))),
    el('h3', { class: 'card__title', style: 'margin-top:var(--step-5)', text: '職員ごとに選ぶ' }),
    el('div', { class: 'rows' }, ...db.staff.map((person) => renderStaffRow(person, ctx))),
  );
}

function renderTaskRow(task: Task, ctx: Ctx): HTMLElement {
  const members = membersOf(ctx, task.taskId);
  const tone = members.length === 0
    ? 'row row--blocked'
    : members.length < task.headcount ? 'row row--caution' : 'row';
  const names = members
    .map((id) => ctx.db.staff.find((s) => s.staffId === id)?.name ?? id)
    .join('、');

  return el('button', {
    class: tone,
    type: 'button',
    style: 'text-align:left;cursor:pointer',
    onclick: () => openTaskMembers(task, ctx),
  },
    el('div', { class: 'row__main' },
      el('span', { class: 'row__title',
        text: `${task.name}（${SLOT_LABELS[task.slot]}・${task.headcount}人）` }),
      el('span', { class: 'row__note',
        text: members.length === 0 ? '担当できる人がいません' : `${members.length}人: ${names}` })),
    el('span', { class: 'pill', text: '選ぶ' }));
}

function openTaskMembers(task: Task, ctx: Ctx): void {
  const chosen = new Set(membersOf(ctx, task.taskId));
  const count = el('span', { class: 'field__hint' });
  const boxes: HTMLInputElement[] = [];

  const refreshCount = (): void => {
    count.textContent = `${chosen.size}人を選んでいます（必要 ${task.headcount}人）`;
  };

  const byJob = new Map<string, Staff[]>();
  for (const person of ctx.db.staff) {
    const key = person.job || '職種なし';
    const bucket = byJob.get(key);
    if (bucket) bucket.push(person);
    else byJob.set(key, [person]);
  }

  const groups = [...byJob.entries()].map(([job, members]) =>
    el('div', { style: 'margin-bottom:var(--step-3)' },
      el('span', { class: 'field__label', text: job }),
      ...members.map((person) => {
        const box = el('input', {
          type: 'checkbox',
          checked: chosen.has(person.staffId),
          onchange: (event: Event) => {
            if ((event.currentTarget as HTMLInputElement).checked) chosen.add(person.staffId);
            else chosen.delete(person.staffId);
            refreshCount();
          },
        });
        boxes.push(box);
        return el('label', { class: 'switch' }, box, el('span', { text: person.name }));
      })));

  const setAll = (value: boolean): void => {
    for (const person of ctx.db.staff) {
      if (value) chosen.add(person.staffId);
      else chosen.delete(person.staffId);
    }
    for (const box of boxes) box.checked = value;
    refreshCount();
  };

  refreshCount();

  const close = openSheet({
    title: `${task.name} を担当できる人`,
    lead: 'ここで外した人には、この業務が回りません。',
    body: el('div', {},
      count,
      el('div', { class: 'actions', style: 'margin:var(--step-3) 0' },
        el('button', { class: 'btn btn--quiet btn--small', type: 'button', text: '全員にする',
          onclick: () => setAll(true) }),
        el('button', { class: 'btn btn--quiet btn--small', type: 'button', text: '全員外す',
          onclick: () => setAll(false) })),
      ...groups,
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: '保存する',
          onclick: () => {
            ctx.update((db) => ({
              ...db,
              skills: setTaskMembers(db.skills, db.staff, db.tasks, task.taskId, [...chosen]),
            }));
            close();
            toast(`${task.name} は ${chosen.size}人が担当できます。`);
          },
        }),
        el('button', { class: 'btn btn--quiet', type: 'button', text: 'やめる',
          onclick: () => close() }))),
  });
}

function renderStaffRow(person: Staff, ctx: Ctx): HTMLElement {
  const db = ctx.db;
  const taskIds = taskIdsFor(person.staffId, person.job, db.tasks, db.skills);
  const names = taskIds
    .map((id) => db.tasks.find((t) => t.taskId === id)?.name ?? id)
    .join('、');
  const configured = isConfigured(person.staffId, db.skills);

  return el('button', {
    class: taskIds.length === 0 ? 'row row--caution' : 'row',
    type: 'button',
    style: 'text-align:left;cursor:pointer',
    onclick: () => openStaffTasks(person, ctx),
  },
    el('div', { class: 'row__main' },
      el('span', { class: 'row__title', text: `${person.name}（${person.job}）` }),
      el('span', { class: 'row__note', text: taskIds.length === 0 ? '担当する業務なし' : names })),
    el('span', {
      class: configured ? 'pill pill--settled' : 'pill',
      text: configured ? '設定済み' : '職種から',
    }));
}

function openStaffTasks(person: Staff, ctx: Ctx): void {
  const db = ctx.db;
  const chosen = new Set(taskIdsFor(person.staffId, person.job, db.tasks, db.skills));

  const boxes = db.tasks.map((task) =>
    el('label', { class: 'switch' },
      el('input', {
        type: 'checkbox',
        checked: chosen.has(task.taskId),
        onchange: (event: Event) => {
          if ((event.currentTarget as HTMLInputElement).checked) chosen.add(task.taskId);
          else chosen.delete(task.taskId);
        },
      }),
      el('span', { text: `${task.name}（${SLOT_LABELS[task.slot]}）` })));

  const close = openSheet({
    title: `${person.name} が担当できる業務`,
    lead: `${person.job}。ここで選んだ業務だけが回ります。`,
    body: el('div', {},
      ...boxes,
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: '保存する',
          onclick: () => {
            ctx.update((current) => ({
              ...current,
              skills: setSkills(current.skills, person.staffId, [...chosen]),
            }));
            close();
            toast(`${person.name} は ${chosen.size}件を担当できます。`);
          },
        }),
        el('button', { class: 'btn btn--quiet', type: 'button', text: 'やめる',
          onclick: () => close() }))),
  });
}
