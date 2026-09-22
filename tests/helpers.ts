/**
 * テスト用のデータ組み立て。
 * 本物の保存層を通さずに Plan を作れるようにして、計算だけを試せるようにする。
 */

import { buildPlan } from '../src/core/plan';
import { emptyDatabase, type ConfirmedShift, type Database } from '../src/store/db';
import { PRESENCE } from '../src/core/shiftCode';
import { SLOT, type ShiftType, type Staff, type Task } from '../src/core/types';

export const WORK: ShiftType = {
  code: '日勤', label: '日勤', isWorking: true, hours: 8, aliases: [],
  am: PRESENCE.WORK, pm: PRESENCE.WORK,
};
export const OFF: ShiftType = {
  code: 'OFF', label: '休み', isWorking: false, hours: 0, aliases: ['休', ''],
  am: PRESENCE.OFF, pm: PRESENCE.OFF,
};
/** 午前だけ現場、午後はフリー。半日の扱いを試すために使う。 */
export const AM_ONLY: ShiftType = {
  code: '日/F', label: '日/F', isWorking: true, hours: 4, aliases: [],
  am: PRESENCE.WORK, pm: PRESENCE.FREE,
};
/** 1日フリー。出勤の行に並ぶが業務は載らない。 */
export const FREE: ShiftType = {
  code: 'F', label: 'F', isWorking: true, hours: 8, aliases: [],
  am: PRESENCE.FREE, pm: PRESENCE.FREE,
};

export function staff(staffId: string, name: string, job: string): Staff {
  return { staffId, name, job, active: true, note: '' };
}

export function task(overrides: Partial<Task> & { taskId: string; name: string }): Task {
  return {
    slot: SLOT.AM,
    difficulty: 2,
    headcount: 1,
    minHeadcount: 1,
    allowSameSlot: false,
    avoidWith: [],
    eligibleJob: [],
    preferOrder: [],
    exclusiveGroup: '',
    appliesTo: 'all',
    active: true,
    note: '',
    ...overrides,
  };
}

/** 全員が指定の日すべてに出勤する、単純な月を作る。 */
export function databaseWith(options: {
  period: string;
  staff: readonly Staff[];
  tasks: readonly Task[];
  days: readonly number[];
  /** 出勤しない日を staffId ごとに指定する。 */
  off?: Readonly<Record<string, readonly number[]>>;
  /** 既定の日勤ではない勤務区分を staffId ごとに指定する。 */
  codes?: Readonly<Record<string, Readonly<Record<number, string>>>>;
  /** 誰が何を担当できるか。省略すると職種から判断する。 */
  skills?: readonly { staffId: string; taskIds: readonly string[] }[];
}): Database {
  const confirmed: ConfirmedShift[] = [];
  for (const person of options.staff) {
    const offDays = new Set(options.off?.[person.staffId] ?? []);
    const custom = options.codes?.[person.staffId] ?? {};
    for (const day of options.days) {
      confirmed.push({
        period: options.period,
        staffId: person.staffId,
        day,
        code: custom[day] ?? (offDays.has(day) ? OFF.code : WORK.code),
      });
    }
  }
  return {
    ...emptyDatabase(),
    staff: [...options.staff],
    tasks: [...options.tasks],
    shiftTypes: [WORK, OFF, AM_ONLY, FREE],
    skills: options.skills ? [...options.skills] : [],
    confirmed,
  };
}

export function planFor(options: Parameters<typeof databaseWith>[0]) {
  return buildPlan(databaseWith(options), options.period);
}
