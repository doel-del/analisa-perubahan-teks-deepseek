import { describe, test, expect } from 'vitest';
import { AtomicityValidator } from '../atomicity';

describe('ATOMICITY VALIDATOR', () => {
  test('PASS: single proposition', () => {
    const result = AtomicityValidator.validate('Refresh rate 120Hz');
    expect(result.status).toBe('PASS');
  });

  test('PASS: configurative compound', () => {
    const result = AtomicityValidator.validate(
      'Samsung Knox lengkap dengan Knox Vault'
    );
    expect(result.status).toBe('PASS');
  });

  test('PASS: camera configuration', () => {
    const result = AtomicityValidator.validate(
      'kamera 50 MP f/1.8 autofocus'
    );
    expect(result.status).toBe('PASS');
  });

  test('SUSPECT: multi-property', () => {
    const result = AtomicityValidator.validate(
      'RAM 8 GB dan storage 256 GB'
    );
    expect(result.status).toBe('SUSPECT');
  });

  test('SUSPECT: two independent facts', () => {
    const result = AtomicityValidator.validate(
      'NFC dan USB OTG'
    );
    expect(result.status).toBe('SUSPECT');
  });
});