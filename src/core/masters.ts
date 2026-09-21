/**
 * マスタの初期値と、読み取り結果との差分。
 *
 * 名簿と勤務区分は手で作らせない。PDFから起こして、新しく出てきたものだけを
 * 「追加してよいか」と聞く。実名はリポジトリに持たず、端末の保存領域にだけ置く。
 */

import { normalizeName, normalizeText } from './resolve';
import { SLOT, type ShiftType, type Staff, type Task } from './types';
import type { ParsedShift } from '../pdf/types';

/** 休みと推定するコード。確認画面で変えられる。 */
const OFF_CODE_HINTS = ['休', '有給', '公休', '特休', '欠勤', '希望休', '有休', '代休', '欠'];

/** 業務の初期値。担当者を限定する業務（連絡帳）は設定画面で指定させる。 */
export function defaultTasks(careJobs: readonly string[]): Task[] {
  const care = [...careJobs];
  const lead = 'LEAD';
  const row = (
    taskId: string,
    name: string,
    slot: Task['slot'],
    weight: number,
    headcount: number,
    eligibleJob: readonly string[],
    exclusiveGroup = '',
    note = '',
  ): Task => ({
    taskId,
    name,
    slot,
    weight,
    headcount,
    eligibleJob: [...eligibleJob],
    eligibleStaff: [],
    exclusiveGroup,
    appliesTo: 'all',
    active: true,
    note,
  });

  return [
    row('REHA_AM', 'リハ担当', SLOT.AM, 1.5, 2, care),
    row('NURSE_AM', '看護師', SLOT.AM, 1.0, 1, ['看護職員']),
    row('BATH', '入浴担当', SLOT.AM, 1.5, 2, care),
    row('BATH_LEAD', '入浴リーダー', SLOT.AM, 2.0, 1, care, lead),
    row('NOON', '昼担当', SLOT.NOON, 1.0, 3, care),
    row('RENRAKU', '連絡帳', SLOT.PM, 1.5, 1, [], lead, '担当できる人を指定してください'),
    row('REC_LEAD', 'レクリーダー', SLOT.PM, 2.0, 1, care, lead),
    row('TAISO', '体操', SLOT.PM, 1.0, 1, care),
    row('REHA_PM', 'PMリハ', SLOT.PM, 1.5, 1, care),
  ];
}

/** 休みを表す組み込みの区分。空欄はここに落ちる。 */
export function defaultShiftTypes(): ShiftType[] {
  return [{ code: 'OFF', label: '休み', isWorking: false, hours: 0, aliases: ['休', '公休', ''] }];
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
  /** 初期値の根拠。AI が判断したときはその旨を出す。 */
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
      return {
        code,
        count,
        isWorking: !looksOff,
        basis: looksOff ? '休みを表す語で始まるため' : '出勤とみなす形のため',
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
