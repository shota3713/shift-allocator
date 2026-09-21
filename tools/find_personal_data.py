#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
公開前チェック。リポジトリ内に実名・事業所名・原本PDFが残っていないか探す。

    python tools/find_personal_data.py         # フォルダ全体
    python tools/find_personal_data.py --git   # コミット対象だけ

照合に使う語は local/real/parsed-*.json（非公開）の氏名と、
local/real/terms.txt（非公開・1行1語。事業所名など）から読む。
.gitignore で除外しているファイルも含めて表示するので、除外済みかどうかは
git check-ignore で別途確かめること。
"""

import glob
import io
import json
import os
import sys

SKIP_DIRS = {'.git', 'node_modules'}


def load_terms():
    terms = set()
    extra = os.path.join('local', 'real', 'terms.txt')
    if os.path.exists(extra):
        with io.open(extra, encoding='utf-8') as f:
            terms.update(line.strip() for line in f if line.strip())
    for path in glob.glob(os.path.join('local', 'real', 'parsed-*.json')):
        with io.open(path, encoding='utf-8') as f:
            for row in json.load(f).get('rows', []):
                name = (row.get('raw_name') or '').strip()
                if name:
                    terms.add(name)
                    if len(name) >= 3:
                        terms.add(name[:2])  # 姓の目安
    return sorted(terms, key=len, reverse=True)


def candidate_files():
    """--git なら、コミット対象（追跡中＋未追跡で除外されていないもの）だけを返す。"""
    if '--git' in sys.argv:
        import subprocess
        out = subprocess.run(
            ['git', 'ls-files', '--cached', '--others', '--exclude-standard'],
            capture_output=True, text=True, encoding='utf-8', check=True,
        ).stdout
        return [line.strip() for line in out.splitlines() if line.strip()]

    paths = []
    for root, dirs, files in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            paths.append(os.path.join(root, name).replace(os.sep, '/'))
    return paths


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    terms = load_terms()
    if not terms:
        print('local/real に照合用のデータがありません。')
        return

    hits = 0
    for path in candidate_files():
        if path.lower().endswith('.pdf'):
            print('  %-44s (PDF)' % path)
            hits += 1
            continue
        try:
            with io.open(path, encoding='utf-8') as f:
                text = f.read()
        except (UnicodeDecodeError, OSError):
            continue
        found = [t for t in terms if t in text]
        if found:
            hits += 1
            print('  %-44s %s' % (path, '、'.join(found[:6]) + (' …' if len(found) > 6 else '')))

    print('\n該当 %d ファイル' % hits)


if __name__ == '__main__':
    main()
