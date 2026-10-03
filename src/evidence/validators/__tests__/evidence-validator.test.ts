import { describe, test, expect } from 'vitest';
import { EvidenceValidator } from '../evidence-validator';
import type { EvidenceContext, EvidenceItem } from '../../types';

// ============================================================
// TEST DATA — 5 EVIDENCE TANPA COORDINATES (E053, E054, E055, E062, E064)
// ============================================================

// Context yang mensimulasikan chunk dengan kedua kemunculan source_excerpt
const chunkSegmentsAmbiguous = [
  // Segment 96 — untuk kamera selfie
  {
    index: 96,
    start: '00:05:15,569',
    end: '00:05:20,569',
    text: 'Ini adalah kamera selfie 13 MP, bukaan f/2.2, fixed focus.'
  },
  // Segment 97 — untuk perekaman video selfie
  {
    index: 97,
    start: '00:05:20,569',
    end: '00:05:24,129',
    text: 'Perekaman videonya up to 1080p 30 fps.'
  },
  // Segment 101 — untuk kamera ultrawide
  {
    index: 101,
    start: '00:05:35,089',
    end: '00:05:40,050',
    text: 'Kemudian untuk kamera berikutnya ada kamera ultrawide 8 MP, bukaan f/2.2.'
  },
  // Segment 102 — untuk perekaman video ultrawide
  {
    index: 102,
    start: '00:05:40,050',
    end: '00:05:44,370',
    text: 'Ini fixed focus juga ya, perekaman videonya up to 1080p 30 fps.'
  }
];

const ambiguousContext: EvidenceContext = {
  chunkIndex: 0,
  chunkText: chunkSegmentsAmbiguous.map(s => s.text).join('\n'),
  chunkSegments: chunkSegmentsAmbiguous
};

describe('EVIDENCE VALIDATOR — 5 evidence tanpa coordinates', () => {

  // ============================================================
  // E053 — Bukaan lensa kamera selfie f/2.2
  // ============================================================
  test('E053: bukaan f/2.2 (selfie), excerpt PENDEK (<20 char) → ambiguous → diselamatkan N8 → VALID_WITH_NORMALIZATION', () => {
    // REVISI: excerpt "bukaan f/2.2" panjangnya 12 karakter, di bawah
    // ambang N8 (provenance.ts). N8 sengaja menurunkan ambiguitas
    // occurrence untuk excerpt pendek ke severity MEDIUM, dan acceptance
    // policy tidak lagi mengarantina PROVENANCE SUSPECT tanpa syarat
    // severity (lihat evidence-validator.ts, langkah 3 yang dihapus).
    // Perilaku lama di test ini (QUARANTINE) membatalkan niat N8.
    const evidence: EvidenceItem = {
      type: 'FACT',
      claim: 'Bukaan lensa kamera selfie adalah f/2.2',
      value: 2.2,
      unit: 'f',
      context: 'Spesifikasi kamera depan',
      source_excerpt: 'bukaan f/2.2',
      reviewer_assessment: null,
      certainty: 'explicit'
    };

    const report = EvidenceValidator.validate(evidence, ambiguousContext);

    // Excerpt pendek + ambigu → diterima dengan flag normalisasi,
    // koordinat tetap null karena anchor tidak bisa memilih span.
    expect(report.accepted).toBe(true);
    expect(report.finalStatus).toBe('VALID_WITH_NORMALIZATION');
    expect(evidence.source_coordinates).toBeNull();
    //expect(report.quarantineReason).toMatch(/GROUNDING|PROVENANCE/);
    expect(report.quarantineReason).toBeUndefined();
    const provenance = report.results.find(r => r.rule === 'PROVENANCE');
    expect(provenance?.status).toBe('SUSPECT');
    expect(provenance?.severity).toBe('MEDIUM');
  });

  // ============================================================
  // E054 — fixed focus (selfie)
  // ============================================================
  test('E054: fixed focus (selfie), excerpt PENDEK (11 char) → ambiguous → diselamatkan N8 → VALID_WITH_NORMALIZATION', () => {
    const evidence: EvidenceItem = {
      type: 'FACT',
      claim: 'Kamera selfie menggunakan sistem fixed focus',
      value: null,
      unit: null,
      context: 'Spesifikasi fokus kamera depan',
      source_excerpt: 'fixed focus',
      reviewer_assessment: null,
      certainty: 'explicit'
    };

    const report = EvidenceValidator.validate(evidence, ambiguousContext);

    expect(report.accepted).toBe(true);
    expect(report.finalStatus).toBe('VALID_WITH_NORMALIZATION');
    expect(evidence.source_coordinates).toBeNull();
    expect(report.quarantineReason).toBeUndefined();
    const provenance = report.results.find(r => r.rule === 'PROVENANCE');
    expect(provenance?.status).toBe('SUSPECT');
    expect(provenance?.severity).toBe('MEDIUM');
  });

  // ============================================================
  // E055 — Perekaman video selfie 1080p 30 fps
  // ============================================================
  test('E055: perekaman video selfie 1080p 30 fps → ambiguous → QUARANTINE', () => {
    const evidence: EvidenceItem = {
      type: 'FACT',
      claim: 'Perekaman video kamera selfie mendukung hingga 1080p 30 fps',
      value: '1080p 30 fps',
      unit: null,
      context: 'Kemampuan perekaman video kamera depan',
      source_excerpt: 'Perekaman videonya up to 1080p 30 fps',
      reviewer_assessment: null,
      certainty: 'explicit'
    };

    const report = EvidenceValidator.validate(evidence, ambiguousContext);

    expect(report.accepted).toBe(false);
    expect(report.finalStatus).toBe('QUARANTINE');
    expect(evidence.source_coordinates).toBeNull();
    expect(report.quarantineReason).toMatch(/GROUNDING|PROVENANCE/);
  });

  // ============================================================
  // E062 — Bukaan lensa kamera ultrawide f/2.2
  // ============================================================
  test('E062: bukaan f/2.2 (ultrawide), excerpt PENDEK (<20 char) → ambiguous → diselamatkan N8 → VALID_WITH_NORMALIZATION', () => {
    const evidence: EvidenceItem = {
      type: 'FACT',
      claim: 'Bukaan lensa kamera ultrawide adalah f/2.2',
      value: 2.2,
      unit: 'f',
      context: 'Spesifikasi kamera ultrawide',
      source_excerpt: 'bukaan f/2.2',
      reviewer_assessment: null,
      certainty: 'explicit'
    };

    const report = EvidenceValidator.validate(evidence, ambiguousContext);

    expect(report.accepted).toBe(true);
    expect(report.finalStatus).toBe('VALID_WITH_NORMALIZATION');
    expect(evidence.source_coordinates).toBeNull();
    expect(report.quarantineReason).toBeUndefined();
    const provenance = report.results.find(r => r.rule === 'PROVENANCE');
    expect(provenance?.status).toBe('SUSPECT');
    expect(provenance?.severity).toBe('MEDIUM');
  });

  // ============================================================
  // E064 — Perekaman video ultrawide 1080p 30 fps
  // ============================================================
  test('E064: perekaman video ultrawide 1080p 30 fps → ambiguous → QUARANTINE', () => {
    const evidence: EvidenceItem = {
      type: 'FACT',
      claim: 'Perekaman video kamera ultrawide mendukung hingga 1080p 30 fps',
      value: '1080p 30 fps',
      unit: null,
      context: 'Kemampuan perekaman video kamera ultrawide',
      source_excerpt: 'perekaman videonya up to 1080p 30 fps',
      reviewer_assessment: null,
      certainty: 'explicit'
    };

    const report = EvidenceValidator.validate(evidence, ambiguousContext);

    expect(report.accepted).toBe(false);
    expect(report.finalStatus).toBe('QUARANTINE');
    expect(evidence.source_coordinates).toBeNull();
    expect(report.quarantineReason).toMatch(/GROUNDING|PROVENANCE/);
  });

  // ============================================================
  // TEST KONTROL — Evidence dengan source_excerpt unik tetap lolos
  // ============================================================
  test('KONTROL: source_excerpt unik → accepted=true', () => {
    const uniqueContext: EvidenceContext = {
      chunkIndex: 0,
      chunkText: 'Baterai 5000 mAh',
      chunkSegments: [
        { index: 1, start: '00:00:01,000', end: '00:00:02,000', text: 'Baterai 5000 mAh' }
      ]
    };
    const evidence: EvidenceItem = {
      type: 'FACT',
      claim: 'Kapasitas baterai 5000 mAh',
      value: 5000,
      unit: 'mAh',
      source_excerpt: 'Baterai 5000 mAh',
      reviewer_assessment: null,
      certainty: 'explicit'
    };

    const report = EvidenceValidator.validate(evidence, uniqueContext);

    expect(report.accepted).toBe(true);
    expect(report.finalStatus).toBe('VALID');
    expect(evidence.source_coordinates).not.toBeNull();
  });
});