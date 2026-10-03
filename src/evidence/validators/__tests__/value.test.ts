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