import { describe, test, expect } from 'vitest';
import { EvidenceValidator } from '../evidence-validator';
import type { EvidenceContext, EvidenceItem } from '../../types';

// Context untuk test
const context: EvidenceContext = {
  chunkIndex: 0,
  chunkText: 'Refresh rate 120Hz. Baterai 5000 mAh. Kamera 50 MP.',
  chunkSegments: [
    { index: 1, start: '00:00:01,000', end: '00:00:02,000', text: 'Refresh rate 120Hz' },
    { index: 2, start: '00:00:02,000', end: '00:00:03,000', text: 'Baterai 5000 mAh' },
    { index: 3, start: '00:00:03,000', end: '00:00:04,000', text: 'Kamera 50 MP' }
  ]
};

// Context ambiguous untuk grounding/provenance
const ambiguousContext: EvidenceContext = {
  chunkIndex: 0,
  chunkText: '6 generasi Android\n6 generasi Android',
  chunkSegments: [
    { index: 1, start: '00:00:01,000', end: '00:00:02,000', text: '6 generasi Android' },
    { index: 2, start: '00:00:02,000', end: '00:00:03,000', text: '6 generasi Android' }
  ]
};

describe('ACCEPTANCE POLICY MATRIX', () => {

  test('PASS + PASS → VALID', () => {
    const evidence: EvidenceItem = {
      type: 'FACT',
      claim: 'Refresh rate 120Hz',
      source_excerpt: 'Refresh rate 120Hz',
      reviewer_assessment: null,
      value: 120,
      unit: 'Hz'
    };
    const report = EvidenceValidator.validate(evidence, context);
    expect(report.accepted).toBe(true);
    expect(report.finalStatus).toBe('VALID');
    expect(evidence.source_coordinates).not.toBeNull();
  });

  //test('MULTIPLE OCCURRENCE (no anchor) → PROVENANCE SUSPECT → QUARANTINE', () => {
    // Sebelum redesign (Stage 3-6), multiple lexical match ditandai
    // Grounding SUSPECT → quarantine dengan alasan 'GROUNDING'.
    // Setelah redesign, Grounding existence-only: multiple match = PASS.
    // Ambiguitas occurrence ditangani Provenance (Stage 4), dan
    // acceptance policy P0 sekarang men-quarantine karena PROVENANCE
    // SUSPECT (Stage 6). Attribution quarantine berpindah dari
    // GROUNDING ke PROVENANCE.
  test('MULTIPLE OCCURRENCE, excerpt PENDEK (<20 char), no anchor → PROVENANCE SUSPECT MEDIUM → VALID_WITH_NORMALIZATION (N8)', () => {
    // REVISI: excerpt "6 generasi Android" panjangnya 18 karakter,
    // di bawah ambang N8 (provenance.ts). N8 sengaja menurunkan
    // ambiguitas occurrence untuk excerpt pendek ke severity MEDIUM,
    // karena excerpt pendek sering ambigu bukan karena source_excerpt
    // salah, tapi karena memang muncul berulang secara wajar (mis. di
    // beberapa spec serupa). Acceptance policy TIDAK LAGI mengarantina
    // PROVENANCE SUSPECT tanpa syarat severity (lihat evidence-validator.ts
    // langkah 3 yang dihapus) -- perilaku lama di sini membatalkan niat
    // N8 dan sudah diperbaiki.
    const evidence: EvidenceItem = {
      type: 'FACT',
      claim: '6 generasi Android',
      source_excerpt: '6 generasi Android',
      reviewer_assessment: null
    };
    const report = EvidenceValidator.validate(evidence, ambiguousContext);
    //expect(report.accepted).toBe(false);
    //expect(report.finalStatus).toBe('QUARANTINE');
    expect(report.accepted).toBe(true);
    expect(report.finalStatus).toBe('VALID_WITH_NORMALIZATION');
    expect(evidence.source_coordinates).toBeNull();
    //expect(report.quarantineReason).toContain('PROVENANCE');
    const provenance = report.results.find(r => r.rule === 'PROVENANCE');
    expect(provenance?.status).toBe('SUSPECT');
    expect(provenance?.severity).toBe('MEDIUM');
  });

  //test('PROVENANCE SUSPECT → QUARANTINE', () => {
    // Setup ini sama dengan test di atasnya (multiple occurrence + no anchor).
    // Setelah Stage 5, hanya PROVENANCE yang SUSPECT (Grounding existence-only),
    // sehingga attribution quarantine konsisten: PROVENANCE SUSPECT.
    // Test ini menjaga coverage P0 invariant secara langsung.
  test('MULTIPLE OCCURRENCE, excerpt PANJANG (>=20 char), no anchor → PROVENANCE SUSPECT HIGH → QUARANTINE', () => {
    // REVISI: test sebelumnya duplikat persis dengan test di atas
    // (excerpt sama, sama-sama <20 char) sehingga sebenarnya tidak
    // menambah coverage baru. Diganti dengan excerpt >=20 karakter
    // untuk menguji jalur SEBALIKNYA dari N8: excerpt panjang yang
    // ambigu tetap HIGH dan tetap quarantine (invariant P0 yang
    // sebenarnya ingin dijaga test ini).
    const longAmbiguousContext: EvidenceContext = {
      chunkIndex: 0,
      chunkText: 'Jaminan pembaruan 6 generasi Android.\nJaminan pembaruan 6 generasi Android.',
      chunkSegments: [
        { index: 1, start: '00:00:01,000', end: '00:00:02,000', text: 'Jaminan pembaruan 6 generasi Android.' },
        { index: 2, start: '00:00:02,000', end: '00:00:03,000', text: 'Jaminan pembaruan 6 generasi Android.' }
      ]
    };
    const evidence: EvidenceItem = {
      type: 'FACT',
      //claim: '6 generasi Android',
      //source_excerpt: '6 generasi Android',
      claim: 'Jaminan pembaruan 6 generasi Android',
      source_excerpt: 'Jaminan pembaruan 6 generasi Android',
      reviewer_assessment: null
    };
    //const report = EvidenceValidator.validate(evidence, ambiguousContext);
    const report = EvidenceValidator.validate(evidence, longAmbiguousContext);
    expect(report.accepted).toBe(false);
    expect(report.finalStatus).toBe('QUARANTINE');
    expect(evidence.source_coordinates).toBeNull();
    expect(report.quarantineReason).toContain('SUSPECT HIGH');
  });

  test('GROUNDING FAIL → QUARANTINE', () => {
    const evidence: EvidenceItem = {
      type: 'FACT',
      claim: 'Baterai 6000 mAh',
      source_excerpt: 'tidak ada di chunk',
      reviewer_assessment: null
    };
    const report = EvidenceValidator.validate(evidence, context);
    expect(report.accepted).toBe(false);
    expect(report.finalStatus).toBe('QUARANTINE');
    expect(evidence.source_coordinates).toBeNull();
    expect(report.quarantineReason).toContain('GROUNDING');
  });

  test('PROVENANCE FAIL → QUARANTINE', () => {
    const evidence: EvidenceItem = {
      type: 'FACT',
      claim: 'Baterai 6000 mAh',
      source_excerpt: 'tidak ada di chunk',
      reviewer_assessment: null
    };
    const report = EvidenceValidator.validate(evidence, context);
    expect(report.accepted).toBe(false);
    expect(report.finalStatus).toBe('QUARANTINE');
  });

  test('VALUE SUSPECT → VALID_WITH_NORMALIZATION', () => {
    // Simulasi VALUE SUSPECT: numeric ratio yang tidak dikenal
    const evidence: EvidenceItem = {
      type: 'FACT',
      claim: 'Aspect ratio 16/9',
      source_excerpt: 'Aspect ratio 16/9',
      reviewer_assessment: null,
      value: '16/9',
      unit: null
    };
    // Kita perlu context yang punya excerpt ini
    const contextWithRatio: EvidenceContext = {
      chunkIndex: 0,
      chunkText: 'Aspect ratio 16/9',
      chunkSegments: [
        { index: 1, start: '00:00:01,000', end: '00:00:02,000', text: 'Aspect ratio 16/9' }
      ]
    };
    const report = EvidenceValidator.validate(evidence, contextWithRatio);
    // VALUE SUSPECT seharusnya tetap accepted, tapi status VALID_WITH_NORMALIZATION
    expect(report.accepted).toBe(true);
    expect(report.finalStatus).toBe('VALID_WITH_NORMALIZATION');
  });

  test('ATOMICITY SUSPECT HIGH → QUARANTINE', () => {
    // Patch atomicity (E.1–E.4): compound claim dengan strong indicator
    // (" dan ") dinaikkan ke SUSPECT HIGH, sehingga acceptance policy
    // men-quarantine-nya. Perilaku lama (VALID_WITH_NORMALIZATION)
    // sengaja dihapus karena compound claim harus dipaksa dipecah
    // model di iterasi berikutnya, bukan diloloskan sebagai "valid
    // dengan normalisasi".
    const evidence: EvidenceItem = {
      type: 'FACT',
      claim: 'RAM 8 GB dan storage 256 GB',
      source_excerpt: 'RAM 8 GB dan storage 256 GB',
      reviewer_assessment: null
    };
    const contextWithCompound: EvidenceContext = {
      chunkIndex: 0,
      chunkText: 'RAM 8 GB dan storage 256 GB',
      chunkSegments: [
        { index: 1, start: '00:00:01,000', end: '00:00:02,000', text: 'RAM 8 GB dan storage 256 GB' }
      ]
    };
    const report = EvidenceValidator.validate(evidence, contextWithCompound);
    expect(report.accepted).toBe(false);
    expect(report.finalStatus).toBe('QUARANTINE');
    expect(report.quarantineReason).toContain('ATOMICITY');
  });

  test('ASSESSMENT FAIL → QUARANTINE', () => {
    const evidence: EvidenceItem = {
      type: 'FACT',
      claim: 'Refresh rate 120Hz',
      source_excerpt: 'Refresh rate 120Hz',
      reviewer_assessment: 'positive' // FACT tidak boleh punya assessment
    };
    const report = EvidenceValidator.validate(evidence, context);
    expect(report.accepted).toBe(false);
    expect(report.finalStatus).toBe('QUARANTINE');
    expect(report.quarantineReason).toContain('ASSESSMENT');
  });

  test('ATOMICITY: single proposition → VALID', () => {
    const evidence: EvidenceItem = {
      type: 'FACT',
      claim: 'Baterai 5000 mAh',
      source_excerpt: 'Baterai 5000 mAh',
      reviewer_assessment: null,
      value: 5000,
      unit: 'mAh'
    };
    const report = EvidenceValidator.validate(evidence, context);
    expect(report.accepted).toBe(true);
    expect(report.finalStatus).toBe('VALID');
  });

  test('ALL PASS → VALID', () => {
    const evidence: EvidenceItem = {
      type: 'FACT',
      claim: 'Baterai 5000 mAh',
      source_excerpt: 'Baterai 5000 mAh',
      reviewer_assessment: null,
      value: 5000,
      unit: 'mAh'
    };
    const report = EvidenceValidator.validate(evidence, context);
    expect(report.accepted).toBe(true);
    expect(report.finalStatus).toBe('VALID');
    expect(evidence.source_coordinates).not.toBeNull();
  });
});