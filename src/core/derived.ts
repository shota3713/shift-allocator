/**
 * ほかの結果から決まる業務の担当を起こす。
 *
 * 朝の連絡帳（その日の連絡帳係）・洗面（朝にいて何も持たない人全員）・
 * 夕方清掃（決まった人）は、公平さで選ぶものではない。割り振りの計算に乗せると
 * 「公平にするために別の人へ回す」ことが起きるので、計算の外で決める。
 *
 * 保存はしない。手修正で連絡帳係を替えたら朝の連絡帳もついて来るように、
 * 表を出すたびに割り振りの結果から起こし直す。
 */

import { taskAppliesTo } from './assign';
import { presentStaff, weekdayOf } from './plan';
import type { Plan, Task } from './types';

export interface SeatAssignment {
  readonly day: number;
  readonly taskId: string;
  readonly index: number;
  readonly staffId: string;
}

function businessDays(plan: Plan): number[] {
  return [...plan.workingByDay.keys()].sort((a, b) => a - b);
}

function followSeats(task: Task, day: number, assignments: readonly SeatAssignment[], plan: Plan): string[] {
  const source = task.derive.slice('follow:'.length);
  if (!plan.tasksById.has(source)) return [];
  const first = assignments
    .filter((a) => a.day === day && a.taskId === source)
    .sort((a, b) => a.index - b.index)[0];
  return [first?.staffId ?? ''];
}

/**
 * 決まった人が来ている日だけ枠を出す。清掃だけの勤務（現場ではない）でも来ていれば入る。
 * 担当が未設定なら空きの枠を出して、設定を促す。
 */
function fixedSeats(task: Task, day: number, plan: Plan): string[] {
  if (!task.fixedStaffId) return [''];
  const here = (plan.attendance.get(day) ?? [])
    .some((e) => e.staffId === task.fixedStaffId && e.status !== 'absent');
  return here ? [task.fixedStaffId] : [];
}

function restSeats(
  task: Task,
  day: number,
  taken: readonly SeatAssignment[],
  plan: Plan,
): string[] {
  const busy = new Set(taken
    .filter((a) => a.day === day && a.staffId && plan.tasksById.get(a.taskId)?.slot === task.slot)
    .map((a) => a.staffId));
  return presentStaff(plan.workingByDay.get(day) ?? [], day, task.slot, plan.presence)
    .filter((staffId) => !busy.has(staffId));
}

export function deriveAssignments(plan: Plan, assignments: readonly SeatAssignment[]): SeatAssignment[] {
  const derived: SeatAssignment[] = [];
  const push = (day: number, taskId: string, staffIds: readonly string[]): void => {
    staffIds.forEach((staffId, index) => derived.push({ day, taskId, index, staffId }));
  };

  // 「残り全員」は、ほかの決まり方の人が出そろってから数える。
  const rest = plan.derivedTasks.filter((t) => t.derive === 'rest');
  const others = plan.derivedTasks.filter((t) => t.derive !== 'rest');

  for (const day of businessDays(plan)) {
    const weekday = weekdayOf(plan.year, plan.month, day);
    for (const task of others) {
      if (!taskAppliesTo(task.appliesTo, weekday)) continue;
      if (task.derive === 'fixed') push(day, task.taskId, fixedSeats(task, day, plan));
      else push(day, task.taskId, followSeats(task, day, assignments, plan));
    }
    for (const task of rest) {
      if (!taskAppliesTo(task.appliesTo, weekday)) continue;
      push(day, task.taskId, restSeats(task, day, [...assignments, ...derived], plan));
    }
  }
  return derived;
}
