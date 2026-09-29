import { describe, expect, test } from 'vitest';
import { buildWeeklySheets } from '../src/core/weekly';
import { SLOT } from '../src/core/types';
import { planFor, staff, task } from './helpers';

// 2026年9月: 1日は火曜、30日は水曜。月曜始まりで5週になる。
const period = '2026-09';

function plan() {
  return planFor({
    period,
    staff: [staff('s1', '佐藤', '介護職員'), staff('s2', '鈴木', '介護職員')],
    tasks: [
      task({ taskId: 'noon', name: '昼担当', slot: SLOT.NOON }),
      task({ taskId: 'bath', name: '入浴', slot: SLOT.AM, headcount: 2 }),
    ],
    days: [1, 2],
  });
}

describe('buildWeeklySheets', () => {
  test('splits the month into Monday-start weeks padded with empty columns', () => {
    const sheets = buildWeeklySheets(plan(), []);

    expect(sheets).toHaveLength(5);
    expect(sheets[0]?.columns.map((c) => c.day)).toEqual([null, 1, 2, 3, 4, 5, 6]);
    expect(sheets[0]?.columns[0]?.weekday).toBe('mon');
    expect(sheets[4]?.columns.map((c) => c.day)).toEqual([28, 29, 30, null, null, null, null]);
  });

  test('orders rows by time slot and lists seats in order', () => {
    const sheets = buildWeeklySheets(plan(), [
      { day: 1, taskId: 'noon', index: 0, staffId: 's1' },
      { day: 1, taskId: 'bath', index: 1, staffId: 's1' },
      { day: 1, taskId: 'bath', index: 0, staffId: 's2' },
    ]);

    const rows = sheets[0]?.rows ?? [];
    expect(rows.map((r) => r.name)).toEqual(['入浴', '昼担当']);
    expect(rows[0]?.cells[1]).toEqual(['鈴木', '佐藤']);
    expect(rows[1]?.cells[1]).toEqual(['佐藤']);
  });

  test('marks unfilled seats with an empty name and days without slots with null', () => {
    const sheets = buildWeeklySheets(plan(), [
      { day: 2, taskId: 'noon', index: 0, staffId: '' },
    ]);

    const row = sheets[0]?.rows[0];
    expect(row?.cells[2]).toEqual(['']);
    expect(row?.cells[1]).toBeNull();
    expect(row?.cells[0]).toBeNull();
  });
});
