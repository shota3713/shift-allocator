/**
 * 振り分けの領域モデル。
 *
 * 旧版は表計算の行オブジェクトをそのまま回していたが、ここでは型を先に置く。
 * 計算（assign / feasibility）は保存層を知らず、この型だけを受け取る。
 */

/** 時間帯。同じ時間帯に1人が持てる業務は1つだけ（体は1つしかない）。 */
export const SLOT = { AM: 'AM', NOON: 'NOON', PM: 'PM' } as const;
export type Slot = (typeof SLOT)[keyof typeof SLOT];

export const SLOT_LABELS: Record<Slot, string> = { AM: '午前', NOON: '昼', PM: '午後' };
export const SLOT_ORDER: readonly Slot[] = ['AM', 'NOON', 'PM'];

export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export const WEEKDAY_LABELS: Record<WeekdayKey, string> = {
  sun: '日', mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土',
};

export interface Staff {
  readonly staffId: string;
  readonly name: string;
  readonly job: string;
  readonly active: boolean;
  readonly note: string;
}

/** 勤務区分。is_working が false の日は割り当て対象外。 */
export interface ShiftType {
  readonly code: string;
  readonly label: string;
  readonly isWorking: boolean;
  readonly hours: number;
  readonly aliases: readonly string[];
}

/** 業務の適用対象。曜日指定はカンマ区切りの WeekdayKey。 */
export type AppliesTo = 'all' | 'weekday' | 'weekend' | string;

export interface Task {
  readonly taskId: string;
  readonly name: string;
  readonly slot: Slot;
  /** 負担の重み。リーダー業務ほど重い。 */
  readonly weight: number;
  readonly headcount: number;
  /** 空なら職種を問わない。 */
  readonly eligibleJob: readonly string[];
  /** 空なら指名なし。 */
  readonly eligibleStaff: readonly string[];
  /** 同じ値を持つ業務は、同じ人が同じ日に兼任できない。 */
  readonly exclusiveGroup: string;
  readonly appliesTo: AppliesTo;
  readonly active: boolean;
  readonly note: string;
}

export const RULE_TYPE = {
  AVOID: 'avoid',
  PREFER: 'prefer',
  DAY_AVOID: 'day_avoid',
} as const;
export type RuleType = (typeof RULE_TYPE)[keyof typeof RULE_TYPE];

/** 手修正から学んだ好み。ソフト制約としてコストに効く。 */
export interface LearnedRule {
  readonly ruleId: string;
  readonly type: RuleType;
  /** 対象の職員。 */
  readonly subject: string;
  /** 対象の業務。空なら全業務。 */
  readonly object: string;
  /** day_avoid のときの曜日。 */
  readonly scope: string;
  readonly weight: number;
  readonly evidenceCount: number;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

/** 埋めるべき枠。headcount のぶんだけ index 違いで並ぶ。 */
export interface SlotRequest {
  readonly day: number;
  readonly weekday: WeekdayKey;
  readonly taskId: string;
  readonly slot: Slot;
  readonly index: number;
  readonly weight: number;
}

export interface Assignment {
  readonly day: number;
  readonly weekday: WeekdayKey;
  readonly taskId: string;
  /** 埋まらなかった枠は空文字。 */
  readonly staffId: string;
}

/** 振り分けの前提一式。ここまで組めれば計算は純粋関数でできる。 */
export interface Plan {
  readonly periodKey: string;
  readonly year: number;
  readonly month: number;
  readonly slots: readonly SlotRequest[];
  readonly tasks: readonly Task[];
  readonly tasksById: ReadonlyMap<string, Task>;
  /** staffId → 出勤する日の集合。 */
  readonly workingByStaff: ReadonlyMap<string, ReadonlySet<number>>;
  /** 日 → その日出勤する staffId。 */
  readonly workingByDay: ReadonlyMap<number, readonly string[]>;
  readonly staffIds: readonly string[];
  readonly staffJob: ReadonlyMap<string, string>;
  readonly staffNames: ReadonlyMap<string, string>;
  readonly rules: readonly LearnedRule[];
}

/**
 * コスト関数の重み。
 *
 * 業務別の重みを総負担より大きくしてあるのは、「リハ・入浴・レクが
 * それぞれ均等に回ること」が目的だから。実データ（22人・26営業日）では
 * この値でリーダー3業務の月間回数の最大差が 2/1/2 回に収まる。
 */
export interface AssignSettings {
  readonly weightFairnessTotal: number;
  readonly weightFairnessTask: number;
  readonly weightLearnedRule: number;
  readonly improvementPasses: number;
}

export const DEFAULT_SETTINGS: AssignSettings = {
  weightFairnessTotal: 10.0,
  weightFairnessTask: 20.0,
  weightLearnedRule: 4.0,
  improvementPasses: 5000,
};

/** 既定の seed。乱数を使わないのは、学習の効果を比較できるようにするため。 */
export const DEFAULT_SEED = 20260912;
