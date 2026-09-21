/**
 * 端末内の保存層。
 *
 * データはこの端末のこのブラウザにだけ残る。別端末へはバックアップで移す。
 * 旧版は表計算の行を模していたが、ここでは素直に型付きのひとかたまりを
 * 読み書きする。件数は数千行で、localStorage の上限（約5MB）に収まる。
 *
 * 書き込みは必ず「新しいオブジェクトを作って差し替える」。途中で例外が出ても
 * 壊れかけの状態が残らない。
 */

import type { LearnedRule, ShiftType, Staff, Task } from '../core/types';

const STORAGE_KEY = 'shift-allocator:v2';

/** 履歴の保持上限。端末の保存容量を使い切らないため。 */
const KEEP_RUNS_PER_PERIOD = 8;
const KEEP_CORRECTIONS = 500;

/** 読み取り結果の氏名を職員に結びつける別名。 */
export interface Alias {
  readonly rawText: string;
  readonly staffId: string;
  readonly hitCount: number;
  readonly createdAt: string;
}

/** 確定した勤務日。振り分けの前提になる。 */
export interface ConfirmedShift {
  readonly period: string;
  readonly staffId: string;
  readonly day: number;
  readonly code: string;
}

export interface Run {
  readonly runId: string;
  readonly period: string;
  readonly createdAt: string;
  readonly seed: number;
  readonly cost: number;
  readonly assignments: readonly {
    readonly day: number;
    readonly taskId: string;
    readonly staffId: string;
    readonly origin: 'auto' | 'manual';
  }[];
}

export interface Correction {
  readonly correctionId: string;
  readonly runId: string;
  readonly period: string;
  readonly day: number;
  readonly taskId: string;
  readonly staffBefore: string;
  readonly staffAfter: string;
  /** 手で入れ替えた理由。あとでルールを見直すときの手がかりにする。 */
  readonly reason: string;
  readonly learned: boolean;
  readonly createdAt: string;
}

export interface AppSettings {
  /** 介助業務を担当できる職種。業務マスタの初期値に使う。 */
  readonly careJobs: readonly string[];
  readonly weightFairnessTotal: number;
  readonly weightFairnessTask: number;
  readonly weightLearnedRule: number;
  readonly improvementPasses: number;
  readonly seed: number;
}

export interface Database {
  readonly version: 2;
  readonly staff: readonly Staff[];
  readonly aliases: readonly Alias[];
  readonly tasks: readonly Task[];
  readonly shiftTypes: readonly ShiftType[];
  readonly confirmed: readonly ConfirmedShift[];
  readonly runs: readonly Run[];
  readonly corrections: readonly Correction[];
  readonly rules: readonly LearnedRule[];
  readonly settings: AppSettings;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  careJobs: ['介護職員', '管理者', 'アシスタントスタッフ'],
  weightFairnessTotal: 10.0,
  weightFairnessTask: 20.0,
  weightLearnedRule: 4.0,
  improvementPasses: 5000,
  seed: 20260912,
};

export function emptyDatabase(): Database {
  return {
    version: 2,
    staff: [],
    aliases: [],
    tasks: [],
    shiftTypes: [],
    confirmed: [],
    runs: [],
    corrections: [],
    rules: [],
    settings: DEFAULT_APP_SETTINGS,
  };
}

/** 保存されている形が信用できないので、読むたびに形を整える。 */
function normalize(raw: unknown): Database {
  const base = emptyDatabase();
  if (typeof raw !== 'object' || raw === null) return base;
  const value = raw as Partial<Database>;
  const list = <T,>(v: unknown): readonly T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    version: 2,
    staff: list<Staff>(value.staff),
    aliases: list<Alias>(value.aliases),
    tasks: list<Task>(value.tasks),
    shiftTypes: list<ShiftType>(value.shiftTypes),
    confirmed: list<ConfirmedShift>(value.confirmed),
    runs: list<Run>(value.runs),
    corrections: list<Correction>(value.corrections),
    rules: list<LearnedRule>(value.rules),
    settings: { ...DEFAULT_APP_SETTINGS, ...(value.settings ?? {}) },
  };
}

export function loadDatabase(): Database {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw)) : emptyDatabase();
  } catch (error) {
    console.error('保存データを読めませんでした', error);
    return emptyDatabase();
  }
}

/** 履歴を上限まで間引く。古い実行と古い修正から捨てる。 */
function prune(db: Database): Database {
  const byPeriod = new Map<string, Run[]>();
  for (const run of db.runs) {
    const bucket = byPeriod.get(run.period);
    if (bucket) bucket.push(run);
    else byPeriod.set(run.period, [run]);
  }
  const runs: Run[] = [];
  for (const bucket of byPeriod.values()) {
    bucket.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    runs.push(...bucket.slice(0, KEEP_RUNS_PER_PERIOD));
  }
  return {
    ...db,
    runs,
    corrections: db.corrections.slice(-KEEP_CORRECTIONS),
  };
}

export function saveDatabase(db: Database): void {
  const pruned = prune(db);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned));
  } catch (error) {
    throw new Error(
      '端末の保存容量が足りません。「設定 → データ」でバックアップを書き出してから'
      + `古い履歴を消してください。（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

/** 読んで、変えて、書き戻す。UI からの更新はすべてここを通す。 */
export function updateDatabase(change: (db: Database) => Database): Database {
  const next = change(loadDatabase());
  saveDatabase(next);
  return next;
}

export function exportBackup(db: Database): string {
  return JSON.stringify(db, null, 2);
}

export function importBackup(json: string): Database {
  return normalize(JSON.parse(json));
}

let idCounter = 0;

/** 端末内で一意ならよい。日時と連番で作る。 */
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
