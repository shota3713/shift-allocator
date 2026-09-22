/**
 * 半日単位の在所と、担当できる人の設定が割り振りに効くか。
 *
 * ここが効いていないと、1日フリーの人にリハ担当が乗り、清掃専任の人が
 * 昼担当に入る。実際に起きた不具合をそのまま試験にしてある。
 */

import { describe, expect, it } from 'vitest';
import { runAssignment } from '../src/core/assign';
import { buildPlan } from '../src/core/plan';
import { DEFAULT_SEED, DEFAULT_SETTINGS, SLOT } from '../src/core/types';
import { AM_ONLY, FREE, databaseWith, staff, task } from './helpers';

const TASKS = [
  task({ taskId: 'BATH', name: '入浴担当', slot: SLOT.AM, eligibleJob: ['介護職員'] }),
  task({ taskId: 'REC', name: 'レクリーダー', slot: SLOT.PM, eligibleJob: ['介護職員'] }),
];
const DAYS = [1, 2, 3];

const TEAM = [
  staff('a', '相川', '介護職員'),
  staff('b', '井上', '介護職員'),
  staff('c', '上田', '介護職員'),
  staff('d', '江口', '介護職員'),
];

describe('1日フリー（F）', () => {
  const db = databaseWith({
    period: '2026-09',
    staff: TEAM,
    tasks: TASKS,
    days: DAYS,
    codes: { a: { 2: FREE.code, 3: FREE.code } },
  });
  const plan = buildPlan(db, '2026-09');
  const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);

  it('フリーの日は割り振りの対象日に数えない', () => {
    expect([...(plan.workingByStaff.get('a') ?? [])]).toEqual([1]);
  });

  it('フリーの日に業務は載らない', () => {
    const onFreeDays = result.assignments.filter((x) => x.staffId === 'a' && x.day !== 1);
    expect(onFreeDays).toEqual([]);
  });

  it('1日フリーだけの人は、そもそも候補に入らない', () => {
    const allFree = buildPlan(databaseWith({
      period: '2026-09',
      staff: TEAM,
      tasks: TASKS,
      days: DAYS,
      codes: { a: { 1: FREE.code, 2: FREE.code, 3: FREE.code } },
    }), '2026-09');
    expect(allFree.workingByStaff.get('a')).toBeUndefined();
  });
});

describe('午前だけ現場（日/F）', () => {
  const db = databaseWith({
    period: '2026-09',
    staff: TEAM,
    tasks: TASKS,
    days: DAYS,
    codes: { a: { 1: AM_ONLY.code, 2: AM_ONLY.code, 3: AM_ONLY.code } },
  });
  const plan = buildPlan(db, '2026-09');
  const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);

  it('午前の業務には入りうる', () => {
    expect(plan.presence.get('a')?.get(1)?.am).toBe(true);
  });

  it('午後の業務には入らない', () => {
    const pm = result.assignments.filter((x) => x.staffId === 'a' && x.taskId === 'REC');
    expect(pm).toEqual([]);
  });
});

describe('担当できる人の設定', () => {
  it('外した人には、その業務が回らない', () => {
    const db = databaseWith({
      period: '2026-09',
      staff: TEAM,
      tasks: TASKS,
      days: DAYS,
      skills: [{ staffId: 'a', taskIds: ['BATH'] }],
    });
    const plan = buildPlan(db, '2026-09');
    const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);

    expect(plan.capable.get('REC')?.has('a')).toBe(false);
    expect(result.assignments.filter((x) => x.staffId === 'a' && x.taskId === 'REC')).toEqual([]);
  });

  it('未設定の人は職種から判断する', () => {
    const db = databaseWith({ period: '2026-09', staff: TEAM, tasks: TASKS, days: DAYS });
    const plan = buildPlan(db, '2026-09');
    expect(plan.capable.get('REC')?.size).toBe(4);
  });
});

describe('昼担当の優先順', () => {
  const NOON = [
    task({
      taskId: 'NOON',
      name: '昼担当',
      slot: SLOT.NOON,
      headcount: 1,
      eligibleJob: ['介護職員', '看護職員'],
      preferOrder: ['job:看護職員', 'amOnly', 'kind:LATE'],
    }),
  ];

  it('看護師がいれば看護師に回る', () => {
    const db = databaseWith({
      period: '2026-09',
      staff: [...TEAM, staff('n', '星野', '看護職員')],
      tasks: NOON,
      days: DAYS,
    });
    const plan = buildPlan(db, '2026-09');
    const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);
    expect(result.assignments.every((x) => x.staffId === 'n')).toBe(true);
  });

  it('看護師がいなければ午前だけの人に回る', () => {
    const db = databaseWith({
      period: '2026-09',
      staff: TEAM,
      tasks: NOON,
      days: DAYS,
      codes: { d: { 1: AM_ONLY.code, 2: AM_ONLY.code, 3: AM_ONLY.code } },
    });
    const plan = buildPlan(db, '2026-09');
    const result = runAssignment(plan, DEFAULT_SETTINGS, DEFAULT_SEED);
    expect(result.assignments.every((x) => x.staffId === 'd')).toBe(true);
  });
});
