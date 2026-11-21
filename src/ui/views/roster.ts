/**
 * 当日の配置。勤務表の予定はそのまま残して、その日の実際の顔ぶれだけを変える。
 *
 *   - 予定はあったが当日いない人を外す
 *   - 予定になかった人を足す、勤務区分を変える
 *   - OJT・応援の人を、名簿とは別に何人でも足す
 *
 * 変えたら割り振り直す。結果は実行したときの写しなので、黙って書き換えない。
 */

import type { Ctx } from '../app';
import { el, openSheet, toast } from '../dom';
import { attendingFor, buildPlan, weekdayOf } from '../../core/plan';
import { defaultWorkCode, guestStaffId, plannedCodeOf } from '../../core/roster';
import { SHIFT_KIND_LABELS, isShortStayCode, shiftCodeBase } from '../../core/shiftCode';
import { attendanceGroup, formatHours } from '../../core/weekly';
import { WEEKDAY_LABELS, type AttendanceEntry } from '../../core/types';
import { GUEST_ROLES, newId, setRosterChange, type Database, type GuestRole } from '../../store/db';

/** OJT・応援の名前の長さの上限。表の欄に収まる長さにする。 */
const MAX_GUEST_NAME = 20;

const STATUS_LABELS: Record<AttendanceEntry['status'], string> = {
  planned: '予定どおり',
  changed: '区分を変更',
  added: '予定外の出勤',
  absent: '当日いない',
  guest: '',
};

/** 出勤の時刻と区分を1行で。例）早番 7:30〜16:30（早） */
export function describeShift(
  entry: Pick<AttendanceEntry, 'kind' | 'startTime' | 'endTime' | 'code' | 'driver'>,
): string {
  const hours = formatHours(entry.startTime, entry.endTime);
  const kind = entry.driver ? 'ドライバー' : SHIFT_KIND_LABELS[entry.kind];
  return `${kind}${hours ? ` ${hours}` : ''}（${shiftCodeBase(entry.code) || entry.code}）`;
}

/** 当日の区分として選べるコード。来ている扱いの区分だけ。 */
function workingCodes(db: Database): string[] {
  const attending = attendingFor(db);
  return db.shiftTypes.map((t) => t.code).filter((code) => code && attending(code))
    .sort((a, b) => (shiftCodeBase(a) < shiftCodeBase(b) ? -1 : 1));
}

function codeSelect(db: Database, selected: string, label: string): HTMLSelectElement {
  const codes = workingCodes(db);
  if (selected && !codes.includes(selected)) codes.unshift(selected);
  return el('select', { 'aria-label': label },
    ...codes.map((code) => el('option', {
      value: code,
      // 「日_032DS」と「日_032SS」は本体が同じなので、SS には印を付けて見分ける。
      text: `${shiftCodeBase(code) || code}${isShortStayCode(code) ? '（SSヘルプ）' : ''}`,
      selected: code === selected,
    })));
}

/** 職種の候補。名簿に出てくる職種と、介助業務の職種。 */
function jobOptions(db: Database): string[] {
  return [...new Set([...db.settings.careJobs, ...db.staff.map((s) => s.job)].filter(Boolean))];
}

export function openRosterSheet(ctx: Ctx, day: number): void {
  const period = ctx.state.period;
  let close = (): void => undefined;

  // 変えるたびに開き直して、いまの配置を見せる。
  const change = (update: (db: Database) => Database, message: string): void => {
    ctx.update(update);
    close();
    openRosterSheet(ctx, day);
    toast(message);
  };

  const db = ctx.db;
  const plan = buildPlan(db, period);
  const entries = plan.attendance.get(day) ?? [];
  const weekday = WEEKDAY_LABELS[weekdayOf(plan.year, plan.month, day)];

  close = openSheet({
    title: `${day}日（${weekday}）の当日の配置`,
    lead: '勤務表の予定はそのまま残ります。ここで変えるのは当日の顔ぶれだけです。変えたら割り振り直してください。',
    body: el('div', {},
      el('div', { class: 'rows' },
        ...(entries.length === 0
          ? [el('p', { class: 'card__body', text: 'この日に来る人はいません。' })]
          : entries.map((entry) => renderEntry(db, period, day, entry, change)))),
      renderAddStaff(db, period, day, entries, change),
      renderAddGuest(db, period, day, change),
      el('div', { class: 'actions' },
        el('button', { class: 'btn btn--quiet', type: 'button', text: '閉じる', onclick: () => close() }))),
    onClose: () => ctx.refresh(),
  });
}

type Change = (update: (db: Database) => Database, message: string) => void;

function renderEntry(
  db: Database,
  period: string,
  day: number,
  entry: AttendanceEntry,
  change: Change,
): HTMLElement {
  const status = entry.status === 'guest' ? entry.role : STATUS_LABELS[entry.status];
  const tone = entry.status === 'absent' ? 'pill pill--blocked'
    : entry.status === 'planned' ? 'pill' : 'pill pill--caution';

  const controls: HTMLElement[] = [];
  if (entry.status === 'guest') {
    controls.push(el('button', {
      class: 'btn btn--danger btn--small',
      type: 'button',
      text: '外す',
      onclick: () => change((current) => ({
        ...current,
        guests: current.guests.filter((g) =>
          !(g.period === period && g.day === day && guestStaffId(g.name) === entry.staffId)),
      }), `${entry.name} を外しました。`),
    }));
  } else if (entry.status === 'absent') {
    controls.push(el('button', {
      class: 'btn btn--quiet btn--small',
      type: 'button',
      text: '予定どおりに戻す',
      onclick: () => change((current) => setRosterChange(current, period, day, entry.staffId, null),
        `${entry.name} を予定どおりに戻しました。`),
    }));
  } else {
    const planned = plannedCodeOf(db, period, day, entry.staffId);
    const select = codeSelect(db, entry.code, `${entry.name} の当日の区分`);
    select.addEventListener('change', () => {
      const code = select.value;
      change((current) => setRosterChange(current, period, day, entry.staffId, code === planned ? null : code),
        `${entry.name} の区分を変えました。`);
    });
    controls.push(select, el('button', {
      class: 'btn btn--danger btn--small',
      type: 'button',
      text: entry.status === 'added' ? '外す' : '当日いない',
      onclick: () => change(
        (current) => setRosterChange(current, period, day, entry.staffId, entry.status === 'added' ? null : ''),
        `${entry.name} を当日の配置から外しました。`),
    }));
  }

  return el('div', { class: `row roster-row roster-row--${attendanceGroup(entry)}` },
    el('div', { class: 'row__main' },
      el('span', { class: 'row__title', text: entry.name }),
      el('span', { class: 'row__note', text: describeShift(entry) })),
    el('span', { class: tone, text: status }),
    el('div', { class: 'roster-row__controls' }, ...controls));
}

/** 予定にない人（または予定が休みの人）を足す。 */
function renderAddStaff(
  db: Database,
  period: string,
  day: number,
  entries: readonly AttendanceEntry[],
  change: Change,
): HTMLElement | null {
  const listed = new Set(entries.map((e) => e.staffId));
  const others = db.staff.filter((s) => s.active && !listed.has(s.staffId));
  if (others.length === 0) return null;

  const person = el('select', { 'aria-label': '足す職員' },
    ...others.map((s) => el('option', { value: s.staffId, text: s.displayName ? `${s.displayName}（${s.name}）` : s.name })));
  const code = codeSelect(db, defaultWorkCode(db, period, attendingFor(db)), '足す人の当日の区分');

  return el('div', { class: 'card', style: 'margin-top:var(--step-4)' },
    el('div', { class: 'card__title', text: '予定にない職員を足す' }),
    el('div', { class: 'roster-add' }, person, code,
      el('button', {
        class: 'btn btn--primary btn--small',
        type: 'button',
        text: '足す',
        onclick: () => {
          const name = others.find((s) => s.staffId === person.value)?.name ?? '';
          change((current) => setRosterChange(current, period, day, person.value, code.value),
            `${name} を足しました。`);
        },
      })));
}

/** OJT・応援の人を足す。名簿には入れず、その日の配置にだけ載せる。 */
function renderAddGuest(db: Database, period: string, day: number, change: Change): HTMLElement {
  const name = el('input', {
    type: 'text', maxlength: String(MAX_GUEST_NAME), placeholder: '例）研修 太郎', 'aria-label': '名前',
  });
  const role = el('select', { 'aria-label': '種別' },
    ...GUEST_ROLES.map((r) => el('option', { value: r, text: r })));
  const jobs = jobOptions(db);
  const job = el('select', { 'aria-label': '職種' },
    ...jobs.map((j) => el('option', { value: j, text: j })));
  const code = codeSelect(db, defaultWorkCode(db, period, attendingFor(db)), 'OJT・応援の人の当日の区分');

  return el('div', { class: 'card', style: 'margin-top:var(--step-4)' },
    el('div', { class: 'card__title', text: 'OJT・応援の人を足す' }),
    el('p', { class: 'field__hint',
      text: '名簿とは別に、この日だけ載せます。職種で担当できる業務が決まり、ほかの人と同じように割り振ります。' }),
    el('div', { class: 'roster-add' }, name, role, job, code,
      el('button', {
        class: 'btn btn--primary btn--small',
        type: 'button',
        text: '足す',
        onclick: () => {
          const trimmed = name.value.trim().slice(0, MAX_GUEST_NAME);
          if (!trimmed) {
            toast('名前を入れてください。', 'blocked');
            return;
          }
          change((current) => {
            const exists = current.guests.some((g) =>
              g.period === period && g.day === day && guestStaffId(g.name) === guestStaffId(trimmed));
            if (exists) return current;
            return {
              ...current,
              guests: [...current.guests, {
                guestId: newId('guest'),
                period,
                day,
                name: trimmed,
                role: role.value as GuestRole,
                job: job.value,
                code: code.value,
              }],
            };
          }, `${trimmed} を足しました。`);
        },
      })));
}
