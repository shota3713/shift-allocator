/**
 * 手修正と、そこからの学習。
 *
 * 修正しただけではルールにしない。人が「今後も反映する」と言ったものだけを
 * ルールにする。誤操作や一度きりの例外を恒久ルールとして固定しないため。
 *
 * 同じ修正が何回あったかを提案に添えるので、「たまたま」と「傾向」を
 * 目で区別できる。
 */

import { canAssign, isEligible, isPresent, preferenceTier } from './assign';
import { weekdayOf } from './plan';
import { SHIFT_KIND_LABELS } from './shiftCode';
import { RULE_TYPE, WEEKDAY_LABELS, type Assignment, type LearnedRule, type Plan, type RuleType } from './types';
import type { Correction, Database } from '../store/db';
import { newId, nowIso } from '../store/db';

/** 1回の承認で増える重み。 */
const RULE_WEIGHT_STEP = 1.0;
/** これ以上は強くしない。1つのルールが公平性を押しのけないため。 */
const RULE_WEIGHT_CAP = 5.0;

export interface LearningProposal {
  readonly type: RuleType;
  readonly subject: string;
  readonly object: string;
  readonly scope: string;
  readonly label: string;
  /** 過去に同じ修正が何回あったか。 */
  readonly evidence: number;
}

/** 修正画面に出す1人ぶんの選択肢。 */
export interface SlotCandidate {
  readonly staffId: string;
  readonly name: string;
  readonly job: string;
  /** そのまま入れても制約を破らないか。 */
  readonly ok: boolean;
  /** 優先の理由、または入れられない理由。 */
  readonly note: string;
  readonly group: 'ready' | 'limited' | 'absent';
}

/** 枠を特定する鍵。同じ業務に複数人いるので index が要る。 */
export interface SlotKey {
  readonly day: number;
  readonly taskId: string;
  readonly index: number;
}

function indexOfSlot(assignments: readonly Assignment[], key: SlotKey): number {
  return assignments.findIndex(
    (a) => a.day === key.day && a.taskId === key.taskId && a.index === key.index,
  );
}

/**
 * その枠に入れられる人を返す。修正画面の選択肢になる。
 *
 * 制約を満たす人だけに絞ると、画面に2〜3人しか出ず「この人にしたい」ができない。
 * その日出勤している人は全員出して、入れられない人には理由を付ける。
 * 決めるのは人で、機械は判断の材料を出すだけ。
 */
export function candidatesForSlot(
  assignments: readonly Assignment[],
  plan: Plan,
  key: SlotKey,
): SlotCandidate[] {
  const task = plan.tasksById.get(key.taskId);
  if (!task) return [];
  const here = indexOfSlot(assignments, key);

  const rows = (plan.workingByDay.get(key.day) ?? []).map((staffId): SlotCandidate => {
    const name = plan.staffNames.get(staffId) ?? staffId;
    const job = plan.staffJob.get(staffId) ?? '';
    const present = isPresent(staffId, key.day, task.slot, plan);
    const capable = isEligible(staffId, task, plan);

    if (!present) {
      const shift = plan.presence.get(staffId)?.get(key.day);
      const why = shift
        ? shift.am ? '午後はフリーです' : shift.pm ? '午前はフリーです' : 'この時間帯はいません'
        : 'この時間帯はいません';
      return { staffId, name, job, ok: false, note: why, group: 'absent' };
    }
    if (!capable) {
      return {
        staffId, name, job, ok: false,
        note: 'この業務を担当できる人に入っていません',
        group: 'limited',
      };
    }
    if (!canAssign(staffId, key, assignments, plan, here)) {
      const clash = assignments.find((a, i) =>
        i !== here && a.staffId === staffId && a.day === key.day
        && (plan.tasksById.get(a.taskId)?.slot === task.slot
          || (task.exclusiveGroup !== ''
            && plan.tasksById.get(a.taskId)?.exclusiveGroup === task.exclusiveGroup)));
      const clashName = clash ? plan.tasksById.get(clash.taskId)?.name ?? clash.taskId : '';
      return {
        staffId, name, job, ok: false,
        note: clashName ? `同じ日に「${clashName}」を持っています` : '掛け持ちになります',
        group: 'limited',
      };
    }

    const tier = preferenceTier(staffId, task, key.day, plan);
    const shift = plan.presence.get(staffId)?.get(key.day);
    const note = task.preferOrder.length === 0
      ? job
      : tier < task.preferOrder.length
        ? `${job}／${shift?.amOnly === true ? '午前だけ' : SHIFT_KIND_LABELS[shift?.kind ?? 'DAY']}・優先`
        : `${job}／${shift?.amOnly === true ? '午前だけ' : SHIFT_KIND_LABELS[shift?.kind ?? 'DAY']}`;
    return { staffId, name, job, ok: true, note, group: 'ready' };
  });

  const rank = (c: SlotCandidate): number => (c.group === 'ready' ? 0 : c.group === 'limited' ? 1 : 2);
  return rows.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.group === 'ready') {
      const ta = preferenceTier(a.staffId, task, key.day, plan);
      const tb = preferenceTier(b.staffId, task, key.day, plan);
      if (ta !== tb) return ta - tb;
    }
    return a.name < b.name ? -1 : 1;
  });
}

/**
 * 修正内容から「次回以降こうしますか？」の候補を組む。
 */
export function buildLearningProposals(
  db: Database,
  periodKey: string,
  day: number,
  taskId: string,
  staffBefore: string,
  staffAfter: string,
  /** 今まさに行った修正。「過去に何回あったか」には数えない。 */
  excludeCorrectionId = '',
): LearningProposal[] {
  const staffName = (id: string): string => db.staff.find((s) => s.staffId === id)?.name ?? id;
  const taskName = db.tasks.find((t) => t.taskId === taskId)?.name ?? taskId;

  const [yearText, monthText] = periodKey.split('-');
  const weekday = weekdayOf(Number(yearText), Number(monthText), day);
  const weekdayLabel = WEEKDAY_LABELS[weekday];

  const past = db.corrections.filter((c) => c.correctionId !== excludeCorrectionId);
  const history = past.filter((c) => c.taskId === taskId && c.staffBefore === staffBefore);

  const proposals: LearningProposal[] = [];
  if (staffBefore) {
    proposals.push({
      type: RULE_TYPE.AVOID,
      subject: staffBefore,
      object: taskId,
      scope: '',
      label: `${staffName(staffBefore)} は「${taskName}」を避ける`,
      evidence: history.length,
    });
    proposals.push({
      type: RULE_TYPE.DAY_AVOID,
      subject: staffBefore,
      object: taskId,
      scope: weekday,
      label: `${staffName(staffBefore)} は${weekdayLabel}曜の「${taskName}」を避ける`,
      evidence: history.filter((c) => {
        const [y, m] = c.period.split('-');
        return weekdayOf(Number(y), Number(m), c.day) === weekday;
      }).length,
    });
  }
  if (staffAfter) {
    proposals.push({
      type: RULE_TYPE.PREFER,
      subject: staffAfter,
      object: taskId,
      scope: '',
      label: `${staffName(staffAfter)} に「${taskName}」を優先的に割り当てる`,
      evidence: past.filter((c) => c.taskId === taskId && c.staffAfter === staffAfter).length,
    });
  }
  return proposals;
}

/** 修正を記録する。ルール化はまだしない。 */
export function recordCorrection(
  db: Database,
  input: {
    readonly runId: string;
    readonly period: string;
    readonly day: number;
    readonly taskId: string;
    /** 同じ業務の何人目の枠か。ここを持たないと同じ業務の枠が全部書き換わる。 */
    readonly index: number;
    readonly staffBefore: string;
    readonly staffAfter: string;
    readonly reason?: string;
  },
): { db: Database; correction: Correction } {
  const correction: Correction = {
    correctionId: newId('cor'),
    runId: input.runId,
    period: input.period,
    day: input.day,
    taskId: input.taskId,
    index: input.index,
    staffBefore: input.staffBefore,
    staffAfter: input.staffAfter,
    reason: input.reason ?? '',
    learned: false,
    createdAt: nowIso(),
  };

  const runs = db.runs.map((run) => {
    if (run.runId !== input.runId) return run;
    return {
      ...run,
      // 枠は (日 / 業務 / 何人目) で一意。index を見ないと、昼担当のように
      // 同じ業務が同じ日に複数ある枠が、まとめて同じ人に書き換わる。
      assignments: run.assignments.map((a) =>
        a.day === input.day && a.taskId === input.taskId && a.index === input.index
          ? { ...a, staffId: input.staffAfter, origin: 'manual' as const }
          : a,
      ),
    };
  });

  return { db: { ...db, runs, corrections: [...db.corrections, correction] }, correction };
}

/** 学習を承認する。同じルールが既にあれば重みを強める（上限あり）。 */
export function applyLearning(
  db: Database,
  correctionId: string,
  proposal: LearningProposal,
): Database {
  const matches = (r: LearnedRule): boolean =>
    r.type === proposal.type
    && r.subject === proposal.subject
    && r.object === proposal.object
    && r.scope === proposal.scope;

  const existing = db.rules.find(matches);
  const rules: LearnedRule[] = existing
    ? db.rules.map((r) => {
        if (!matches(r)) return r;
        const evidenceCount = r.evidenceCount + 1;
        return {
          ...r,
          evidenceCount,
          weight: Math.min(RULE_WEIGHT_CAP, RULE_WEIGHT_STEP * evidenceCount),
          enabled: true,
          updatedAt: nowIso(),
        };
      })
    : [
        ...db.rules,
        {
          ruleId: newId('rule'),
          type: proposal.type,
          subject: proposal.subject,
          object: proposal.object,
          scope: proposal.scope,
          weight: RULE_WEIGHT_STEP,
          evidenceCount: 1,
          enabled: true,
          updatedAt: nowIso(),
        },
      ];

  return {
    ...db,
    rules,
    corrections: db.corrections.map((c) =>
      c.correctionId === correctionId ? { ...c, learned: true } : c,
    ),
  };
}

export interface RuleView {
  readonly rule: LearnedRule;
  readonly label: string;
}

/** 学習済みルールを人が読める形にする。 */
export function describeRules(db: Database): RuleView[] {
  const staffName = (id: string): string => db.staff.find((s) => s.staffId === id)?.name ?? id;
  const taskName = (id: string): string => db.tasks.find((t) => t.taskId === id)?.name ?? id;

  return db.rules.map((rule) => {
    const who = staffName(rule.subject);
    const what = rule.object ? `「${taskName(rule.object)}」` : '全業務';
    const label = rule.type === RULE_TYPE.AVOID
      ? `${who} は ${what} を避ける`
      : rule.type === RULE_TYPE.PREFER
        ? `${who} に ${what} を優先的に割り当てる`
        : `${who} は${WEEKDAY_LABELS[rule.scope as keyof typeof WEEKDAY_LABELS] ?? rule.scope}曜の ${what} を避ける`;
    return { rule, label };
  });
}
