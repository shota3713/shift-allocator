/**
 * 読み取り結果を確定データに変える。
 *
 * 決定論パーサが読めたものは、そのまま信用してよい。ここで止めるのは
 * 「名簿に無い人」「登録の無い勤務区分」「読み取れなかったセル」の3つだけ。
 * 1つでも残っていれば確定させない。埋めてしまうと、誰も気づかないまま
 * 出勤していない日に業務が割り当たる。
 */

import { FLAG, buildResolveContext, resolveName, resolveShiftValue, type Flag } from './resolve';
import type { ShiftType, Staff } from './types';
import type { Database, ConfirmedShift } from '../store/db';
import type { ParsedShift } from '../pdf/types';

export interface ReviewCell {
  readonly day: number;
  readonly weekday: string;
  readonly raw: string;
  readonly code: string | null;
  readonly memo: string;
  readonly flag: Flag;
  readonly reason: string;
}

export interface ReviewRow {
  readonly rowNo: number;
  readonly rawName: string;
  readonly staffId: string | null;
  readonly job: string;
  readonly nameFlag: Flag;
  readonly nameReason: string;
  readonly candidates: readonly { staffId: string; name: string; score: number }[];
  readonly cells: readonly ReviewCell[];
}

export interface ImportReview {
  readonly periodKey: string;
  readonly year: number | null;
  readonly month: number | null;
  readonly days: readonly number[];
  readonly rows: readonly ReviewRow[];
  /** 未解決の件数。0 になるまで確定できない。 */
  readonly blockCount: number;
  readonly reviewCount: number;
  readonly warnings: readonly string[];
}

export function periodKeyOf(year: number | null, month: number | null): string {
  if (year === null || month === null) return '';
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** 読み取り結果を、確認画面がそのまま描ける形にする。 */
export function buildImportReview(parsed: ParsedShift, db: Database): ImportReview {
  const context = buildResolveContext(db.staff, db.aliases, db.shiftTypes);

  const rows: ReviewRow[] = parsed.rows.map((row) => {
    const name = resolveName(row.name, context);
    const cells: ReviewCell[] = row.cells.map((cell) => {
      if (cell.code === null) {
        return {
          day: cell.day,
          weekday: cell.weekday,
          raw: cell.raw,
          code: null,
          memo: cell.memo,
          flag: FLAG.BLOCK,
          reason: 'この欄を読み取れませんでした。原本を見て入力してください',
        };
      }
      const resolved = resolveShiftValue(cell.code, context);
      return {
        day: cell.day,
        weekday: cell.weekday,
        raw: cell.raw,
        code: resolved.code,
        memo: cell.memo,
        flag: resolved.flag,
        reason: resolved.reason,
      };
    });

    return {
      rowNo: row.rowNo,
      rawName: row.name,
      staffId: name.staffId,
      job: row.job,
      nameFlag: name.flag,
      nameReason: name.reason,
      candidates: name.candidates.map((c) => ({
        staffId: c.staff.staffId,
        name: c.staff.name,
        score: c.score,
      })),
      cells,
    };
  });

  let blockCount = 0;
  let reviewCount = 0;
  for (const row of rows) {
    if (row.nameFlag === FLAG.BLOCK) blockCount += 1;
    if (row.nameFlag === FLAG.REVIEW) reviewCount += 1;
    for (const cell of row.cells) {
      if (cell.flag === FLAG.BLOCK) blockCount += 1;
      if (cell.flag === FLAG.REVIEW) reviewCount += 1;
    }
  }

  return {
    periodKey: periodKeyOf(parsed.year, parsed.month),
    year: parsed.year,
    month: parsed.month,
    days: parsed.days,
    rows,
    blockCount,
    reviewCount,
    warnings: parsed.warnings,
  };
}

function recount(review: ImportReview, rows: readonly ReviewRow[]): ImportReview {
  let blockCount = 0;
  let reviewCount = 0;
  for (const row of rows) {
    if (row.nameFlag === FLAG.BLOCK) blockCount += 1;
    if (row.nameFlag === FLAG.REVIEW) reviewCount += 1;
    for (const cell of row.cells) {
      if (cell.flag === FLAG.BLOCK) blockCount += 1;
      if (cell.flag === FLAG.REVIEW) reviewCount += 1;
    }
  }
  return { ...review, rows, blockCount, reviewCount };
}

/** 確認画面でセルを直す。直した時点で未解決から外れる。 */
export function applyCellFix(
  review: ImportReview,
  rowNo: number,
  day: number,
  code: string,
): ImportReview {
  return recount(
    review,
    review.rows.map((row) => {
      if (row.rowNo !== rowNo) return row;
      return {
        ...row,
        cells: row.cells.map((cell) =>
          cell.day === day
            ? { ...cell, code, flag: FLAG.OK, reason: '手で入力しました' }
            : cell,
        ),
      };
    }),
  );
}

/** 確認画面で氏名を職員に結びつける。 */
export function applyNameFix(
  review: ImportReview,
  rowNo: number,
  staffId: string,
): ImportReview {
  return recount(
    review,
    review.rows.map((row) =>
      row.rowNo === rowNo
        ? { ...row, staffId, nameFlag: FLAG.OK, nameReason: '手で選びました' }
        : row,
    ),
  );
}

/** 名簿に職員を足す。既にいる人は触らない。 */
export function addStaff(db: Database, additions: readonly Staff[]): Database {
  const known = new Set(db.staff.map((s) => s.staffId));
  return { ...db, staff: [...db.staff, ...additions.filter((s) => !known.has(s.staffId))] };
}

/** 勤務区分を足す・更新する。 */
export function upsertShiftTypes(db: Database, types: readonly ShiftType[]): Database {
  const next = [...db.shiftTypes];
  for (const type of types) {
    const index = next.findIndex((t) => t.code === type.code);
    if (index >= 0) next[index] = type;
    else next.push(type);
  }
  return { ...db, shiftTypes: next };
}

/**
 * 確認済みの内容を確定させる。同じ月の既存データは置き換える。
 * 未解決が残っていれば何も書かずに例外を投げる。
 */
export function commitImport(db: Database, review: ImportReview): Database {
  if (review.blockCount > 0) {
    throw new Error(`未解決が ${review.blockCount} 件あります。すべて直してから確定してください。`);
  }
  if (!review.periodKey) {
    throw new Error('対象の年月が分かりません。PDFの表題を確認してください。');
  }

  const confirmed: ConfirmedShift[] = [];
  for (const row of review.rows) {
    if (!row.staffId) continue;
    for (const cell of row.cells) {
      if (cell.code === null) continue;
      confirmed.push({
        period: review.periodKey,
        staffId: row.staffId,
        day: cell.day,
        code: cell.code,
      });
    }
  }

  return {
    ...db,
    confirmed: [...db.confirmed.filter((c) => c.period !== review.periodKey), ...confirmed],
  };
}
