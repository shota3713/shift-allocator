/**
 * 勤務表PDFの読み取り。
 *
 * fixtures/shift-geometry.json は実物のPDFから取った座標データで、氏名と
 * 事業所名だけ差し替えてある。座標・コード・メモは実物のまま残しているので、
 * 折り返しやページまたぎを含めた形の回帰テストになる。
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseShiftTable } from '../src/pdf/shiftTable';
import { splitCodeAndMemo } from '../src/pdf/codeSplit';
import type { PageText } from '../src/pdf/types';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/shift-geometry.json'), 'utf8'),
) as PageText[];

const parsed = parseShiftTable(fixture);
const rowOf = (name: string) => {
  const row = parsed.rows.find((r) => r.name === name);
  if (!row) throw new Error(`テストデータに ${name} がいません`);
  return row;
};
const codeOn = (name: string, day: number) =>
  rowOf(name).cells.find((c) => c.day === day)?.code;
const memoOn = (name: string, day: number) =>
  rowOf(name).cells.find((c) => c.day === day)?.memo;

describe('セル文字列の切り分け', () => {
  it('折り返したコードをつないで切る', () => {
    expect(splitCodeAndMemo('日_032DS')).toEqual({ code: '日_032DS', memo: '', reason: null });
  });

  it('コードの後ろに続く文字はメモにする', () => {
    expect(splitCodeAndMemo('日_032DSイベ')).toEqual({
      code: '日_032DS',
      memo: 'イベ',
      reason: null,
    });
  });

  it('メモ行に食い込んだコードの末尾も拾う', () => {
    expect(splitCodeAndMemo('日/F_032DS営業')).toEqual({
      code: '日/F_032DS',
      memo: '営業',
      reason: null,
    });
  });

  it('コードを持たない値はそのまま通す', () => {
    expect(splitCodeAndMemo('休')).toEqual({ code: '休', memo: '', reason: null });
  });

  it('空のセルは空のまま', () => {
    expect(splitCodeAndMemo('')).toEqual({ code: '', memo: '', reason: null });
  });

  it('形に合わないものは推測せず null を返す', () => {
    const result = splitCodeAndMemo('日_0');
    expect(result.code).toBeNull();
    expect(result.reason).toContain('解釈できない');
  });
});

describe('PDF全体の読み取り', () => {
  it('表題から年月を取る', () => {
    expect(parsed.year).toBe(2026);
    expect(parsed.month).toBe(9);
  });

  it('日付列を1日から月末まで取る', () => {
    expect(parsed.days).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it('ページをまたいで全員を通しで拾う', () => {
    expect(parsed.rows.length).toBe(22);
    expect(parsed.rows.map((r) => r.rowNo)).toEqual(
      Array.from({ length: 22 }, (_, i) => i + 1),
    );
  });

  it('全員ぶん、日数と同じ数のセルがある', () => {
    for (const row of parsed.rows) {
      expect(row.cells.length, row.name).toBe(30);
    }
  });

  it('氏名・職種・チームを列どおりに読む', () => {
    const first = parsed.rows[0]!;
    expect(first.name).toBe('東太郎');
    expect(first.job).toBe('介護職員');
    expect(first.team).toBe('所属なし');
  });

  it('読めなかったセルは1件も無い', () => {
    expect(parsed.unread).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it('曜日をヘッダから取る', () => {
    const cell = parsed.rows[0]!.cells.find((c) => c.day === 1);
    expect(cell?.weekday).toBe('火');
  });

  it('折り返したコードを正しく組み立てる', () => {
    expect(codeOn('東太郎', 2)).toBe('日_032DS');
    expect(codeOn('東太郎', 1)).toBe('休');
  });

  it('コードとメモが同じセルにあっても分けられる', () => {
    expect(codeOn('東太郎', 3)).toBe('日_032DS');
    expect(memoOn('東太郎', 3)).toBe('OJ');
    expect(codeOn('東太郎', 7)).toBe('日/F_032DS');
    expect(memoOn('東太郎', 7)).toBe('営業');
  });

  it('2ページ目の人も同じように読める', () => {
    const last = parsed.rows[parsed.rows.length - 1]!;
    expect(last.name).not.toBe('');
    expect(last.cells.filter((c) => c.code !== null).length).toBe(30);
  });
});
