/**
 * 保存してある割り振りの結果が、いまの設定と合っているか。
 *
 * 結果は実行したときの写し。あとから業務を足したり当日の配置を変えたりしても、
 * この結果には入らない。黙っていると「足したのに割り振られない」と見えるので、
 * ずれを名指しで出す（割り振りの画面と週ごとの表の両方で使う）。
 */

import { isSpareSeat, type Plan } from './types';

export interface StaleReport {
  /** いまの設定では枠があるのに、結果に入っていない業務の名前。 */
  readonly missing: readonly string[];
  /** 結果にあるが、いまは割り振らない業務の名前。 */
  readonly extra: readonly string[];
  /** 当日の配置にいない人に残っている割り当て（「3日 名前」の形）。 */
  readonly away: readonly string[];
}

interface SavedSeat {
  readonly day: number;
  readonly taskId: string;
  readonly index: number;
  readonly staffId: string;
}

export function isStale(report: StaleReport): boolean {
  return report.missing.length > 0 || report.extra.length > 0 || report.away.length > 0;
}

export function staleRun(plan: Plan, run: { readonly assignments: readonly SavedSeat[] }): StaleReport {
  const key = (a: { day: number; taskId: string; index: number }): string => `${a.day}#${a.taskId}#${a.index}`;
  const planned = new Set(plan.slots.map(key));
  const inRun = new Set(run.assignments.map(key));
  const tasksInRun = new Set(run.assignments.map((a) => a.taskId));
  const nameOf = (id: string): string => plan.tasksById.get(id)?.name ?? id;

  // 最低人数を超える枠（手作業の2人目・フリー）は、埋まらなければ結果に残さない。
  // 枠ごとには比べず、その業務が結果にひとつも無いときだけ「入っていない」とする。
  const spare = (slot: { taskId: string; index: number }): boolean =>
    isSpareSeat(plan.tasksById.get(slot.taskId), slot.index);
  const missing = [...new Set(plan.slots
    .filter((s) => (spare(s) ? !tasksInRun.has(s.taskId) : !inRun.has(key(s))))
    .map((s) => s.taskId))];
  const extra = [...new Set(run.assignments.filter((a) => !planned.has(key(a))).map((a) => a.taskId))];
  const away = [...new Set(run.assignments
    .filter((a) => a.staffId && !(plan.workingByDay.get(a.day) ?? []).includes(a.staffId))
    .map((a) => `${a.day}日 ${plan.staffNames.get(a.staffId) ?? a.staffId}`))];
  return { missing: missing.map(nameOf), extra: extra.map(nameOf), away };
}
