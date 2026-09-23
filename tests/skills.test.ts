/**
 * 担当できる人の持ち方。
 *
 * 「できる業務の一覧」としてだけ持つと、あとから業務を足したときに
 * 誰の一覧にも入らず、新しい業務に誰も割り振られなくなる。実際に
 * 手作業を足したときに起きた。できる／できないを別々に持って防ぐ。
 */

import { describe, expect, it } from 'vitest';
import {
  buildCapableMap,
  canDo,
  clearTaskDecisions,
  isConfigured,
  migrateSkills,
  setSkills,
  setTaskMembers,
  taskIdsFor,
  type StaffSkills,
} from '../src/core/skills';
import { buildPlan } from '../src/core/plan';
import { runAssignment } from '../src/core/assign';
import { DEFAULT_SEED, DEFAULT_SETTINGS, SLOT } from '../src/core/types';
import { databaseWith, staff, task } from './helpers';

const TEAM = [
  staff('a', '相川', '介護職員'),
  staff('b', '井上', '介護職員'),
  staff('n', '星野', '看護職員'),
];
const CARE = ['介護職員'];
const TASKS = [
  task({ taskId: 'BATH', name: '入浴担当', slot: SLOT.AM, eligibleJob: CARE }),
  task({ taskId: 'REC', name: 'レクリーダー', slot: SLOT.PM, eligibleJob: CARE }),
];
const NEW_TASK = task({ taskId: 'HANDWORK', name: '手作業', slot: SLOT.PM, eligibleJob: CARE });

const jobOf = (staffId: string): string => TEAM.find((s) => s.staffId === staffId)?.job ?? '';

describe('あとから足した業務', () => {
  it('先に担当者を選んでいても、新しい業務は職種から判断する', () => {
    // レクリーダーの担当者を決める（全員ぶんの行ができる）
    const skills = setTaskMembers([], TEAM, 'REC', ['a']);
    expect(canDo('b', jobOf('b'), TASKS[1] as never, skills)).toBe(false);

    // そのあとで手作業を足す
    const withNew = [...TASKS, NEW_TASK];
    expect(taskIdsFor('a', '介護職員', withNew, skills)).toContain('HANDWORK');
    expect(taskIdsFor('b', '介護職員', withNew, skills)).toContain('HANDWORK');
  });

  it('新しい業務にちゃんと人が割り振られる', () => {
    const db = databaseWith({
      period: '2026-09',
      staff: TEAM,
      tasks: [...TASKS, NEW_TASK],
      days: [1, 2, 3],
    });
    const configured = { ...db, skills: setTaskMembers([], TEAM, 'REC', ['a']) };
    const plan = buildPlan(configured, '2026-09');
    const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);

    const handwork = result.assignments.filter((x) => x.taskId === 'HANDWORK');
    expect(handwork.length).toBeGreaterThan(0);
    expect(handwork.every((x) => x.staffId !== '')).toBe(true);
  });

  it('1つの業務を決めても、他の業務の設定は変わらない', () => {
    const first = setTaskMembers([], TEAM, 'BATH', ['a']);
    const second = setTaskMembers(first, TEAM, 'REC', ['b']);

    expect(canDo('a', '介護職員', TASKS[0] as never, second)).toBe(true);
    expect(canDo('b', '介護職員', TASKS[0] as never, second)).toBe(false);
    expect(canDo('b', '介護職員', TASKS[1] as never, second)).toBe(true);
    expect(canDo('a', '介護職員', TASKS[1] as never, second)).toBe(false);
  });
});

describe('職員ごとの設定', () => {
  it('画面に出ていた業務だけを決め直す', () => {
    const all = TASKS.map((t) => t.taskId);
    const skills = setSkills([], 'a', ['BATH'], all);

    expect(canDo('a', '介護職員', TASKS[0] as never, skills)).toBe(true);
    expect(canDo('a', '介護職員', TASKS[1] as never, skills)).toBe(false);
    // 画面に無かった業務は職種のまま
    expect(canDo('a', '介護職員', NEW_TASK, skills)).toBe(true);
  });

  it('何も決めていない人は未設定として扱う', () => {
    expect(isConfigured('a', [])).toBe(false);
    expect(isConfigured('a', setSkills([], 'a', [], ['BATH']))).toBe(true);
  });
});

describe('職種の初期値', () => {
  it('選んでいない人は職種で決まる', () => {
    const capable = buildCapableMap(
      TEAM.map((s) => ({ staffId: s.staffId, job: s.job })),
      TASKS,
      [],
    );
    expect(capable.get('BATH')?.has('a')).toBe(true);
    expect(capable.get('BATH')?.has('n')).toBe(false);
  });

  it('選んだ内容は職種より強い', () => {
    const skills = setTaskMembers([], TEAM, 'BATH', ['n']);
    const capable = buildCapableMap(
      TEAM.map((s) => ({ staffId: s.staffId, job: s.job })),
      TASKS,
      skills,
    );
    expect(capable.get('BATH')?.has('n')).toBe(true);
    expect(capable.get('BATH')?.has('a')).toBe(false);
  });
});

describe('古い保存データの読み直し', () => {
  it('当時あった業務の外し方は残す', () => {
    // 誰かの一覧に出てくる業務は「当時あった」と判断できる。
    // レクリーダーは b の一覧にあるので、a を外した事実が残る。
    const legacy = [
      { staffId: 'a', taskIds: ['BATH'] },
      { staffId: 'b', taskIds: ['BATH', 'REC'] },
    ] as unknown as StaffSkills[];
    const migrated = migrateSkills(legacy, TASKS);

    expect(canDo('a', '介護職員', TASKS[0] as never, migrated)).toBe(true);
    expect(canDo('a', '介護職員', TASKS[1] as never, migrated)).toBe(false);
    expect(canDo('b', '介護職員', TASKS[1] as never, migrated)).toBe(true);
  });

  it('誰の一覧にも無い業務は、あとから足したものとみなす', () => {
    const legacy = [
      { staffId: 'a', taskIds: ['BATH'] },
      { staffId: 'b', taskIds: ['BATH', 'REC'] },
    ] as unknown as StaffSkills[];
    const migrated = migrateSkills(legacy, [...TASKS, NEW_TASK]);

    expect(canDo('a', '介護職員', NEW_TASK, migrated)).toBe(true);
    expect(canDo('b', '介護職員', NEW_TASK, migrated)).toBe(true);
  });

  it('新しい形はそのまま読む', () => {
    const current: StaffSkills[] = [{ staffId: 'a', taskIds: ['BATH'], excluded: ['REC'] }];
    expect(migrateSkills(current, TASKS)).toEqual(current);
  });
});

describe('担当できる人が0人になったとき', () => {
  it('その業務の選択を取り消すと、職種の初期値に戻る', () => {
    const poisoned: StaffSkills[] = TEAM.map((s) => ({
      staffId: s.staffId,
      taskIds: ['BATH'],
      excluded: ['HANDWORK'],
    }));
    const before = buildCapableMap(
      TEAM.map((s) => ({ staffId: s.staffId, job: s.job })),
      [...TASKS, NEW_TASK],
      poisoned,
    );
    expect(before.get('HANDWORK')?.size).toBe(0);

    const repaired = clearTaskDecisions(poisoned, 'HANDWORK');
    const after = buildCapableMap(
      TEAM.map((s) => ({ staffId: s.staffId, job: s.job })),
      [...TASKS, NEW_TASK],
      repaired,
    );
    expect(after.get('HANDWORK')?.size).toBe(2);
    // 他の業務の設定は触らない（入浴は3人とも選ばれたまま）
    expect(before.get('BATH')?.size).toBe(3);
    expect(after.get('BATH')?.size).toBe(3);
  });
});
