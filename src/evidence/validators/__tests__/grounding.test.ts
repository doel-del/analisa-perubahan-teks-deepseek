import { describe, test, expect } from 'vitest';
import { GroundingValidator } from '../grounding';
import type { EvidenceContext } from '../../types';

const context: EvidenceContext = {
  chunkIndex: 0,
  chunkText: 'Segment 1: baterainya habis setelah\nSegment 2: 17 jam 42 menit',
  chunkSegments: [
    { index: 1, start: '00:00:01,000', end: '00:00:02,000', text: 'baterainya habis setelah' },
    { index: 2, start: '00:00:02,000', end: '00:00:03,000', text: '17 jam 42 menit' }
  ]
};

describe('GROUNDING VALIDATOR', () => {
  test('PASS: exact occurrence', () => {
    const result = GroundingValidator.validate('baterainya habis setelah', context);
    expect(result.status).toBe('PASS');
    expect(result.pass).toBe(true);
  });

  test('PASS: cross-segment occurrence', () => {
    const result = GroundingValidator.validate(
      'baterainya habis setelah 17 jam 42 menit',
      context
    );
    expect(result.status).toBe('PASS');
  });

  test('FAIL: missing occurrence', () => {
    const result = GroundingValidator.validate('tidak ada kalimat ini', context);
    expect(result.status).toBe('FAIL');
    expect(result.severity).toBe('CRITICAL');
  });

  test('PASS: duplicate occurrence (existence-only pasca Stage 5)', () => {
    // Kontrak Grounding saat ini: 0 occurrence → FAIL, ≥1 occurrence → PASS.
    // Duplicate occurrence BUKAN lagi SUSPECT di Grounding -- ambiguitas
    // occurrence adalah tanggung jawab Provenance (Stage 5 existence-only).
    // Lihat juga parallel-device-spec-ambiguity.test.ts Bagian A.
    const ambiguousContext: EvidenceContext = {
      chunkIndex: 0,
      chunkText: '6 generasi Android\n6 generasi Android',
      chunkSegments: [
        { index: 1, start: '00:00:01,000', end: '00:00:02,000', text: '6 generasi Android' },
        { index: 2, start: '00:00:02,000', end: '00:00:03,000', text: '6 generasi Android' }
      ]
    };
    const result = GroundingValidator.validate('6 generasi Android', ambiguousContext);
    expect(result.status).toBe('PASS');
    expect(result.severity).toBe('LOW');
  });
});