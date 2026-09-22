/**
 * 振り分けエンジン。
 *
 * ハード制約は「破れないこと」を、ソフト制約は「偏りが小さくなること」を試す。
 * 決定論は学習の効果を比べるための前提なので、ここで固定しておく。
 */

import { describe, expect, it } from 'vitest';
import { canAssign, isEligible, runAssignment, taskAppliesTo, totalCost } from '../src/core/assign';
import { buildStats } from '../src/core/stats';
import { DEFAULT_SEED, DEFAULT_SETTINGS, SLOT } from '../src/core/types';
import { planFor, staff, task } from './helpers';

const DAYS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const CARE_TEAM = [
  staff('a', '相川', '介護職員'),
  staff('b', '井上', '介護職員'),
  staff('c', '上田', '介護職員'),
  staff('d', '江藤', '看護職員'),
];

const TASKS = [
  task({ taskId: 'BATH', name: '入浴担当', slot: SLOT.AM, headcount: 2, eligibleJob: ['介護職員'] }),
  task({ taskId: 'NURSE', name: '看護師', slot: SLOT.AM, eligibleJob: ['看護職員'] }),
  task({ taskId: 'REC', name: 'レクリーダー', slot: SLOT.PM, weight: 2, eligibleJob: ['介護職員'] }),
];

const basePlan = () => planFor({ period: '2026-09', staff: CARE_TEAM, tasks: TASKS, days: DAYS });

describe('担当可否', () => {
  it('職種が合わなければ担当できない', () => {
    const plan = basePlan();
    expect(isEligible('d', plan.tasksById.get('BATH'), plan)).toBe(false);
    expect(isEligible('a', plan.tasksById.get('BATH'), plan)).toBe(true);
  });

  it('個人の設定があるときは職種より優先される', () => {
    const plan = planFor({
      period: '2026-09',
      staff: CARE_TEAM,
      tasks: [task({ taskId: 'RENRAKU', name: '連絡帳' })],
      days: DAYS,
      skills: [
        { staffId: 'a', taskIds: [] },
        { staffId: 'b', taskIds: ['RENRAKU'] },
      ],
    });
    expect(isEligible('b', plan.tasksById.get('RENRAKU'), plan)).toBe(true);
    expect(isEligible('a', plan.tasksById.get('RENRAKU'), plan)).toBe(false);
  });

  it('出勤していない日には割り当てられない', () => {
    const plan = planFor({
      period: '2026-09',
      staff: CARE_TEAM,
      tasks: TASKS,
      days: DAYS,
      off: { a: [3] },
    });
    expect(canAssign('a', { day: 3, taskId: 'BATH' }, [], plan, -1)).toBe(false);
    expect(canAssign('a', { day: 4, taskId: 'BATH' }, [], plan, -1)).toBe(true);
  });
});

describe('曜日ごとの適用', () => {
  it('平日指定は土日に発生しない', () => {
    expect(taskAppliesTo('weekday', 'mon')).toBe(true);
    expect(taskAppliesTo('weekday', 'sat')).toBe(false);
  });

  it('曜日を並べた指定はその曜日だけ', () => {
    expect(taskAppliesTo('mon,wed', 'wed')).toBe(true);
    expect(taskAppliesTo('mon,wed', 'thu')).toBe(false);
  });

  it('未指定は毎日', () => {
    expect(taskAppliesTo('all', 'sun')).toBe(true);
    expect(taskAppliesTo('', 'sun')).toBe(true);
  });
});

describe('振り分けの結果', () => {
  const plan = basePlan();
  const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);

  it('すべての枠を埋める', () => {
    expect(result.assignments.length).toBe(plan.slots.length);
    expect(result.assignments.filter((a) => !a.staffId)).toEqual([]);
  });

  it('同じ時間帯に同じ人を二重に入れない', () => {
    const seen = new Set<string>();
    for (const a of result.assignments) {
      const slot = plan.tasksById.get(a.taskId)?.slot;
      const key = `${a.day}#${slot}#${a.staffId}`;
      expect(seen.has(key), `${key} が重複`).toBe(false);
      seen.add(key);
    }
  });

  it('出勤日以外には割り当てない', () => {
    for (const a of result.assignments) {
      expect(plan.workingByStaff.get(a.staffId)?.has(a.day), `${a.staffId} ${a.day}日`).toBe(true);
    }
  });

  it('職種の合わない人を入れない', () => {
    for (const a of result.assignments) {
      expect(isEligible(a.staffId, plan.tasksById.get(a.taskId), plan)).toBe(true);
    }
  });

  it('同じ入力・同じ seed なら毎回同じ結果になる', () => {
    const again = runAssignment(basePlan(), DEFAULT_SETTINGS, DEFAULT_SEED);
    expect(again.assignments).toEqual(result.assignments);
    expect(again.cost).toBe(result.cost);
  });

  it('seed が違えば別の解を探す', () => {
    const other = runAssignment(basePlan(), DEFAULT_SETTINGS, DEFAULT_SEED + 1);
    expect(other.assignments).not.toEqual(result.assignments);
  });

  it('負担を出勤1日あたりで均す', () => {
    const stats = buildStats(result.assignments, plan);
    const carePool = stats.pools.find((p) => p.label.includes('入浴担当'));
    expect(carePool).toBeDefined();
    // 介護職3人・入浴2枠・レク1枠を10日ぶん。完全な均等は割り切れないが、
    // 1日あたりの差は1業務ぶんより小さくなる。
    expect(carePool!.spread).toBeLessThan(0.5);
  });

  it('レクリーダーの回数も人によって偏らない', () => {
    const counts = new Map<string, number>();
    for (const a of result.assignments) {
      if (a.taskId !== 'REC') continue;
      counts.set(a.staffId, (counts.get(a.staffId) ?? 0) + 1);
    }
    const values = [...counts.values()];
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
  });
});

describe('兼任の禁止', () => {
  it('同じ日に同じ排他グループの業務を兼任しない', () => {
    const plan = planFor({
      period: '2026-09',
      staff: CARE_TEAM,
      tasks: [
        task({ taskId: 'BATH_LEAD', name: '入浴リーダー', slot: SLOT.AM, exclusiveGroup: 'LEAD', eligibleJob: ['介護職員'] }),
        task({ taskId: 'REC_LEAD', name: 'レクリーダー', slot: SLOT.PM, exclusiveGroup: 'LEAD', eligibleJob: ['介護職員'] }),
      ],
      days: DAYS,
    });
    const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);

    const byDay = new Map<number, string[]>();
    for (const a of result.assignments) {
      const bucket = byDay.get(a.day) ?? [];
      bucket.push(a.staffId);
      byDay.set(a.day, bucket);
    }
    for (const [day, staffIds] of byDay) {
      expect(new Set(staffIds).size, `${day}日にリーダー兼任`).toBe(staffIds.length);
    }
  });
});

describe('コスト', () => {
  it('埋まらない枠があると強く罰する', () => {
    const plan = basePlan();
    const filled = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);
    const withHole = filled.assignments.map((a, i) => (i === 0 ? { ...a, staffId: '' } : a));
    expect(totalCost(withHole, plan, DEFAULT_SETTINGS))
      .toBeGreaterThan(totalCost(filled.assignments, plan, DEFAULT_SETTINGS) + 900);
  });
});
