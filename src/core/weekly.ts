/**
 * 割り振りの結果を、週ごとの表に組み直す。PDFに書き出すときの形。
 *
 * 紙で貼り出すと「今週だれが何か」を横に見たい。日ごとのカードを
 * そのまま並べると1か月で何十ページにもなるので、1週1ページの
 * 「業務 × 曜日」の表にする。週は月曜始まり。月の外の日は空の列で埋めて、
 * どの週も同じ位置に同じ曜日が来るようにする。
 */

import { deriveAssignments } from './derived';
import { weekdayOf } from './plan';
import { SHIFT_KIND_LABELS, type ShiftKind } from './shiftCode';
import {
  SLOT_ORDER,
  type AttendanceEntry,
  type Plan,
  type Slot,
  type TaskDerive,
  type WeekdayKey,
} from './types';

export const WEEK_START: WeekdayKey = 'mon';
const WEEK_ORDER: readonly WeekdayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export interface WeeklyAssignment {
  readonly day: number;
  readonly taskId: string;
  readonly index: number;
  readonly staffId: string;
}

export interface WeekColumn {
  /** 月の外なら null。 */
  readonly day: number | null;
  readonly weekday: WeekdayKey;
}

export interface WeekRow {
  readonly taskId: string;
  readonly name: string;
  readonly slot: Slot;
  /** ほかの結果から決まる業務か。洗面のように人数が多い欄は詰めて並べる。 */
  readonly derive: TaskDerive;
  /**
   * 列ごとの担当者名。何人目の順。
   * null はその日に枠がない（休業日・対象外の曜日）。空文字は埋まらなかった枠。
   */
  readonly cells: readonly (readonly string[] | null)[];
}

/** 出勤の欄の1人ぶん。 */
export interface AttendanceCell {
  readonly name: string;
  readonly startTime: string;
  readonly status: AttendanceEntry['status'];
  readonly role: string;
}

/** 出勤の欄の1行。勤務区分（早番・日勤・遅番…）ごとに分ける。 */
export interface AttendanceRow {
  /** 'ABSENT' は予定はあったが当日いない人。 */
  readonly kind: ShiftKind | 'ABSENT';
  readonly label: string;
  /** 月の外は null。 */
  readonly cells: readonly (readonly AttendanceCell[] | null)[];
}

export interface WeekSheet {
  readonly columns: readonly WeekColumn[];
  /** 誰が何時から来るか。勤務区分ごとの行。 */
  readonly attendance: readonly AttendanceRow[];
  readonly rows: readonly WeekRow[];
  /** 列ごとの備考。月の外は null、書いていない日は空文字。 */
  readonly notes: readonly (string | null)[];
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function weekColumns(year: number, month: number): WeekColumn[][] {
  const last = daysInMonth(year, month);
  const lead = WEEK_ORDER.indexOf(weekdayOf(year, month, 1));
  const cells: (number | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: last }, (_, i) => i + 1),
  ];
  const weeks: WeekColumn[][] = [];
  for (let start = 0; start < cells.length; start += 7) {
    weeks.push(WEEK_ORDER.map((weekday, i) => ({ day: cells[start + i] ?? null, weekday })));
  }
  return weeks;
}

/** 出勤の行の並び。早く来る区分から。SSヘルプと当日いない人は下にまとめる。 */
const ATTENDANCE_ORDER: readonly (ShiftKind | 'ABSENT')[] = [
  'EARLY', 'NURSE', 'DAY', 'AM_ONLY', 'PM_ONLY', 'LATE', 'FREE', 'SS_HELP', 'ABSENT',
];

function attendanceKind(entry: AttendanceEntry): ShiftKind | 'ABSENT' {
  return entry.status === 'absent' ? 'ABSENT' : entry.kind;
}

/** その週に1人でもいる区分だけ行にする。空の行が並ぶと紙が足りなくなる。 */
function buildAttendanceRows(plan: Plan, columns: readonly WeekColumn[]): AttendanceRow[] {
  const inWeek = columns.flatMap((c) => (c.day === null ? [] : plan.attendance.get(c.day) ?? []));
  const kinds = new Set(inWeek.map(attendanceKind));
  return ATTENDANCE_ORDER.filter((kind) => kinds.has(kind)).map((kind) => ({
    kind,
    // 勤務区分のフリー（F）は、業務の「午前フリー・午後フリー」と取り違えやすいので言い分ける。
    label: kind === 'ABSENT' ? '当日不在' : kind === 'FREE' ? 'フリー勤務' : SHIFT_KIND_LABELS[kind],
    cells: columns.map((column) => {
      if (column.day === null) return null;
      return (plan.attendance.get(column.day) ?? [])
        .filter((entry) => attendanceKind(entry) === kind)
        .map((entry) => ({
          name: entry.name,
          startTime: entry.startTime,
          status: entry.status,
          role: entry.role,
        }));
    }),
  }));
}

/** 結果に出てくる業務を、時間帯 → 設定の並び順で並べる。 */
function orderedTaskIds(plan: Plan, assignments: readonly WeeklyAssignment[]): string[] {
  const present = new Set(assignments.map((a) => a.taskId));
  const known = plan.taskOrder.filter((id) => present.has(id));
  const unknown = [...present].filter((id) => !plan.tasksById.has(id)).sort();
  const slotRank = (id: string): number => SLOT_ORDER.indexOf(plan.tasksById.get(id)?.slot ?? 'PM');
  return [...known, ...unknown]
    .map((id, order) => ({ id, order }))
    .sort((a, b) => slotRank(a.id) - slotRank(b.id) || a.order - b.order)
    .map((entry) => entry.id);
}

export function buildWeeklySheets(
  plan: Plan,
  assignments: readonly WeeklyAssignment[],
  notes: ReadonlyMap<number, string> = new Map(),
): WeekSheet[] {
  // 朝の連絡帳・洗面・夕方清掃は、割り振りの結果からその場で起こす。
  const all = [...assignments, ...deriveAssignments(plan, assignments)];
  const byCell = new Map<string, WeeklyAssignment[]>();
  for (const a of all) {
    const key = `${a.taskId}#${a.day}`;
    byCell.set(key, [...(byCell.get(key) ?? []), a]);
  }

  const taskIds = orderedTaskIds(plan, all);

  return weekColumns(plan.year, plan.month).map((columns) => ({
    columns,
    attendance: buildAttendanceRows(plan, columns),
    rows: taskIds.map((taskId) => {
      const task = plan.tasksById.get(taskId);
      return {
        taskId,
        name: task?.name ?? taskId,
        slot: task?.slot ?? 'PM',
        derive: task?.derive ?? '',
        cells: columns.map((column) => {
          if (column.day === null) return null;
          const seats = byCell.get(`${taskId}#${column.day}`);
          if (!seats) return null;
          return [...seats]
            .sort((a, b) => a.index - b.index)
            .map((a) => (a.staffId ? plan.staffNames.get(a.staffId) ?? a.staffId : ''));
        }),
      };
    }),
    notes: columns.map((column) => (column.day === null ? null : notes.get(column.day) ?? '')),
  }));
}
