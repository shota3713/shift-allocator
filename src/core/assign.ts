/**
 * 業務の振り分けエンジン。
 *
 * 確定済みの勤務日（誰がいつ出勤するか）を所与として、その枠の中で
 * 時間帯ごとの業務・担当を公平に割り振る。
 *
 * ハード制約（絶対に破らない）:
 *   - その時間帯に現場にいない人には割り当てない（1日フリー・午後フリーを含む）
 *   - 担当できない業務は割り当てない（職種の初期値 + 個人ごとの設定）
 *   - 同じ時間帯に1人が持てる業務は1つだけ
 *   - 同じ exclusiveGroup の業務を、同じ人が同じ日に持たない
 *
 * ソフト制約（コスト関数で最小化）:
 *   - 総負担の偏り / 業務ごとの回数の偏り / 担当してほしい人の優先順 / 学習ルール
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
  type Slot,
  type SlotRequest,
  type Task,
  type WeekdayKey,
} from './types';

interface Load {
  total: number;
  byTask: Map<string, number>;
}

/**
 * その業務を担当できる人か。
 * 判断はすべて Plan.capable に集約してある（職種の初期値 + 個人の設定）。
 */
export function isEligible(staffId: string, task: Task | undefined, plan: Plan): boolean {
  if (!task) return false;
  return plan.capable.get(task.taskId)?.has(staffId) === true;
}

/**
 * その時間帯に現場にいるか。
 * 「出勤している」では足りない。1日フリー（F）も、午後フリー（日/F）も
 * 勤務表では出勤の行に並ぶが、その半日に業務は載せられない。
 */
export function isPresent(staffId: string, day: number, slot: Slot, plan: Plan): boolean {
  const here = plan.presence.get(staffId)?.get(day);
  if (!here) return false;
  if (slot === 'AM') return here.am;
  if (slot === 'PM') return here.pm;
  return here.noon;
}

/**
 * 「担当してほしい人」の優先順の何番目か。小さいほど望ましい。
 * 当てはまらない人は末尾扱いにする（禁止ではない。いなければ回ってくる）。
 */
export function preferenceTier(staffId: string, task: Task, day: number, plan: Plan): number {
  if (task.preferOrder.length === 0) return 0;
  const here = plan.presence.get(staffId)?.get(day);
  const job = plan.staffJob.get(staffId) ?? '';

  for (let i = 0; i < task.preferOrder.length; i += 1) {
    const token = task.preferOrder[i] as string;
    if (token.startsWith('job:') && token.slice(4) === job) return i;
    if (token.startsWith('kind:') && here && token.slice(5) === here.kind) return i;
    if (token === 'amOnly' && here?.amOnly === true) return i;
    if (token === 'pmOnly' && here && here.pm && !here.am) return i;
  }
  return task.preferOrder.length;
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
  const task = plan.tasksById.get(slot.taskId);
  if (!task) return false;
  if (!isPresent(staffId, slot.day, task.slot, plan)) return false;
  if (!isEligible(staffId, task, plan)) return false;
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
  const task = plan.tasksById.get(slot.taskId);
  const tier = task ? preferenceTier(staffId, task, slot.day, plan) : 0;

  return settings.weightFairnessTotal * totalRate
    + settings.weightFairnessTask * taskRate
    + settings.weightPreference * tier
    + settings.weightLearnedRule * rulePenalty(staffId, slot, plan.rules);
}

/** 候補を、いま出せる中で最も上の優先順の人だけに絞る。 */
function bestTierOnly(
  candidates: readonly string[],
  task: Task,
  day: number,
  plan: Plan,
): string[] {
  if (task.preferOrder.length === 0) return [...candidates];
  let best = Number.POSITIVE_INFINITY;
  for (const staffId of candidates) {
    const tier = preferenceTier(staffId, task, day, plan);
    if (tier < best) best = tier;
  }
  return candidates.filter((staffId) => preferenceTier(staffId, task, day, plan) === best);
}

/** その割り当ての優先順。入れ替えで順位を落とさないための判定に使う。 */
function tierOf(assignment: Assignment, plan: Plan, staffId: string): number {
  const task = plan.tasksById.get(assignment.taskId);
  if (!task || !staffId) return 0;
  return preferenceTier(staffId, task, assignment.day, plan);
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
  let preferencePart = 0;

  for (const a of assignments) {
    const entry = a.staffId ? load.get(a.staffId) : undefined;
    if (!entry) continue;
    const task = plan.tasksById.get(a.taskId);
    entry.total += task ? task.weight : 1;
    entry.byTask.set(a.taskId, (entry.byTask.get(a.taskId) ?? 0) + 1);
    rulePart += rulePenalty(a.staffId, { taskId: a.taskId, weekday: a.weekday }, plan.rules);
    if (task) preferencePart += preferenceTier(a.staffId, task, a.day, plan);
  }

  const normalized = plan.staffIds.map(
    (id) => (load.get(id) as Load).total / workdaysOf(plan, id),
  );

  // 業務ごとの偏りは、その業務を担当しうる人の中だけで測る。
  // 担当できない人の 0 回を混ぜると分散が無意味に膨らむ。
  // 回数そのものではなく「出勤1日あたりの回数」で比べる。
  let taskVariance = 0;
  for (const task of plan.tasks) {
    const eligible = plan.staffIds.filter((id) => isEligible(id, task, plan));
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
    + settings.weightPreference * preferencePart
    + settings.weightLearnedRule * rulePart
    + unfilled * 1000;
}

/** 貪欲割り当て。各枠でその時点の負担が最も軽い候補を選ぶ。 */
function greedyAssign(plan: Plan, settings: AssignSettings, seed: number): Assignment[] {
  const load = initLoad(plan);
  const result: Assignment[] = [];

  plan.slots.forEach((slot, slotIndex) => {
    // 未確定の枠も先に置く。hasConflict が走査できるようにするため。
    result.push({
      day: slot.day, taskId: slot.taskId, index: slot.index, staffId: '', weekday: slot.weekday,
    });
    const here = result.length - 1;

    const allowed = (plan.workingByDay.get(slot.day) ?? []).filter(
      (staffId) => canAssign(staffId, slot, result, plan, here),
    );
    if (allowed.length === 0) return;

    // 優先順は公平さより先に効かせる。「昼担当は看護師か午前だけの人、
    // いなければ遅番」という決め方は、上の順位の人がいる限り下へ降りない。
    // 公平さは同じ順位の中だけで効かせる。
    const task = plan.tasksById.get(slot.taskId);
    const candidates = task
      ? bestTierOnly(allowed, task, slot.day, plan)
      : allowed;

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
    result[here] = {
      day: slot.day, taskId: slot.taskId, index: slot.index, staffId: bestStaff, weekday: slot.weekday,
    };
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

    // 公平さのために優先順を下げない。ここを許すと「看護師がいるのに
    // 別の人が昼担当」という入れ替えが、分散を下げる名目で通ってしまう。
    const before = tierOf(a, plan, a.staffId) + tierOf(b, plan, b.staffId);
    const after = tierOf(a, plan, b.staffId) + tierOf(b, plan, a.staffId);
    if (after > before) continue;

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
