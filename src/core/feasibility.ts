/**
 * 充足可能性の事前診断。
 *
 * 割り振ってから「埋まりませんでした」と言われても手が打てない。
 * 実行前に、そもそも埋まらない枠を数えて人に見せる。
 */

import { isEligible, isPresent } from './assign';
import { SLOT_LABELS, type Plan, type Slot, type SlotRequest } from './types';

export interface FeasibilityIssue {
  readonly day: number;
  readonly slot: Slot;
  readonly slotLabel: string;
  readonly taskId?: string;
  readonly need: number;
  readonly available: number;
  readonly shortfall: number;
  readonly message: string;
}

export interface FeasibilityReport {
  readonly period: string;
  readonly slotCount: number;
  readonly staffCount: number;
  readonly dayCount: number;
  readonly issues: readonly FeasibilityIssue[];
  readonly shortfall: number;
  readonly affectedDayCount: number;
  readonly ok: boolean;
}

/** 枠 i に誰かを入れられるか。既存の割り当てを押しのける経路も探す。 */
function augment(
  i: number,
  candidates: readonly (readonly string[])[],
  assignedTo: Map<string, number>,
  visited: Set<string>,
): boolean {
  for (const staffId of candidates[i] ?? []) {
    if (visited.has(staffId)) continue;
    visited.add(staffId);

    const holder = assignedTo.get(staffId);
    if (holder === undefined || augment(holder, candidates, assignedTo, visited)) {
      assignedTo.set(staffId, i);
      return true;
    }
  }
  return false;
}

/**
 * 二部マッチングの最大サイズ。枠がいくつ実際に埋まるかを返す。
 *
 * 人数の単純な合計では足りない。午前に6枠あり出勤者が6人いても、
 * そのうち2人が看護職員で看護師枠(1)しか埋められないなら実際には1枠余る。
 * 枠と担当可能者の対応を実際に組んでみるのが唯一正確な判定。
 */
export function maxMatching(candidates: readonly (readonly string[])[]): number {
  const assignedTo = new Map<string, number>();
  let matched = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    if (augment(i, candidates, assignedTo, new Set())) matched += 1;
  }
  return matched;
}

function sumShortfall(issues: readonly FeasibilityIssue[]): number {
  return issues.reduce((acc, i) => acc + i.shortfall, 0);
}

export function diagnoseFeasibility(plan: Plan): FeasibilityReport {
  const issues: FeasibilityIssue[] = [];

  const byDaySlot = new Map<string, { day: number; slot: Slot; need: number; slots: SlotRequest[] }>();
  for (const slot of plan.slots) {
    const key = `${slot.day}#${slot.slot}`;
    const entry = byDaySlot.get(key);
    if (entry) {
      entry.need += 1;
      entry.slots.push(slot);
    } else {
      byDaySlot.set(key, { day: slot.day, slot: slot.slot, need: 1, slots: [slot] });
    }
  }

  // 時間帯ごとに、枠と人の最大マッチングを求める。
  for (const entry of byDaySlot.values()) {
    const working = plan.workingByDay.get(entry.day) ?? [];
    const candidates = entry.slots.map((slot) => {
      const task = plan.tasksById.get(slot.taskId);
      return working.filter((staffId) =>
        isPresent(staffId, entry.day, entry.slot, plan) && isEligible(staffId, task, plan));
    });

    const matched = maxMatching(candidates);
    if (matched < entry.need) {
      const label = SLOT_LABELS[entry.slot] ?? entry.slot;
      issues.push({
        day: entry.day,
        slot: entry.slot,
        slotLabel: label,
        need: entry.need,
        available: matched,
        shortfall: entry.need - matched,
        message: `${entry.day}日 ${label}: ${entry.need}枠のうち ${matched}枠しか埋められない（${entry.need - matched}枠不足）`,
      });
    }
  }

  // 業務ごとに、担当できる人が足りない日を洗う。
  for (const task of plan.tasks) {
    for (const [day, working] of plan.workingByDay) {
      const eligible = working.filter((staffId) =>
        isPresent(staffId, day, task.slot, plan) && isEligible(staffId, task, plan));
      if (eligible.length >= task.headcount) continue;
      const label = SLOT_LABELS[task.slot] ?? task.slot;
      issues.push({
        day,
        slot: task.slot,
        slotLabel: label,
        taskId: task.taskId,
        need: task.headcount,
        available: eligible.length,
        shortfall: task.headcount - eligible.length,
        message: `${day}日「${task.name}」: ${task.headcount}人必要だがその時間帯に担当できる人は ${eligible.length}人（${task.headcount - eligible.length}枠不足）`,
      });
    }
  }

  issues.sort((a, b) => a.day - b.day);

  const affectedDays = new Set(issues.map((i) => i.day));

  return {
    period: plan.periodKey,
    slotCount: plan.slots.length,
    staffCount: plan.staffIds.length,
    dayCount: plan.workingByDay.size,
    issues,
    // 時間帯単位と業務単位の不足は同じ日を二重に数えうるため、多い方を採る。
    shortfall: Math.max(
      sumShortfall(issues.filter((i) => !i.taskId)),
      sumShortfall(issues.filter((i) => !!i.taskId)),
    ),
    affectedDayCount: affectedDays.size,
    ok: issues.length === 0,
  };
}
