/**
 * マスタの初期値と、読み取り結果との差分。
 *
 * 名簿と勤務区分は手で作らせない。PDFから起こして、新しく出てきたものだけを
 * 「追加してよいか」と聞く。実名はリポジトリに持たず、端末の保存領域にだけ置く。
 */

import { normalizeName, normalizeText } from './resolve';
import type { DifficultyLevel } from './difficulty';
import { PRESENCE, readShiftCode, type Presence } from './shiftCode';
import { SLOT, type ShiftType, type Staff, type Task } from './types';
import type { ParsedShift } from '../pdf/types';

/** 休みと推定するコード。確認画面で変えられる。 */
const OFF_CODE_HINTS = ['休', '有給', '公休', '特休', '欠勤', '希望休', '有休', '代休', '欠'];

/**
 * 業務の初期値。
 *
 * 職種はあくまで初期値で、最終的な可否は「担当できる人」の設定で決める。
 * ドライバーをどの業務にも入れないのは、送迎の担当を別に決めているため。
 */
export function defaultTasks(careJobs: readonly string[]): Task[] {
  const care = [...careJobs];
  const nurse = '看護職員';
  const careAndNurse = [...care, nurse];
  const lead = 'LEAD';
  const row = (
    taskId: string,
    name: string,
    slot: Task['slot'],
    difficulty: DifficultyLevel,
    headcount: number,
    eligibleJob: readonly string[],
    options: {
      exclusiveGroup?: string;
      preferOrder?: readonly string[];
      minHeadcount?: number;
      allowSameSlot?: boolean;
      avoidWith?: readonly string[];
      note?: string;
    } = {},
  ): Task => ({
    taskId,
    name,
    slot,
    difficulty,
    headcount,
    minHeadcount: options.minHeadcount ?? headcount,
    allowSameSlot: options.allowSameSlot ?? false,
    avoidWith: [...(options.avoidWith ?? [])],
    eligibleJob: [...eligibleJob],
    preferOrder: [...(options.preferOrder ?? [])],
    exclusiveGroup: options.exclusiveGroup ?? '',
    appliesTo: 'all',
    active: true,
    note: options.note ?? '',
  });

  return [
    // 午前は 風呂3（リーダー1＋2）・リハ2・看護1 の計6人。
    // 5人しかいない日はリハを1人に落として 風呂3・リハ1・看護1 にする。
    row('REHA_AM', 'リハ担当', SLOT.AM, 3, 2, care, {
      minHeadcount: 1,
      note: '午前に5人しかいない日は1人に減らします',
    }),
    row('NURSE_AM', '看護師', SLOT.AM, 2, 1, [nurse]),
    row('BATH', '入浴担当', SLOT.AM, 3, 2, care),
    row('BATH_LEAD', '入浴リーダー', SLOT.AM, 4, 1, care, { exclusiveGroup: lead }),
    // 昼は看護師と午前だけの人が基本。いなければ遅番が入る。
    row('NOON', '昼担当', SLOT.NOON, 2, 3, careAndNurse, {
      preferOrder: [`job:${nurse}`, 'amOnly', 'kind:LATE'],
      note: '看護師 → 午前だけの人 → 遅番 の順で当てます',
    }),
    row('RENRAKU', '連絡帳', SLOT.PM, 3, 1, careAndNurse, {
      exclusiveGroup: lead,
      note: '書ける人を「担当できる人」で絞ってください',
    }),
    row('REC_LEAD', 'レクリーダー', SLOT.PM, 4, 1, care, { exclusiveGroup: lead }),
    // 体操は短いので、午後に空いている人がいなければ掛け持ちにする。
    // ただし連絡帳とレクリーダーの人には乗せない。
    row('TAISO', '体操', SLOT.PM, 2, 1, care, {
      allowSameSlot: true,
      avoidWith: ['RENRAKU', 'REC_LEAD'],
      note: '空いている人が優先。いなければ連絡帳・レク以外の人が兼任します',
    }),
    row('REHA_PM', 'PMリハ', SLOT.PM, 3, 1, care),
    row('HANDWORK', '手作業', SLOT.PM, 2, 2, care),
  ];
}

/** 休みを表す組み込みの区分。空欄はここに落ちる。 */
export function defaultShiftTypes(): ShiftType[] {
  return [{
    code: 'OFF',
    label: '休み',
    isWorking: false,
    hours: 0,
    aliases: ['休', '公休', ''],
    am: PRESENCE.OFF,
    pm: PRESENCE.OFF,
  }];
}

export interface NewStaffProposal {
  readonly name: string;
  readonly job: string;
  readonly team: string;
}

export interface JobChangeProposal {
  readonly staffId: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

export interface NewCodeProposal {
  readonly code: string;
  readonly count: number;
  /** 出勤とみなすかの初期値。人が確認して決める。 */
  readonly isWorking: boolean;
  /** 午前・午後それぞれの在所の初期値。 */
  readonly am: Presence;
  readonly pm: Presence;
  /** 初期値の根拠。読み解けなかったときはその旨を出す。 */
  readonly basis: string;
}

export interface MasterChanges {
  readonly newStaff: readonly NewStaffProposal[];
  readonly jobChanges: readonly JobChangeProposal[];
  readonly newCodes: readonly NewCodeProposal[];
}

/** 名簿・勤務区分に無いものを洗い出す。まだ書き込まない。 */
export function planMasterChanges(
  parsed: ParsedShift,
  staff: readonly Staff[],
  aliases: readonly { rawText: string; staffId: string }[],
  shiftTypes: readonly ShiftType[],
): MasterChanges {
  const byName = new Map<string, Staff>();
  for (const s of staff) byName.set(normalizeName(s.name), s);
  const aliasKeys = new Set(aliases.map((a) => normalizeName(a.rawText)));

  const newStaff: NewStaffProposal[] = [];
  const jobChanges: JobChangeProposal[] = [];
  for (const row of parsed.rows) {
    const key = normalizeName(row.name);
    if (!key) continue;
    const known = byName.get(key);
    if (!known && !aliasKeys.has(key)) {
      if (!newStaff.some((n) => normalizeName(n.name) === key)) {
        newStaff.push({ name: row.name, job: row.job, team: row.team });
      }
    } else if (known && row.job && known.job !== row.job) {
      jobChanges.push({ staffId: known.staffId, name: known.name, from: known.job, to: row.job });
    }
  }

  const knownCodes = new Set<string>();
  for (const t of shiftTypes) {
    knownCodes.add(normalizeText(t.code));
    for (const a of t.aliases) if (a) knownCodes.add(normalizeText(a));
  }

  const counts = new Map<string, number>();
  for (const row of parsed.rows) {
    for (const cell of row.cells) {
      const code = (cell.code ?? '').trim();
      if (code === '') continue;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }

  const newCodes: NewCodeProposal[] = [...counts.entries()]
    .filter(([code]) => !knownCodes.has(normalizeText(code)))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([code, count]) => {
      const looksOff = OFF_CODE_HINTS.some((hint) => code === hint || code.startsWith(hint));
      const meaning = readShiftCode(code);
      const am = looksOff ? PRESENCE.OFF : meaning.am;
      const pm = looksOff ? PRESENCE.OFF : meaning.pm;
      return {
        code,
        count,
        isWorking: am === PRESENCE.WORK || pm === PRESENCE.WORK,
        am,
        pm,
        basis: looksOff
          ? '休みを表す語で始まるため'
          : meaning.assumed
            ? `「${meaning.base}」の形が分からないので1日現場と仮定`
            : meaning.label,
      };
    });

  return { newStaff, jobChanges, newCodes };
}

/** 氏名から職員IDを作る。端末内で一意ならよい。 */
export function staffIdFor(name: string, existing: readonly Staff[]): string {
  const base = `st_${normalizeName(name).slice(0, 8)}`;
  let candidate = base;
  let n = 1;
  const used = new Set(existing.map((s) => s.staffId));
  while (used.has(candidate)) {
    n += 1;
    candidate = `${base}_${n}`;
  }
  return candidate;
}
