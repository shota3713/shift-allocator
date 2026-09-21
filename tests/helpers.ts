/**
 * テスト用のデータ組み立て。
 * 本物の保存層を通さずに Plan を作れるようにして、計算だけを試せるようにする。
 */

import { buildPlan } from '../src/core/plan';
import { emptyDatabase, type ConfirmedShift, type Database } from '../src/store/db';
import { SLOT, type ShiftType, type Staff, type Task } from '../src/core/types';

export const WORK: ShiftType = {
  code: '日勤', label: '日勤', isWorking: true, hours: 8, aliases: [],
};
export const OFF: ShiftType = {
  code: 'OFF', label: '休み', isWorking: false, hours: 0, aliases: ['休', ''],
};

export function staff(staffId: string, name: string, job: string): Staff {
  return { staffId, name, job, active: true, note: '' };
}

export function task(overrides: Partial<Task> & { taskId: string; name: string }): Task {
  return {
    slot: SLOT.AM,
    weight: 1,
    headcount: 1,
    eligibleJob: [],
    eligibleStaff: [],
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
}): Database {
  const confirmed: ConfirmedShift[] = [];
  for (const person of options.staff) {
    const offDays = new Set(options.off?.[person.staffId] ?? []);
    for (const day of options.days) {
      confirmed.push({
        period: options.period,
        staffId: person.staffId,
        day,
        code: offDays.has(day) ? OFF.code : WORK.code,
      });
    }
  }
  return {
    ...emptyDatabase(),
    staff: [...options.staff],
    tasks: [...options.tasks],
    shiftTypes: [WORK, OFF],
    confirmed,
  };
}

export function planFor(options: Parameters<typeof databaseWith>[0]) {
  return buildPlan(databaseWith(options), options.period);
}
