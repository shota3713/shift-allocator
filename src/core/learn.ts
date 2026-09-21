/**
 * 手修正と、そこからの学習。
 *
 * 修正しただけではルールにしない。人が「今後も反映する」と言ったものだけを
 * ルールにする。誤操作や一度きりの例外を恒久ルールとして固定しないため。
 *
 * 同じ修正が何回あったかを提案に添えるので、「たまたま」と「傾向」を
 * 目で区別できる。
 */

import { canAssign, isEligible } from './assign';
import { weekdayOf } from './plan';
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

/**
 * ある枠を交代できる人を返す。修正画面の選択肢になる。
 * 出勤・職種・指名・同時間帯の掛け持ち・排他グループをすべて考慮する。
 */
export function candidatesForSlot(
  assignments: readonly Assignment[],
  plan: Plan,
  day: number,
  taskId: string,
): { staffId: string; name: string }[] {
  const index = assignments.findIndex((a) => a.day === day && a.taskId === taskId);
  const task = plan.tasksById.get(taskId);
  if (!task) return [];

  return (plan.workingByDay.get(day) ?? [])
    .filter((staffId) => isEligible(staffId, task, plan.staffJob))
    .filter((staffId) => canAssign(staffId, { day, taskId }, assignments, plan, index))
    .map((staffId) => ({ staffId, name: plan.staffNames.get(staffId) ?? staffId }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
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
      assignments: run.assignments.map((a) =>
        a.day === input.day && a.taskId === input.taskId
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
