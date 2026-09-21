/**
 * 充足可能性の診断。
 * 「人数だけ見れば足りるが、実際には埋まらない」形を検出できることを確かめる。
 */

import { describe, expect, it } from 'vitest';
import { diagnoseFeasibility, maxMatching } from '../src/core/feasibility';
import { SLOT } from '../src/core/types';
import { planFor, staff, task } from './helpers';

describe('最大マッチング', () => {
  it('担当可能者が重なっていても実際に埋まる数を返す', () => {
    expect(maxMatching([['a', 'b'], ['a'], ['a']])).toBe(2);
  });

  it('誰も担当できない枠は数えない', () => {
    expect(maxMatching([[], ['a']])).toBe(1);
  });

  it('押しのけが必要な場合も正しく数える', () => {
    // 枠0 は a のみ、枠1 は a と b。素直に埋めると1枠しか入らないが、
    // a を枠0 に譲れば2枠とも埋まる。
    expect(maxMatching([['a'], ['a', 'b']])).toBe(2);
  });
});

describe('事前診断', () => {
  it('全部埋まるなら問題なしと言う', () => {
    const plan = planFor({
      period: '2026-09',
      staff: [staff('a', '相川', '介護職員'), staff('b', '井上', '介護職員')],
      tasks: [task({ taskId: 'BATH', name: '入浴担当', headcount: 2, eligibleJob: ['介護職員'] })],
      days: [1, 2],
    });
    const report = diagnoseFeasibility(plan);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('出勤者は足りているが職種が合わない日を見つける', () => {
    // 午前に2枠（入浴=介護職員、看護師=看護職員）。出勤者は介護職員2人。
    // 頭数は足りるが看護師枠は埋まらない。
    const plan = planFor({
      period: '2026-09',
      staff: [staff('a', '相川', '介護職員'), staff('b', '井上', '介護職員')],
      tasks: [
        task({ taskId: 'BATH', name: '入浴担当', slot: SLOT.AM, eligibleJob: ['介護職員'] }),
        task({ taskId: 'NURSE', name: '看護師', slot: SLOT.AM, eligibleJob: ['看護職員'] }),
      ],
      days: [1],
    });
    const report = diagnoseFeasibility(plan);
    expect(report.ok).toBe(false);
    expect(report.shortfall).toBe(1);
    expect(report.affectedDayCount).toBe(1);
    expect(report.issues.some((i) => i.message.includes('看護師'))).toBe(true);
  });

  it('必要人数に対して出勤者が足りない日を見つける', () => {
    const plan = planFor({
      period: '2026-09',
      staff: [staff('a', '相川', '介護職員'), staff('b', '井上', '介護職員')],
      tasks: [task({ taskId: 'BATH', name: '入浴担当', headcount: 2, eligibleJob: ['介護職員'] })],
      days: [1, 2],
      off: { b: [2] },
    });
    const report = diagnoseFeasibility(plan);
    expect(report.ok).toBe(false);
    expect(report.issues.every((i) => i.day === 2)).toBe(true);
  });

  it('不足の数え方は多い方を採る（過小に見せない）', () => {
    const plan = planFor({
      period: '2026-09',
      staff: [staff('a', '相川', '介護職員')],
      tasks: [task({ taskId: 'BATH', name: '入浴担当', headcount: 3, eligibleJob: ['介護職員'] })],
      days: [1],
    });
    const report = diagnoseFeasibility(plan);
    expect(report.shortfall).toBe(2);
  });
});
