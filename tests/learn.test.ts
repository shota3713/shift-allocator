/**
 * 手修正と学習。
 * 「修正しただけではルールにならない」「承認するとだんだん強くなる」を確かめる。
 */

import { describe, expect, it } from 'vitest';
import {
  applyLearning,
  buildLearningProposals,
  candidatesForSlot,
  describeRules,
  recordCorrection,
} from '../src/core/learn';
import { runAssignment } from '../src/core/assign';
import { buildPlan } from '../src/core/plan';
import { DEFAULT_SEED, DEFAULT_SETTINGS, RULE_TYPE, SLOT } from '../src/core/types';
import { databaseWith, staff, task } from './helpers';
import { nowIso, type Database, type Run } from '../src/store/db';

const STAFF = [
  staff('a', '相川', '介護職員'),
  staff('b', '井上', '介護職員'),
  staff('c', '上田', '介護職員'),
];
const TASKS = [
  task({ taskId: 'REC', name: 'レクリーダー', slot: SLOT.PM, difficulty: 4, eligibleJob: ['介護職員'] }),
  task({ taskId: 'BATH', name: '入浴担当', slot: SLOT.AM, eligibleJob: ['介護職員'] }),
];
const DAYS = [1, 2, 3, 4, 5];

function seeded(): { db: Database; run: Run } {
  const base = databaseWith({ period: '2026-09', staff: STAFF, tasks: TASKS, days: DAYS });
  const plan = buildPlan(base, '2026-09');
  const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);
  const run: Run = {
    runId: 'run_1',
    period: '2026-09',
    createdAt: nowIso(),
    seed: DEFAULT_SEED,
    cost: result.cost,
    assignments: result.assignments.map((a) => ({
      day: a.day,
      taskId: a.taskId,
      index: a.index,
      staffId: a.staffId,
      origin: 'auto' as const,
    })),
  };
  return { db: { ...base, runs: [run] }, run };
}

describe('交代できる人', () => {
  it('同じ時間帯に別の業務を持っている人は、入れられない印が付く', () => {
    const base = databaseWith({ period: '2026-09', staff: STAFF, tasks: TASKS, days: DAYS });
    const plan = buildPlan(base, '2026-09');
    const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);
    const target = result.assignments.find((a) => a.taskId === 'REC' && a.day === 1)!;

    const candidates = candidatesForSlot(result.assignments, plan, { day: 1, taskId: 'REC', index: 0 });
    const ids = candidates.map((c) => c.staffId);
    expect(ids).toContain(target.staffId);
    expect(new Set(ids).size).toBe(ids.length);
    // 今入っている人はそのまま選べる。
    expect(candidates.find((c) => c.staffId === target.staffId)?.ok).toBe(true);
  });

  it('担当できない人も選択肢には出すが、理由を付ける', () => {
    const base = databaseWith({
      period: '2026-09',
      staff: [...STAFF, staff('n', '星野', '看護職員')],
      tasks: TASKS,
      days: DAYS,
    });
    const plan = buildPlan(base, '2026-09');
    const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);
    const candidates = candidatesForSlot(result.assignments, plan, { day: 1, taskId: 'REC', index: 0 });
    const nurse = candidates.find((c) => c.staffId === 'n');
    expect(nurse).toBeDefined();
    expect(nurse?.ok).toBe(false);
    expect(nurse?.note).toContain('担当できる人');
  });
});

describe('修正の記録', () => {
  it('修正しただけではルールにならない', () => {
    const { db, run } = seeded();
    const target = run.assignments.find((a) => a.taskId === 'REC' && a.day === 1)!;
    const other = STAFF.find((s) => s.staffId !== target.staffId)!;

    const { db: after, correction } = recordCorrection(db, {
      runId: run.runId,
      period: '2026-09',
      day: 1,
      taskId: 'REC',
      index: 0,
      staffBefore: target.staffId,
      staffAfter: other.staffId,
    });

    expect(after.rules).toEqual([]);
    expect(correction.learned).toBe(false);
    expect(after.corrections.length).toBe(1);
  });

  it('担当が入れ替わり、手修正として残る', () => {
    const { db, run } = seeded();
    const target = run.assignments.find((a) => a.taskId === 'REC' && a.day === 1)!;
    const other = STAFF.find((s) => s.staffId !== target.staffId)!;

    const { db: after } = recordCorrection(db, {
      runId: run.runId,
      period: '2026-09',
      day: 1,
      taskId: 'REC',
      index: 0,
      staffBefore: target.staffId,
      staffAfter: other.staffId,
    });

    const changed = after.runs[0]!.assignments.find((a) => a.taskId === 'REC' && a.day === 1)!;
    expect(changed.staffId).toBe(other.staffId);
    expect(changed.origin).toBe('manual');
  });

  it('同じ業務が複数人いても、直した枠だけが変わる', () => {
    // 昼担当のように1日に同じ業務の枠が並ぶ形。1人だけ入れ替えたいのに
    // 全部の枠が同じ人になってしまう不具合が実際に起きた。
    const multi = [task({ taskId: 'NOON', name: '昼担当', slot: SLOT.NOON, headcount: 2 })];
    const base = databaseWith({ period: '2026-09', staff: STAFF, tasks: multi, days: DAYS });
    const plan = buildPlan(base, '2026-09');
    const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);
    const run: Run = {
      runId: 'run_1',
      period: '2026-09',
      createdAt: nowIso(),
      seed: DEFAULT_SEED,
      cost: result.cost,
      assignments: result.assignments.map((a) => ({
        day: a.day, taskId: a.taskId, index: a.index, staffId: a.staffId, origin: 'auto' as const,
      })),
    };

    const onDay1 = run.assignments.filter((a) => a.day === 1).sort((a, b) => a.index - b.index);
    expect(onDay1.length).toBe(2);
    const [first, second] = onDay1 as [typeof onDay1[0], typeof onDay1[0]];
    const outsider = STAFF.find((s) => s.staffId !== first.staffId && s.staffId !== second.staffId)!;

    const { db: after } = recordCorrection({ ...base, runs: [run] }, {
      runId: 'run_1',
      period: '2026-09',
      day: 1,
      taskId: 'NOON',
      index: first.index,
      staffBefore: first.staffId,
      staffAfter: outsider.staffId,
    });

    const updated = after.runs[0]!.assignments
      .filter((a) => a.day === 1 && a.taskId === 'NOON')
      .sort((a, b) => a.index - b.index);
    expect(updated[0]?.staffId).toBe(outsider.staffId);
    expect(updated[1]?.staffId).toBe(second.staffId);
  });
});

describe('学習の提案', () => {
  it('外した人・入れた人それぞれの案を出す', () => {
    const { db } = seeded();
    const proposals = buildLearningProposals(db, '2026-09', 1, 'REC', 'a', 'b');
    expect(proposals.map((p) => p.type)).toEqual([
      RULE_TYPE.AVOID,
      RULE_TYPE.DAY_AVOID,
      RULE_TYPE.PREFER,
    ]);
    expect(proposals[0]?.label).toContain('相川');
    expect(proposals[0]?.label).toContain('レクリーダー');
  });

  it('同じ修正を繰り返した回数を添える', () => {
    const { db } = seeded();
    const withHistory: Database = {
      ...db,
      corrections: [
        {
          correctionId: 'c1', runId: 'run_1', period: '2026-09', day: 2, index: 0,
          taskId: 'REC', staffBefore: 'a', staffAfter: 'b', reason: '', learned: true, createdAt: nowIso(),
        },
      ],
    };
    const proposals = buildLearningProposals(withHistory, '2026-09', 1, 'REC', 'a', 'b');
    expect(proposals[0]?.evidence).toBe(1);
  });
});

describe('学習の承認', () => {
  it('承認するとルールになる', () => {
    const { db } = seeded();
    const { db: recorded, correction } = recordCorrection(db, {
      runId: 'run_1', period: '2026-09', day: 1, taskId: 'REC', index: 0, staffBefore: 'a', staffAfter: 'b',
    });
    const proposal = buildLearningProposals(recorded, '2026-09', 1, 'REC', 'a', 'b')[0]!;
    const learned = applyLearning(recorded, correction.correctionId, proposal);

    expect(learned.rules.length).toBe(1);
    expect(learned.rules[0]?.type).toBe(RULE_TYPE.AVOID);
    expect(learned.rules[0]?.weight).toBe(1);
    expect(learned.corrections[0]?.learned).toBe(true);
  });

  it('同じルールを重ねると強くなる（上限あり）', () => {
    const { db } = seeded();
    const proposal = buildLearningProposals(db, '2026-09', 1, 'REC', 'a', 'b')[0]!;
    let current = db;
    for (let i = 0; i < 10; i += 1) current = applyLearning(current, 'none', proposal);

    expect(current.rules.length).toBe(1);
    expect(current.rules[0]?.evidenceCount).toBe(10);
    expect(current.rules[0]?.weight).toBe(5);
  });

  it('ルールを人が読める文にする', () => {
    const { db } = seeded();
    const proposal = buildLearningProposals(db, '2026-09', 1, 'REC', 'a', 'b')[0]!;
    const learned = applyLearning(db, 'none', proposal);
    expect(describeRules(learned)[0]?.label).toBe('相川 は 「レクリーダー」 を避ける');
  });
});

describe('学習の効き目', () => {
  it('避けるルールを入れるとその人の担当回数が減る', () => {
    const base = databaseWith({ period: '2026-09', staff: STAFF, tasks: TASKS, days: DAYS });
    const before = runAssignment(buildPlan(base, '2026-09'), DEFAULT_SETTINGS, DEFAULT_SEED);
    const countRec = (result: typeof before, staffId: string): number =>
      result.assignments.filter((a) => a.taskId === 'REC' && a.staffId === staffId).length;

    const victim = before.assignments.find((a) => a.taskId === 'REC')!.staffId;
    const withRule: Database = {
      ...base,
      rules: [{
        ruleId: 'r1', type: RULE_TYPE.AVOID, subject: victim, object: 'REC',
        scope: '', weight: 5, evidenceCount: 5, enabled: true, updatedAt: nowIso(),
      }],
    };
    const after = runAssignment(buildPlan(withRule, '2026-09'), DEFAULT_SETTINGS, DEFAULT_SEED);

    expect(countRec(after, victim)).toBeLessThan(countRec(before, victim));
  });

  it('無効にしたルールは効かない', () => {
    const base = databaseWith({ period: '2026-09', staff: STAFF, tasks: TASKS, days: DAYS });
    const before = runAssignment(buildPlan(base, '2026-09'), DEFAULT_SETTINGS, DEFAULT_SEED);
    const disabled: Database = {
      ...base,
      rules: [{
        ruleId: 'r1', type: RULE_TYPE.AVOID, subject: 'a', object: 'REC',
        scope: '', weight: 5, evidenceCount: 5, enabled: false, updatedAt: nowIso(),
      }],
    };
    const after = runAssignment(buildPlan(disabled, '2026-09'), DEFAULT_SETTINGS, DEFAULT_SEED);
    expect(after.assignments).toEqual(before.assignments);
  });
});
