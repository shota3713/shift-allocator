/**
 * 公平性を人が目で確認できる形にする。
 *
 * 負担は必ず「出勤1日あたり」で見せる。合計だけを並べると、出勤日数の多い人が
 * 常に上位に来るだけで、公平かどうかが判断できない。
 *
 * さらに、担当できる業務が違う人（看護職員と介助職など）を1つの数字で比べても
 * 意味がないので、担当できる業務の顔ぶれごとにプールを分けて集計する。
 */

import { isEligible } from './assign';
import type { Assignment, Plan } from './types';

export interface StaffStat {
  readonly staffId: string;
  readonly staffName: string;
  readonly workdays: number;
  readonly total: number;
  readonly weighted: number;
  readonly perDay: number;
  readonly byTask: ReadonlyMap<string, number>;
}

export interface Pool {
  readonly label: string;
  readonly memberCount: number;
  /** プール内の「1日あたり負担」の最大差。小さいほど公平。 */
  readonly spread: number;
  readonly staffIds: readonly string[];
}

export interface Stats {
  readonly perStaff: readonly StaffStat[];
  readonly pools: readonly Pool[];
  readonly unfilled: number;
}

export function buildStats(assignments: readonly Assignment[], plan: Plan): Stats {
  // 「担当できる業務」の組み合わせでプールを決める。
  // 「実際に担当した業務」で括ると、たまたま当たらなかった人が単独プールに
  // 切り出されてしまい、比較の意味がなくなる。
  const eligibilityKey = new Map<string, string>();
  for (const id of plan.staffIds) {
    eligibilityKey.set(
      id,
      plan.tasks
        .filter((t) => isEligible(id, t, plan.staffJob))
        .map((t) => t.taskId)
        .sort()
        .join('+'),
    );
  }

  interface Acc {
    total: number;
    weighted: number;
    byTask: Map<string, number>;
  }
  const byStaff = new Map<string, Acc>();
  for (const id of plan.staffIds) byStaff.set(id, { total: 0, weighted: 0, byTask: new Map() });

  for (const a of assignments) {
    if (!a.staffId) continue;
    const entry = byStaff.get(a.staffId);
    if (!entry) continue;
    entry.total += 1;
    entry.weighted += plan.tasksById.get(a.taskId)?.weight ?? 1;
    entry.byTask.set(a.taskId, (entry.byTask.get(a.taskId) ?? 0) + 1);
  }

  const perStaff: StaffStat[] = [...byStaff.entries()]
    .map(([staffId, acc]) => {
      const workdays = plan.workingByStaff.get(staffId)?.size ?? 0;
      return {
        staffId,
        staffName: plan.staffNames.get(staffId) ?? staffId,
        workdays,
        total: acc.total,
        weighted: acc.weighted,
        perDay: Math.round((acc.weighted / (workdays || 1)) * 1000) / 1000,
        byTask: acc.byTask,
      };
    })
    .sort((a, b) => b.perDay - a.perDay);

  const grouped = new Map<string, StaffStat[]>();
  for (const s of perStaff) {
    const key = eligibilityKey.get(s.staffId) ?? '';
    const bucket = grouped.get(key);
    if (bucket) bucket.push(s);
    else grouped.set(key, [s]);
  }

  const taskName = (id: string): string => plan.tasksById.get(id)?.name ?? id;
  const pools: Pool[] = [...grouped.entries()]
    .map(([key, members]) => {
      const rates = members.map((m) => m.perDay);
      return {
        label: key === '' ? '担当できる業務なし' : key.split('+').map(taskName).join('・'),
        memberCount: members.length,
        spread: Math.round((Math.max(...rates) - Math.min(...rates)) * 1000) / 1000,
        staffIds: members.map((m) => m.staffId),
      };
    })
    .sort((a, b) => b.memberCount - a.memberCount);

  return {
    perStaff,
    pools,
    unfilled: assignments.filter((a) => !a.staffId).length,
  };
}
