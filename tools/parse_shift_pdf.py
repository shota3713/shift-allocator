#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
勤務（予定）表PDF を Gem と同じスキーマの JSON に変換する。

この帳票はテキストレイヤ付きで罫線も明示されているため、OCRも推論も不要で
決定論的に読み取れる。Gem の出力を検証する基準（ground truth）としても使う。

    python tools/parse_shift_pdf.py <PDF> [-o out.json]

注意: セル内で長いコードが折り返し、続きが下のメモ行の先頭に食い込む。
      例）人物行 "早/F_032" ＋ メモ行 "DSイベ" → コード "早/F_032DS" ＋ メモ "イベ"
      コード末尾が _032DS / _032SS で終わる規則を使って機械的に切り分ける。
"""

import argparse
import json
import re
import sys

import pdfplumber

# 勤務区分コードの形。末尾の事業所コードで区切れることを利用する。
CODE_PATTERN = re.compile(r'^(.+?_\d{3}(?:DS|SS))(.*)$')

# コードを持たない、そのまま意味を成す値。
PLAIN_VALUES = {'休', '有給', '特休', '欠勤', ''}

NAME_COL, JOB_COL, TEAM_COL = 1, 2, 0
FIRST_DAY_COL = 3


def extract_tables(path):
    """全ページの表をセル文字列の二次元配列で返す。"""
    tables = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            for table in page.find_tables():
                tables.append([
                    [(cell or '').replace('\n', '').strip() for cell in row]
                    for row in table.extract()
                ])
    return tables


def split_code_and_memo(main_cell, sub_cell):
    """人物行とメモ行のセルから、勤務区分コードと業務メモを分離する。

    戻り値 (code, memo, warning)。code が None なら解釈できなかった。
    """
    if main_cell in PLAIN_VALUES:
        return main_cell, sub_cell, None

    joined = main_cell + sub_cell
    matched = CODE_PATTERN.match(joined)
    if matched:
        return matched.group(1), matched.group(2), None

    # 折返しの続きが欠けている等。推測せず警告して返す。
    return None, sub_cell, f'コードとして解釈できない: {joined!r}'


def parse_days(header_rows):
    """ヘッダから日付と曜日を取る。"""
    days, weekdays = [], []
    for col in range(FIRST_DAY_COL, len(header_rows[0])):
        raw_day = header_rows[0][col]
        days.append(int(raw_day) if raw_day.isdigit() else None)
        weekdays.append(header_rows[1][col] if len(header_rows) > 1 else '')
    return days, weekdays


def parse(path, year, month):
    tables = extract_tables(path)
    if not tables:
        raise SystemExit('表が見つかりません。')

    days, weekdays = parse_days(tables[0][:2])
    rows, warnings, unread = [], [], []
    row_no = 0

    for table in tables:
        for r, row in enumerate(table):
            name = row[NAME_COL] if len(row) > NAME_COL else ''
            if not name or name == '氏名':
                continue

            row_no += 1
            sub = table[r + 1] if r + 1 < len(table) else [''] * len(row)
            cells = []

            for i, col in enumerate(range(FIRST_DAY_COL, len(row))):
                day = days[i] if i < len(days) else None
                if day is None:
                    continue

                main_cell = row[col]
                sub_cell = sub[col] if col < len(sub) else ''
                code, memo, warning = split_code_and_memo(main_cell, sub_cell)

                if warning:
                    warnings.append(f'{name} {day}日: {warning}')
                    unread.append({'row_no': row_no, 'raw_name': name,
                                   'day': day, 'reason': warning})

                cells.append({
                    'day': day,
                    'raw': code,
                    'snippet': (main_cell + '|' + sub_cell) if sub_cell else main_cell,
                    'confidence': 'high' if code is not None else 'low',
                    'memo': memo or '',
                    'weekday': weekdays[i] if i < len(weekdays) else '',
                })

            rows.append({
                'row_no': row_no,
                'raw_name': name,
                'team': row[TEAM_COL],
                'job': row[JOB_COL],
                'cells': cells,
                'stated_total': None,
            })

    return {
        'doc_type': 'shift',
        'period': {'year': year, 'month': month},
        'period_confidence': 'high',
        'source': 'deterministic-pdf-parse',
        'rows': rows,
        'unread': unread,
        'warnings': warnings,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf')
    ap.add_argument('-o', '--out')
    ap.add_argument('--year', type=int, required=True)
    ap.add_argument('--month', type=int, required=True)
    args = ap.parse_args()

    data = parse(args.pdf, args.year, args.month)
    text = json.dumps(data, ensure_ascii=False, indent=2)

    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(text)
        cells = sum(len(r['cells']) for r in data['rows'])
        print(f"{len(data['rows'])}人 / {cells}セル → {args.out}")
        if data['warnings']:
            print(f"警告 {len(data['warnings'])}件")
            for w in data['warnings'][:10]:
                print('  ' + w)
    else:
        sys.stdout.reconfigure(encoding='utf-8')
        print(text)


if __name__ == '__main__':
    main()
