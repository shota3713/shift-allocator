/**
 * 割り振りの結果を、週ごとの表に組み直す。PDFに書き出すときの形。
 *
 * 紙で貼り出すと「今週だれが何か」を横に見たい。日ごとのカードを
 * そのまま並べると1か月で何十ページにもなるので、1週1ページの
 * 「業務 × 曜日」の表にする。週は月曜始まり。月の外の日は空の列で埋めて、
 * どの週も同じ位置に同じ曜日が来るようにする。
 */

import { weekdayOf } from './plan';
import { SLOT_ORDER, type Plan, type Slot, type WeekdayKey } from './types';

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
  /**
   * 列ごとの担当者名。何人目の順。
   * null はその日に枠がない（休業日・対象外の曜日）。空文字は埋まらなかった枠。
   */
  readonly cells: readonly (readonly string[] | null)[];
}

export interface WeekSheet {
  readonly columns: readonly WeekColumn[];
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

/** 結果に出てくる業務を、時間帯 → 設定の並び順で並べる。 */
function orderedTaskIds(plan: Plan, assignments: readonly WeeklyAssignment[]): string[] {
  const present = new Set(assignments.map((a) => a.taskId));
  const known = plan.tasks.map((t) => t.taskId).filter((id) => present.has(id));
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
  const byCell = new Map<string, WeeklyAssignment[]>();
  for (const a of assignments) {
    const key = `${a.taskId}#${a.day}`;
    byCell.set(key, [...(byCell.get(key) ?? []), a]);
  }

  const taskIds = orderedTaskIds(plan, assignments);

  return weekColumns(plan.year, plan.month).map((columns) => ({
    columns,
    rows: taskIds.map((taskId) => {
      const task = plan.tasksById.get(taskId);
      return {
        taskId,
        name: task?.name ?? taskId,
        slot: task?.slot ?? 'PM',
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
