/**
 * 保存データから振り分けの前提（Plan）を組む。
 *
 * ここが保存層と計算をつなぐ唯一の場所。assign.ts / feasibility.ts は
 * Plan しか知らないので、保存の形を変えてもアルゴリズムは動き続ける。
 */

import { isEligible, taskAppliesTo } from './assign';
import {
  SLOT,
  WEEKDAY_KEYS,
  type LearnedRule,
  type Plan,
  type SlotRequest,
  type Task,
  type WeekdayKey,
} from './types';
import type { Database } from '../store/db';

export function weekdayOf(year: number, month: number, day: number): WeekdayKey {
  return WEEKDAY_KEYS[new Date(year, month - 1, day).getDay()] as WeekdayKey;
}

function activeRules(db: Database): LearnedRule[] {
  return db.rules.filter((r) => r.enabled && r.ruleId);
}

/**
 * 対象月の Plan を組む。
 *
 * 枠は「担当できる人が少ない順」に並べる。緩い枠を先に埋めると、
 * 厳しい枠に入れる人が残らなくなる（看護師枠が埋まらない等）。
 */
export function buildPlan(db: Database, periodKey: string): Plan {
  const [yearText, monthText] = periodKey.split('-');
  const year = Number(yearText);
  const month = Number(monthText);

  const workingCodes = new Set(db.shiftTypes.filter((t) => t.isWorking).map((t) => t.code));

  const workingByStaff = new Map<string, Set<number>>();
  const workingByDay = new Map<number, string[]>();
  for (const c of db.confirmed) {
    if (c.period !== periodKey) continue;
    if (!workingCodes.has(c.code)) continue;
    const days = workingByStaff.get(c.staffId);
    if (days) days.add(c.day);
    else workingByStaff.set(c.staffId, new Set([c.day]));
    const staffOnDay = workingByDay.get(c.day);
    if (staffOnDay) staffOnDay.push(c.staffId);
    else workingByDay.set(c.day, [c.staffId]);
  }
  for (const list of workingByDay.values()) list.sort();

  const staffJob = new Map<string, string>();
  const staffNames = new Map<string, string>();
  for (const s of db.staff) {
    staffJob.set(s.staffId, s.job);
    staffNames.set(s.staffId, s.name);
  }

  const tasks: Task[] = db.tasks
    .filter((t) => t.active && t.taskId)
    .map((t) => ({
      ...t,
      slot: (String(t.slot).toUpperCase() as Task['slot']) || SLOT.AM,
      weight: Number(t.weight) || 1,
      headcount: Math.max(1, Number(t.headcount) || 1),
    }));
  const tasksById = new Map(tasks.map((t) => [t.taskId, t]));
  const staffIds = [...workingByStaff.keys()].sort();

  // 「担当できる人が何人いるか」を制約の強さの尺度にする。
  // 職種指定の有無だけで判断すると、看護師枠（4人）と介助業務（11人）が
  // 同列に扱われ、看護職員が先に介助へ取られて看護師枠が埋まらなくなる。
  const eligibleCount = new Map<string, number>();
  for (const task of tasks) {
    eligibleCount.set(task.taskId, staffIds.filter((id) => isEligible(id, task, staffJob)).length);
  }

  const slots: SlotRequest[] = [];
  for (const day of [...workingByDay.keys()].sort((a, b) => a - b)) {
    const weekday = weekdayOf(year, month, day);
    for (const task of tasks) {
      if (!taskAppliesTo(task.appliesTo, weekday)) continue;
      for (let i = 0; i < task.headcount; i += 1) {
        slots.push({ day, weekday, taskId: task.taskId, slot: task.slot, index: i, weight: task.weight });
      }
    }
  }

  slots.sort((a, b) => {
    const ca = eligibleCount.get(a.taskId) ?? 0;
    const cb = eligibleCount.get(b.taskId) ?? 0;
    if (ca !== cb) return ca - cb;
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (a.day !== b.day) return a.day - b.day;
    if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;
    return a.index - b.index;
  });

  return {
    periodKey,
    year,
    month,
    slots,
    tasks,
    tasksById,
    workingByStaff,
    workingByDay,
    staffIds,
    staffJob,
    staffNames,
    rules: activeRules(db),
  };
}
