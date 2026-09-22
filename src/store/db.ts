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

import { DEFAULT_DIFFICULTY, difficultyFromWeight, isDifficultyLevel } from '../core/difficulty';
import { defaultTasks } from '../core/masters';
import { PRESENCE, readShiftCode } from '../core/shiftCode';
import { migrateSkills, type StaffSkills } from '../core/skills';
import type { LearnedRule, ShiftType, Staff, Task } from '../core/types';

const STORAGE_KEY = 'shift-allocator:v2';

/** 組み込みの業務。古い保存データに足りない項目をここから補う。 */
const BUILT_IN_TASKS = defaultTasks(['介護職員', '管理者', 'アシスタントスタッフ']);

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
    /** 同じ業務に複数人必要なときの何人目か。手修正はこれで枠を特定する。 */
    readonly index: number;
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
  readonly index: number;
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
  /** 業務ごとの「担当してほしい人」の優先順をどれだけ効かせるか。 */
  readonly weightPreference: number;
  readonly improvementPasses: number;
  readonly seed: number;
}

export interface Database {
  readonly version: 2;
  readonly staff: readonly Staff[];
  readonly aliases: readonly Alias[];
  readonly tasks: readonly Task[];
  readonly shiftTypes: readonly ShiftType[];
  /** 誰が何を担当できるか。行が無い人は職種の初期値で判断する。 */
  readonly skills: readonly StaffSkills[];
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
  weightPreference: 8.0,
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
    skills: [],
    confirmed: [],
    runs: [],
    corrections: [],
    rules: [],
    settings: DEFAULT_APP_SETTINGS,
  };
}

/**
 * 勤務区分に午前・午後の在所を補う。
 * 古い保存データはこの2つを持たないので、コードの形から起こす。
 */
function normalizeShiftType(type: ShiftType): ShiftType {
  const parsed = readShiftCode(type.code ?? '');
  const off = type.isWorking === false;
  return {
    ...type,
    aliases: Array.isArray(type.aliases) ? type.aliases : [],
    am: off ? PRESENCE.OFF : type.am ?? parsed.am,
    pm: off ? PRESENCE.OFF : type.pm ?? parsed.pm,
  };
}

/**
 * 業務に、あとから足した項目を補う。
 *
 * 古い保存データは難易度も下限人数も持たない。組み込みの業務は標準の値から
 * 埋め、それ以外は安全側（減らさない・掛け持ちしない）に倒す。
 */
function normalizeTask(task: Task): Task {
  const builtIn = BUILT_IN_TASKS.find((t) => t.taskId === task.taskId);
  const headcount = Math.max(1, Number(task.headcount) || 1);
  const withWeight = task as Task & { weight?: unknown };

  return {
    ...task,
    headcount,
    difficulty: isDifficultyLevel(task.difficulty)
      ? task.difficulty
      : withWeight.weight !== undefined
        ? difficultyFromWeight(withWeight.weight)
        : builtIn?.difficulty ?? DEFAULT_DIFFICULTY,
    minHeadcount: typeof task.minHeadcount === 'number'
      ? Math.min(headcount, Math.max(1, task.minHeadcount))
      : Math.min(headcount, builtIn?.minHeadcount ?? headcount),
    // 掛け持ちの可否・優先順・説明文は画面から触れないので、組み込みの決まりを
    // 正とする。ここを保存データ任せにすると、決まりを直しても古い設定が残る。
    allowSameSlot: builtIn ? builtIn.allowSameSlot : task.allowSameSlot === true,
    avoidWith: builtIn ? builtIn.avoidWith : Array.isArray(task.avoidWith) ? task.avoidWith : [],
    preferOrder: builtIn
      ? builtIn.preferOrder
      : Array.isArray(task.preferOrder) ? task.preferOrder : [],
    note: builtIn ? builtIn.note : task.note ?? '',
    eligibleJob: Array.isArray(task.eligibleJob) ? task.eligibleJob : [],
  };
}

/**
 * 割り当てに「何人目の枠か」を補う。
 * 古い保存データには無く、これが無いと同じ業務の枠を区別できない。
 */
function normalizeRun(run: Run): Run {
  const seen = new Map<string, number>();
  return {
    ...run,
    assignments: (Array.isArray(run.assignments) ? run.assignments : []).map((a) => {
      const key = `${a.day}#${a.taskId}`;
      const next = seen.get(key) ?? 0;
      seen.set(key, next + 1);
      return { ...a, index: typeof a.index === 'number' ? a.index : next };
    }),
  };
}

/** 保存されている形が信用できないので、読むたびに形を整える。 */
function normalize(raw: unknown): Database {
  const base = emptyDatabase();
  if (typeof raw !== 'object' || raw === null) return base;
  const value = raw as Partial<Database>;
  const list = <T,>(v: unknown): readonly T[] => (Array.isArray(v) ? (v as T[]) : []);
  const tasks = list<Task>(value.tasks).map(normalizeTask);
  return {
    version: 2,
    staff: list<Staff>(value.staff),
    aliases: list<Alias>(value.aliases),
    tasks,
    shiftTypes: list<ShiftType>(value.shiftTypes).map(normalizeShiftType),
    skills: migrateSkills(list<StaffSkills>(value.skills), tasks),
    confirmed: list<ConfirmedShift>(value.confirmed),
    runs: list<Run>(value.runs).map(normalizeRun),
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
