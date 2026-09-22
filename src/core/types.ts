/**
 * 振り分けの領域モデル。
 *
 * 旧版は表計算の行オブジェクトをそのまま回していたが、ここでは型を先に置く。
 * 計算（assign / feasibility）は保存層を知らず、この型だけを受け取る。
 */

import type { DifficultyLevel } from './difficulty';
import type { Presence, ShiftKind } from './shiftCode';

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

/**
 * 勤務区分。
 *
 * 出勤かどうかだけでは足りない。「日/F」のように半日だけ現場にいる勤務が
 * あるので、午前・午後それぞれの在所を持つ。業務を割り振るのは work の半日だけ。
 */
export interface ShiftType {
  readonly code: string;
  readonly label: string;
  readonly isWorking: boolean;
  readonly hours: number;
  readonly aliases: readonly string[];
  readonly am: Presence;
  readonly pm: Presence;
}

/** 業務の適用対象。曜日指定はカンマ区切りの WeekdayKey。 */
export type AppliesTo = 'all' | 'weekday' | 'weekend' | string;

export interface Task {
  readonly taskId: string;
  readonly name: string;
  readonly slot: Slot;
  /** 難易度。5段階。計算に使う重みはここから引く（weightOf）。 */
  readonly difficulty: DifficultyLevel;
  readonly headcount: number;
  /**
   * 人が足りない日に、ここまでなら人数を減らしてよいという下限。
   * 例）午前に5人しかいない日は、リハ担当を2人から1人に落として
   * 風呂3・リハ1・看護1 にする。headcount と同じなら減らさない。
   */
  readonly minHeadcount: number;
  /**
   * 同じ時間帯の他の業務と掛け持ちしてよいか。
   * 体操のように短く済む業務だけ true にする。空いている人が優先で、
   * いないときだけ掛け持ちになる。
   */
  readonly allowSameSlot: boolean;
  /** 同じ日に持たせたくない業務。掛け持ちを許した業務の例外を書く。 */
  readonly avoidWith: readonly string[];
  /** 担当可否の初期値に使う職種。個人の設定（skills）があればそちらが勝つ。 */
  readonly eligibleJob: readonly string[];
  /**
   * 担当してほしい人の優先順。前にあるものから順に当てる。
   * 'job:看護職員' / 'kind:LATE' / 'amOnly' / 'pmOnly' が書ける。
   * 例）昼担当は 看護師 → 午前だけの人 → 遅番。
   */
  readonly preferOrder: readonly string[];
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
  /** 同じ業務に複数人必要なときの何人目か。0起点。 */
  readonly index: number;
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
  /** staffId → 日 → その日の在所。半日単位の可否はここだけで決まる。 */
  readonly presence: ReadonlyMap<string, ReadonlyMap<number, DayPresence>>;
  /** taskId → 担当できる staffId。職種の初期値と個人の設定を合わせた結果。 */
  readonly capable: ReadonlyMap<string, ReadonlySet<string>>;
  readonly rules: readonly LearnedRule[];
}

/** ある人のある日の在所。 */
export interface DayPresence {
  readonly code: string;
  readonly am: boolean;
  readonly noon: boolean;
  readonly pm: boolean;
  readonly kind: ShiftKind;
  /** 午前だけ現場にいる。昼担当の優先対象。 */
  readonly amOnly: boolean;
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
  /** 業務ごとの「担当してほしい人」の優先順をどれだけ効かせるか。 */
  readonly weightPreference: number;
  readonly improvementPasses: number;
}

export const DEFAULT_SETTINGS: AssignSettings = {
  weightFairnessTotal: 10.0,
  weightFairnessTask: 20.0,
  weightLearnedRule: 4.0,
  weightPreference: 8.0,
  improvementPasses: 5000,
};

/** 既定の seed。乱数を使わないのは、学習の効果を比較できるようにするため。 */
export const DEFAULT_SEED = 20260912;
