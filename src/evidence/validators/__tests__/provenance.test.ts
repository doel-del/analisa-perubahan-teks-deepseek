import { describe, test, expect } from 'vitest';
import { ProvenanceValidator } from '../provenance';
import type { EvidenceContext } from '../../types';

const context: EvidenceContext = {
  chunkIndex: 0,
  chunkText: 'Segment 1: baterainya habis setelah\nSegment 2: 17 jam 42 menit',
  chunkSegments: [
    { index: 1, start: '00:00:01,000', end: '00:00:02,000', text: 'baterainya habis setelah' },
    { index: 2, start: '00:00:02,000', end: '00:00:03,000', text: '17 jam 42 menit' }
  ]
};

describe('PROVENANCE VALIDATOR', () => {
  test('PASS: single segment', () => {
    const result = ProvenanceValidator.resolve('baterainya habis setelah', null, context);
    expect(result.result.status).toBe('PASS');
    expect(result.coordinates).toEqual({
      chunk_index: 0,
      segment_start_index: 1,
      segment_end_index: 1,
      char_start: null,
      char_end: null
    });
  });

  test('PASS: cross-segment', () => {
    const result = ProvenanceValidator.resolve(
      'baterainya habis setelah 17 jam 42 menit',
      null,
      context
    );
    expect(result.result.status).toBe('PASS');
    expect(result.coordinates).toEqual({
      chunk_index: 0,
      segment_start_index: 1,
      segment_end_index: 2,
      char_start: null,
      char_end: null
    });
  });

  test('FAIL: missing', () => {
    const result = ProvenanceValidator.resolve('tidak ada', null, context);
    expect(result.result.status).toBe('FAIL');
    expect(result.coordinates).toBeNull();
  });

  test('SUSPECT: ambiguous', () => {
    const ambiguousContext: EvidenceContext = {
      chunkIndex: 0,
      chunkText: '6 generasi Android\n6 generasi Android',
      chunkSegments: [
        { index: 1, start: '00:00:01,000', end: '00:00:02,000', text: '6 generasi Android' },
        { index: 2, start: '00:00:02,000', end: '00:00:03,000', text: '6 generasi Android' }
      ]
    };
    const result = ProvenanceValidator.resolve('6 generasi Android', null, ambiguousContext);
    expect(result.result.status).toBe('SUSPECT');
    expect(result.coordinates).toBeNull();
  });
});