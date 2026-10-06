import { describe, test, expect } from 'vitest';
import { ValueValidator } from '../value';

describe('VALUE VALIDATOR', () => {
  test('PASS: 1/30 detik', () => {
    const result = ValueValidator.validate('1/30', 'detik');
    expect(result.status).toBe('PASS');
  });

  test('PASS: 1/60 detik', () => {
    const result = ValueValidator.validate('1/60', 'detik');
    expect(result.status).toBe('PASS');
  });

  test('PASS: 4K 30 fps', () => {
    const result = ValueValidator.validate('4K 30 fps', null);
    expect(result.status).toBe('PASS');
  });

  test('PASS: 358', () => {
    const result = ValueValidator.validate('358', 'nits');
    expect(result.status).toBe('PASS');
  });

  test('FAIL: 8/256 GB', () => {
    const result = ValueValidator.validate('8/256', 'GB');
    expect(result.status).toBe('FAIL');
  });

  test('SUSPECT: 3/4 %', () => {
    const result = ValueValidator.validate('3/4', '%');
    expect(result.status).toBe('SUSPECT');
  });

  test('PASS: attribute_value saja tanpa value', () => {
    const result = ValueValidator.validate(null, null, 'protection_type', 'IP67');
    expect(result.status).toBe('PASS');
  });
});

// ------------------------------------------------------------
// Tambahan: desimal koma dan rentang (3 sisa karantina VALUE, replay 15 video)
// ------------------------------------------------------------
// Tiga sisa karantina VALUE dari replay 15 video:
//   "1,5" + jam (desimal koma), "40-50" + cm, "30-35" + % (rentang berunit lain).
describe('VALUE VALIDATOR: desimal koma', () => {
  test.each([['1,5', 'jam'], ['1.5', 'jam'], ['6,7', 'inci'], ['-3,5', 'derajat']])(
    '%s + %s = numerik (PASS)', (v, u) => {
      expect(ValueValidator.validate(v, u).status).toBe('PASS');
    });
  test('non-numerik tetap SUSPECT HIGH', () => {
    const r = ValueValidator.validate('abc', 'jam');
    expect(r.status).toBe('SUSPECT');
    expect(r.severity).toBe('HIGH');
  });
  test('"1,5,2" bukan angka tunggal', () => {
    expect(ValueValidator.validate('1,5,2', 'jam').status).toBe('SUSPECT');
  });
});

describe('VALUE VALIDATOR: rentang untuk satuan apa pun kecuali penyimpanan', () => {
  test.each([['40-50', 'cm'], ['30-35', '%'], ['40–50', 'cm'], ['30 - 45', 'fps'], ['1,5-2', 'jam'], ['3-4', 'juta']])(
    '"%s" + %s = rentang (PASS)', (v, u) => {
      expect(ValueValidator.validate(v, u).status).toBe('PASS');
    });
  test.each([['8-256', 'gb'], ['8-256', 'GB'], ['4-64', 'mb'], ['1-2', 'tb']])(
    '"%s" + %s tetap ditolak (kemungkinan dua spek)', (v, u) => {
      const r = ValueValidator.validate(v, u);
      expect(r.status).toBe('SUSPECT');
      expect(r.severity).toBe('HIGH');
    });
  test('compound slash "8/256" + gb tetap FAIL', () => {
    expect(ValueValidator.validate('8/256', 'gb').status).toBe('FAIL');
  });
  test('rentang tanpa unit tidak diperiksa (PASS seperti sebelumnya)', () => {
    expect(ValueValidator.validate('40-50', '').status).toBe('PASS');
  });
});
