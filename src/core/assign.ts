/**
 * 業務の振り分けエンジン。
 *
 * 確定済みの勤務日（誰がいつ出勤するか）を所与として、その枠の中で
 * 時間帯ごとの業務・担当を公平に割り振る。
 *
 * ハード制約（絶対に破らない）:
 *   - 出勤していない日には割り当てない
 *   - 職種・指名による担当可否（eligibleJob / eligibleStaff）
 *   - 同じ時間帯に1人が持てる業務は1つだけ
 *   - 同じ exclusiveGroup の業務を、同じ人が同じ日に持たない
 *
 * ソフト制約（コスト関数で最小化）:
 *   - 総負担の偏り / 業務ごとの回数の偏り / 学習ルール
 *
 * 設計上の制約: 同じ入力 + 同じ設定 + 同じ seed なら必ず同じ結果になること。
 * これがないと「修正を学習した効果」を検証できない。
 */

import {
  RULE_TYPE,
  type Assignment,
  type AssignSettings,
  type LearnedRule,
  type Plan,
  type SlotRequest,
  type Task,
  type WeekdayKey,
} from './types';

interface Load {
  total: number;
  byTask: Map<string, number>;
}

/** 職種・指名による担当可否。 */
export function isEligible(staffId: string, task: Task | undefined, staffJob: ReadonlyMap<string, string>): boolean {
  if (!task) return false;
  if (task.eligibleStaff.length > 0 && !task.eligibleStaff.includes(staffId)) return false;
  if (task.eligibleJob.length > 0 && !task.eligibleJob.includes(staffJob.get(staffId) ?? '')) return false;
  return true;
}

/** その業務がその曜日に発生するか。 */
export function taskAppliesTo(appliesTo: string, weekday: WeekdayKey): boolean {
  if (!appliesTo || appliesTo === 'all') return true;
  if (appliesTo === 'weekday') return weekday !== 'sat' && weekday !== 'sun';
  if (appliesTo === 'weekend') return weekday === 'sat' || weekday === 'sun';
  return appliesTo.split(',').map((s) => s.trim()).includes(weekday);
}

/**
 * その日の他の割り当てとぶつかるか。
 * 同一時間帯の掛け持ちと、exclusiveGroup の重複を禁じる。
 */
function hasConflict(
  staffId: string,
  slot: { day: number; taskId: string },
  assignments: readonly Assignment[],
  plan: Plan,
  excludeIndex: number,
): boolean {
  const task = plan.tasksById.get(slot.taskId);
  if (!task) return true;

  for (let k = 0; k < assignments.length; k += 1) {
    if (k === excludeIndex) continue;
    const other = assignments[k];
    if (!other || other.staffId !== staffId || other.day !== slot.day) continue;

    const otherTask = plan.tasksById.get(other.taskId);
    if (!otherTask) continue;

    if (otherTask.slot === task.slot) return true;
    if (task.exclusiveGroup && otherTask.exclusiveGroup === task.exclusiveGroup) return true;
  }
  return false;
}

/** ハード制約をすべて満たすか。 */
export function canAssign(
  staffId: string,
  slot: { day: number; taskId: string },
  assignments: readonly Assignment[],
  plan: Plan,
  excludeIndex: number,
): boolean {
  const working = plan.workingByStaff.get(staffId);
  if (!working || !working.has(slot.day)) return false;
  if (!isEligible(staffId, plan.tasksById.get(slot.taskId), plan.staffJob)) return false;
  if (hasConflict(staffId, slot, assignments, plan, excludeIndex)) return false;
  return true;
}

function initLoad(plan: Plan): Map<string, Load> {
  const load = new Map<string, Load>();
  for (const id of plan.staffIds) load.set(id, { total: 0, byTask: new Map() });
  return load;
}

/** その人の出勤日数。公平性はすべてこれで割った「1日あたり」で測る。 */
function workdaysOf(plan: Plan, staffId: string): number {
  return plan.workingByStaff.get(staffId)?.size || 1;
}

/** 学習ルールによる加点・減点。 */
function rulePenalty(
  staffId: string,
  slot: { taskId: string; weekday: WeekdayKey },
  rules: readonly LearnedRule[],
): number {
  let penalty = 0;
  for (const rule of rules) {
    if (rule.subject !== staffId) continue;
    if (rule.object && rule.object !== slot.taskId) continue;

    if (rule.type === RULE_TYPE.AVOID) penalty += rule.weight;
    else if (rule.type === RULE_TYPE.PREFER) penalty -= rule.weight;
    else if (rule.type === RULE_TYPE.DAY_AVOID && rule.scope === slot.weekday) penalty += rule.weight;
  }
  return penalty;
}

/**
 * 枠1つに対する候補者のコスト。小さいほど望ましい。
 *
 * 総負担も業務ごとの回数も、必ず出勤日数で割ってから比べる。
 * 生の回数で揃えると、出勤日数の少ない人ほど1日あたりの負担が重くなり、
 * 「均等に振り分ける」という目的と逆の結果になる。
 */
function candidateScore(
  staffId: string,
  slot: SlotRequest,
  load: Map<string, Load>,
  plan: Plan,
  settings: AssignSettings,
): number {
  const entry = load.get(staffId) ?? { total: 0, byTask: new Map<string, number>() };
  const workdays = workdaysOf(plan, staffId);

  const totalRate = entry.total / workdays;
  const taskRate = (entry.byTask.get(slot.taskId) ?? 0) / workdays;

  return settings.weightFairnessTotal * totalRate
    + settings.weightFairnessTask * taskRate
    + settings.weightLearnedRule * rulePenalty(staffId, slot, plan.rules);
}

/** 決定論的な擬似乱数。同じ seed なら同じ列を返す。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 貪欲時のタイブレーク。氏名順の偏りを避けつつ決定論を保つ。 */
function tieBreak(seed: number, slotIndex: number, staffId: string): number {
  let h = seed ^ slotIndex;
  for (let i = 0; i < staffId.length; i += 1) {
    h = Math.imul(h ^ staffId.charCodeAt(i), 0x01000193) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}

function variance(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length;
}

/** 全体コスト。局所改善の受理判定に使う。 */
export function totalCost(
  assignments: readonly Assignment[],
  plan: Plan,
  settings: AssignSettings,
): number {
  const load = initLoad(plan);
  let rulePart = 0;

  for (const a of assignments) {
    const entry = a.staffId ? load.get(a.staffId) : undefined;
    if (!entry) continue;
    const task = plan.tasksById.get(a.taskId);
    entry.total += task ? task.weight : 1;
    entry.byTask.set(a.taskId, (entry.byTask.get(a.taskId) ?? 0) + 1);
    rulePart += rulePenalty(a.staffId, { taskId: a.taskId, weekday: a.weekday }, plan.rules);
  }

  const normalized = plan.staffIds.map(
    (id) => (load.get(id) as Load).total / workdaysOf(plan, id),
  );

  // 業務ごとの偏りは、その業務を担当しうる人の中だけで測る。
  // 担当できない人の 0 回を混ぜると分散が無意味に膨らむ。
  // 回数そのものではなく「出勤1日あたりの回数」で比べる。
  let taskVariance = 0;
  for (const task of plan.tasks) {
    const eligible = plan.staffIds.filter((id) => isEligible(id, task, plan.staffJob));
    if (eligible.length === 0) continue;
    const rates = eligible.map(
      (id) => ((load.get(id) as Load).byTask.get(task.taskId) ?? 0) / workdaysOf(plan, id),
    );
    taskVariance += variance(rates) * task.weight;
  }

  // 未割り当ての枠は強く嫌う。
  const unfilled = assignments.filter((a) => !a.staffId).length;

  return settings.weightFairnessTotal * variance(normalized)
    + settings.weightFairnessTask * taskVariance
    + settings.weightLearnedRule * rulePart
    + unfilled * 1000;
}

/** 貪欲割り当て。各枠でその時点の負担が最も軽い候補を選ぶ。 */
function greedyAssign(plan: Plan, settings: AssignSettings, seed: number): Assignment[] {
  const load = initLoad(plan);
  const result: Assignment[] = [];

  plan.slots.forEach((slot, slotIndex) => {
    // 未確定の枠も先に置く。hasConflict が走査できるようにするため。
    result.push({ day: slot.day, taskId: slot.taskId, staffId: '', weekday: slot.weekday });
    const here = result.length - 1;

    const candidates = (plan.workingByDay.get(slot.day) ?? []).filter(
      (staffId) => canAssign(staffId, slot, result, plan, here),
    );
    if (candidates.length === 0) return;

    let bestStaff = '';
    let bestScore = Number.POSITIVE_INFINITY;
    for (const staffId of candidates) {
      const score = candidateScore(staffId, slot, load, plan, settings)
        + tieBreak(seed, slotIndex, staffId) * 0.0001;
      if (score < bestScore) {
        bestScore = score;
        bestStaff = staffId;
      }
    }

    const entry = load.get(bestStaff) as Load;
    entry.total += slot.weight;
    entry.byTask.set(slot.taskId, (entry.byTask.get(slot.taskId) ?? 0) + 1);
    result[here] = { day: slot.day, taskId: slot.taskId, staffId: bestStaff, weekday: slot.weekday };
  });

  return result;
}

/**
 * 局所改善。2つの割り当ての担当者を入れ替えてコストが下がるなら採用する。
 * 決定論的な擬似乱数で候補を選ぶので、seed が同じなら結果も同じ。
 */
function improve(
  assignments: readonly Assignment[],
  plan: Plan,
  settings: AssignSettings,
  seed: number,
): Assignment[] {
  let current = [...assignments];
  let currentCost = totalCost(current, plan, settings);
  const rng = mulberry32(seed);
  const n = current.length;
  if (n < 2) return current;

  for (let pass = 0; pass < settings.improvementPasses; pass += 1) {
    const i = Math.floor(rng() * n);
    const j = Math.floor(rng() * n);
    if (i === j) continue;

    const a = current[i] as Assignment;
    const b = current[j] as Assignment;
    if (!a.staffId || !b.staffId || a.staffId === b.staffId) continue;
    if (!canAssign(b.staffId, a, current, plan, i)) continue;
    if (!canAssign(a.staffId, b, current, plan, j)) continue;

    const candidate = [...current];
    candidate[i] = { ...a, staffId: b.staffId };
    candidate[j] = { ...b, staffId: a.staffId };

    const candidateCost = totalCost(candidate, plan, settings);
    if (candidateCost < currentCost - 1e-9) {
      current = candidate;
      currentCost = candidateCost;
    }
  }

  return current;
}

export interface AssignResult {
  readonly assignments: readonly Assignment[];
  readonly cost: number;
  readonly seed: number;
}

/** 振り分けを実行する。保存はしない（呼び出し側の仕事）。 */
export function runAssignment(plan: Plan, settings: AssignSettings, seed: number): AssignResult {
  const greedy = greedyAssign(plan, settings, seed);
  const improved = improve(greedy, plan, settings, seed);
  return {
    assignments: improved,
    cost: Math.round(totalCost(improved, plan, settings) * 1000) / 1000,
    seed,
  };
}
