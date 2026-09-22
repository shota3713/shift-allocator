/**
 * 人数の決まり方と、掛け持ちの例外。
 *
 * ・午前に5人しかいない日は、風呂3・リハ1・看護1 にする
 * ・体操は空いている人が優先。いなければ連絡帳・レク以外の人が兼任する
 * ・難易度は5段階で、計算に使う重みはそこから引く
 */

import { describe, expect, it } from 'vitest';
import { runAssignment } from '../src/core/assign';
import { buildPlan } from '../src/core/plan';
import { DIFFICULTY_LEVELS, difficultyFromWeight, weightOf } from '../src/core/difficulty';
import { defaultTasks } from '../src/core/masters';
import { DEFAULT_SEED, DEFAULT_SETTINGS, SLOT } from '../src/core/types';
import { databaseWith, staff, task } from './helpers';

const CARE_JOBS = ['介護職員', '管理者', 'アシスタントスタッフ'];
const DAYS = [1, 2, 3];

/** 午前の標準の顔ぶれ。介護 n 人 + 看護1人。 */
function amTeam(careCount: number) {
  const care = Array.from({ length: careCount }, (_, i) =>
    staff(`c${i}`, `介護${i}`, '介護職員'));
  return [...care, staff('n', '星野', '看護職員')];
}

function amTasks() {
  return defaultTasks(CARE_JOBS).filter((t) => t.slot === SLOT.AM);
}

function countOn(plan: ReturnType<typeof buildPlan>, day: number, taskId: string): number {
  return plan.slots.filter((s) => s.day === day && s.taskId === taskId).length;
}

describe('午前の人数', () => {
  it('6人いれば 風呂3・リハ2・看護1 の6枠', () => {
    const plan = buildPlan(
      databaseWith({ period: '2026-09', staff: amTeam(5), tasks: amTasks(), days: DAYS }),
      '2026-09',
    );
    expect(countOn(plan, 1, 'BATH')).toBe(2);
    expect(countOn(plan, 1, 'BATH_LEAD')).toBe(1);
    expect(countOn(plan, 1, 'REHA_AM')).toBe(2);
    expect(countOn(plan, 1, 'NURSE_AM')).toBe(1);
  });

  it('5人しかいない日は リハを1人に減らして 風呂3・リハ1・看護1', () => {
    const plan = buildPlan(
      databaseWith({ period: '2026-09', staff: amTeam(4), tasks: amTasks(), days: DAYS }),
      '2026-09',
    );
    expect(countOn(plan, 1, 'BATH') + countOn(plan, 1, 'BATH_LEAD')).toBe(3);
    expect(countOn(plan, 1, 'REHA_AM')).toBe(1);
    expect(countOn(plan, 1, 'NURSE_AM')).toBe(1);
    expect(plan.slots.filter((s) => s.day === 1).length).toBe(5);
  });

  it('5人の日でも全部の枠が埋まる', () => {
    const db = databaseWith({ period: '2026-09', staff: amTeam(4), tasks: amTasks(), days: DAYS });
    const plan = buildPlan(db, '2026-09');
    const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);
    expect(result.assignments.filter((a) => !a.staffId)).toEqual([]);
  });
});

describe('体操の掛け持ち', () => {
  const PM = defaultTasks(CARE_JOBS).filter((t) => t.slot === SLOT.PM);

  it('午後に人が足りていれば掛け持ちしない', () => {
    // 午後は 連絡帳1・レク1・体操1・PMリハ1・手作業2 の6人。
    const team = Array.from({ length: 8 }, (_, i) => staff(`c${i}`, `介護${i}`, '介護職員'));
    const plan = buildPlan(
      databaseWith({ period: '2026-09', staff: team, tasks: PM, days: DAYS }),
      '2026-09',
    );
    const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);
    const taiso = result.assignments.find((a) => a.day === 1 && a.taskId === 'TAISO');
    const others = result.assignments.filter(
      (a) => a.day === 1 && a.taskId !== 'TAISO' && a.staffId === taiso?.staffId,
    );
    expect(others).toEqual([]);
  });

  it('人が足りないときは体操だけ兼任になる', () => {
    const team = Array.from({ length: 5 }, (_, i) => staff(`c${i}`, `介護${i}`, '介護職員'));
    const plan = buildPlan(
      databaseWith({ period: '2026-09', staff: team, tasks: PM, days: DAYS }),
      '2026-09',
    );
    const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);

    const taiso = result.assignments.find((a) => a.day === 1 && a.taskId === 'TAISO');
    expect(taiso?.staffId).toBeTruthy();

    // 兼任しても、連絡帳とレクリーダーの人には乗らない。
    const alsoHas = result.assignments
      .filter((a) => a.day === 1 && a.staffId === taiso?.staffId && a.taskId !== 'TAISO')
      .map((a) => a.taskId);
    expect(alsoHas).not.toContain('RENRAKU');
    expect(alsoHas).not.toContain('REC_LEAD');
  });

  it('連絡帳とレクリーダーは互いに掛け持ちできない', () => {
    const team = Array.from({ length: 5 }, (_, i) => staff(`c${i}`, `介護${i}`, '介護職員'));
    const plan = buildPlan(
      databaseWith({ period: '2026-09', staff: team, tasks: PM, days: DAYS }),
      '2026-09',
    );
    const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);
    const renraku = result.assignments.find((a) => a.day === 1 && a.taskId === 'RENRAKU');
    const rec = result.assignments.find((a) => a.day === 1 && a.taskId === 'REC_LEAD');
    expect(renraku?.staffId).not.toBe(rec?.staffId);
  });
});

describe('手作業', () => {
  it('標準の業務に午後2人で入っている', () => {
    const handwork = defaultTasks(CARE_JOBS).find((t) => t.taskId === 'HANDWORK');
    expect(handwork?.slot).toBe(SLOT.PM);
    expect(handwork?.headcount).toBe(2);
    // 午後が薄い日は1人に落ちる。空欄で残すより1人でも立てる。
    expect(handwork?.minHeadcount).toBe(1);
  });

  it('PMリハの人は手作業に入らない', () => {
    const PM = defaultTasks(CARE_JOBS).filter((t) => t.slot === SLOT.PM);
    const team = Array.from({ length: 8 }, (_, i) => staff(`c${i}`, `介護${i}`, '介護職員'));
    const plan = buildPlan(
      databaseWith({ period: '2026-09', staff: team, tasks: PM, days: DAYS }),
      '2026-09',
    );
    const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);
    const reha = result.assignments.find((a) => a.day === 1 && a.taskId === 'REHA_PM');
    const handwork = result.assignments
      .filter((a) => a.day === 1 && a.taskId === 'HANDWORK')
      .map((a) => a.staffId);
    expect(handwork).not.toContain(reha?.staffId);
  });
});

describe('難易度', () => {
  it('5段階ある', () => {
    expect(DIFFICULTY_LEVELS.map((d) => d.level)).toEqual([1, 2, 3, 4, 5]);
  });

  it('段階が上がるほど重みも上がる', () => {
    const weights = DIFFICULTY_LEVELS.map((d) => d.weight);
    for (let i = 1; i < weights.length; i += 1) {
      expect(weights[i] as number).toBeGreaterThan(weights[i - 1] as number);
    }
  });

  it('古い保存データの重みを近い段階に寄せる', () => {
    expect(difficultyFromWeight(1.0)).toBe(2);
    expect(difficultyFromWeight(1.5)).toBe(3);
    expect(difficultyFromWeight(2.0)).toBe(4);
    expect(difficultyFromWeight(undefined)).toBe(3);
  });

  it('難しい業務ほど負担として重く数える', () => {
    const hard = task({ taskId: 'HARD', name: '重い業務', slot: SLOT.PM, difficulty: 5 });
    const easy = task({ taskId: 'EASY', name: '軽い業務', slot: SLOT.AM, difficulty: 1 });
    expect(weightOf(hard.difficulty)).toBeGreaterThan(weightOf(easy.difficulty));
  });
});
