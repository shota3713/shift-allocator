/**
 * 勤務区分コードの読み解き。
 * 「Fは1日フリー」「スラッシュは半日の区切り」が崩れると、
 * フリーの人にリハ担当が乗る。ここで形を固定する。
 */

import { describe, expect, it } from 'vitest';
import { PRESENCE, SHIFT_KIND, readShiftCode, shiftCodeBase } from '../src/core/shiftCode';

describe('事業所コード', () => {
  it('末尾の _032DS / _032SS を落とす', () => {
    expect(shiftCodeBase('日/F_032DS')).toBe('日/F');
    expect(shiftCodeBase('早_032SS')).toBe('早');
    expect(shiftCodeBase('休')).toBe('休');
  });
});

describe('1日まるごとの勤務', () => {
  it('日勤は午前も午後も現場', () => {
    const meaning = readShiftCode('日_032DS');
    expect(meaning.am).toBe(PRESENCE.WORK);
    expect(meaning.pm).toBe(PRESENCE.WORK);
    expect(meaning.kind).toBe(SHIFT_KIND.DAY);
  });

  it('F は1日フリー。どちらの半日も割り振らない', () => {
    const meaning = readShiftCode('F_032DS');
    expect(meaning.am).toBe(PRESENCE.FREE);
    expect(meaning.pm).toBe(PRESENCE.FREE);
    expect(meaning.kind).toBe(SHIFT_KIND.FREE);
  });

  it('遅番は遅番として見分ける（昼担当の最後の受け皿）', () => {
    expect(readShiftCode('遅_032DS').kind).toBe(SHIFT_KIND.LATE);
  });

  it('清掃は清掃だけの勤務なので、業務は割り振らない', () => {
    const meaning = readShiftCode('清掃_032DS');
    expect(meaning.am).toBe(PRESENCE.FREE);
    expect(meaning.pm).toBe(PRESENCE.FREE);
  });

  it('送迎はドライバー側で決めるので、業務は割り振らない', () => {
    expect(readShiftCode('運F_032DS').am).toBe(PRESENCE.FREE);
    expect(readShiftCode('運/休_032DS').am).toBe(PRESENCE.FREE);
  });
});

describe('スラッシュは1日の半分の区切り', () => {
  it('日/F は午前だけ現場', () => {
    const meaning = readShiftCode('日/F_032DS');
    expect(meaning.am).toBe(PRESENCE.WORK);
    expect(meaning.pm).toBe(PRESENCE.FREE);
    expect(meaning.amOnly).toBe(true);
  });

  it('F/日 は午後だけ現場', () => {
    const meaning = readShiftCode('F/日_032DS');
    expect(meaning.am).toBe(PRESENCE.FREE);
    expect(meaning.pm).toBe(PRESENCE.WORK);
    expect(meaning.pmOnly).toBe(true);
    expect(meaning.amOnly).toBe(false);
  });

  it('早/F は早番で、午前だけ現場', () => {
    const meaning = readShiftCode('早/F_032DS');
    expect(meaning.kind).toBe(SHIFT_KIND.EARLY);
    expect(meaning.amOnly).toBe(true);
  });

  it('休/運 はどちらの半日も現場ではない', () => {
    const meaning = readShiftCode('休/運_032DS');
    expect(meaning.am).toBe(PRESENCE.OFF);
    expect(meaning.pm).toBe(PRESENCE.FREE);
  });
});

describe('休み', () => {
  it('休・有給は休み', () => {
    expect(readShiftCode('休').am).toBe(PRESENCE.OFF);
    expect(readShiftCode('有給').pm).toBe(PRESENCE.OFF);
  });

  it('空欄は休み', () => {
    expect(readShiftCode('').kind).toBe(SHIFT_KIND.OFF);
  });
});

describe('読めない形', () => {
  it('分からないコードは現場ありと仮定し、確認が要ることを示す', () => {
    const meaning = readShiftCode('ZZ_032DS');
    expect(meaning.am).toBe(PRESENCE.WORK);
    expect(meaning.assumed).toBe(true);
  });
});
