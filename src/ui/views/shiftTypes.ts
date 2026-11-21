/**
 * 勤務区分の設定。
 *
 * コードには「日/F」のように半日を区切る形があり、フリーの半日には業務を
 * 載せられない。読み解いた結果をそのまま信用させるのではなく、ここで人が
 * 確認できるようにしておく。清掃専任やフリーの扱いはここで決まる。
 */

import type { Ctx } from '../app';
import { el, toast } from '../dom';
import {
  PRESENCE,
  PRESENCE_PRESETS,
  presetOf,
  presetPresence,
  readShiftCode,
  shiftCodeBase,
} from '../../core/shiftCode';
import type { ShiftType } from '../../core/types';

export function renderShiftTypes(root: HTMLElement, ctx: Ctx): void {
  const db = ctx.db;

  root.append(el('h2', { class: 'section-title', text: '勤務区分' }));

  if (db.shiftTypes.length === 0) {
    root.append(el('div', { class: 'card' },
      el('p', { class: 'card__body', text: '勤務表を取り込むと、出てきたコードがここに並びます。' })));
    return;
  }

  const sorted = [...db.shiftTypes].sort((a, b) => (shiftCodeBase(a.code) < shiftCodeBase(b.code) ? -1 : 1));

  root.append(
    el('p', { class: 'card__body', style: 'margin-bottom:var(--step-3)',
      text: 'フリーの半日には業務を割り振りません。「日/F」は午前だけ現場、「F」は1日フリーです。'
        + '末尾が SS の区分はショートステイへのヘルプで、デイの割り振りには入れません。'
        + '始業の時刻を入れると、表の「出勤」の欄に出ます。' }),
    el('div', { class: 'rows' }, ...sorted.map((type) => renderRow(type, ctx))),
  );
}

function renderRow(type: ShiftType, ctx: Ctx): HTMLElement {
  const parsed = readShiftCode(type.code);
  const preset = presetOf(type.am, type.pm);
  const idle = type.am !== PRESENCE.WORK && type.pm !== PRESENCE.WORK;

  const select = el('select', {
    'aria-label': `${type.code} の勤務`,
    onchange: (event: Event) => {
      const next = presetPresence((event.currentTarget as HTMLSelectElement).value);
      ctx.update((db) => ({
        ...db,
        shiftTypes: db.shiftTypes.map((t) => t.code === type.code
          ? {
              ...t,
              am: next.am,
              pm: next.pm,
              isWorking: next.am === PRESENCE.WORK || next.pm === PRESENCE.WORK,
            }
          : t),
      }));
      toast(`${type.code} を変更しました。`);
    },
  }, ...PRESENCE_PRESETS.map((option) =>
    el('option', { value: option.value, text: option.label, selected: option.value === preset })));

  const start = el('input', {
    type: 'time',
    class: 'shift-start',
    value: toTimeValue(type.startTime ?? ''),
    'aria-label': `${type.code} の始業時刻`,
    onchange: (event: Event) => {
      const value = fromTimeValue((event.currentTarget as HTMLInputElement).value);
      ctx.update((db) => ({
        ...db,
        shiftTypes: db.shiftTypes.map((t) => (t.code === type.code ? { ...t, startTime: value } : t)),
      }));
      toast(value ? `${shiftCodeBase(type.code)} は ${value} からにしました。` : '始業時刻を消しました。');
    },
  });

  // SS の区分は設定に関わらずデイには入れない（plan.ts）。選べるように見せない。
  const ssHelp = parsed.kind === 'SS_HELP';

  return el('div', { class: idle || ssHelp ? 'row row--3' : 'row row--3 row--active' },
    el('div', { class: 'row__main' },
      el('span', { class: 'row__title', text: shiftCodeBase(type.code) || type.code }),
      el('span', { class: 'row__note', text: parsed.assumed ? '形が読めないので確認してください' : parsed.label })),
    start,
    ssHelp ? el('span', { class: 'pill attend-chip--SS_HELP', text: 'SSヘルプ' }) : select);
}

/** '7:30' → '07:30'。input[type=time] は2桁の時を求める。 */
function toTimeValue(text: string): string {
  const matched = /^(\d{1,2}):(\d{2})$/u.exec(text.trim());
  return matched ? `${(matched[1] as string).padStart(2, '0')}:${matched[2] as string}` : '';
}

/** '07:30' → '7:30'。表では先頭の0を落として短くする。 */
function fromTimeValue(value: string): string {
  const matched = /^(\d{2}):(\d{2})$/u.exec(value);
  return matched ? `${Number(matched[1])}:${matched[2] as string}` : '';
}
