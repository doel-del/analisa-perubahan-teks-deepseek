// ============================================================
// PHASE B UNIT TESTS — DUPLICATE VALIDATOR
// ============================================================
// Mencakup D-01 sampai D-07 sesuai kontrak Phase B.
// ============================================================

import { describe, test, expect } from 'vitest';
import { DuplicateValidator } from '../duplicate';
import type { EvidenceItem } from '../../types';

// ------------------------------------------------------------
// FIXTURE E139/E140 — Data aktual dari evidence_data v4.1
//
// CATATAN (audit histori E140, lihat rangkuman audit bagian 11.4 #3):
// E140 punya type:'FACT' + reviewer_assessment:'negative', yang
// SEBENARNYA melanggar AssessmentValidator (assessment.ts). Ini BUKAN
// bug aktif -- DuplicateValidator tidak pernah memeriksa validitas
// assessment, dan fixture ini hanya dipakai untuk menguji
// duplicate-detection secara terisolasi (tidak pernah dialirkan lewat
// EvidenceValidator.validate() di test ini). Dipertahankan apa adanya
// sebagai data historis, JANGAN dijadikan contoh evidence yang valid
// secara schema.
// ------------------------------------------------------------

const E139_FIXTURE: EvidenceItem = {
  evidence_id: 'E139',
  topic: 'camera',
  subtopic: 'selfie',
  type: 'OPINION',
  claim: 'Reviewer menyampaikan kekurangan tidak adanya opsi perekaman 60 fps di kamera selfie.',
  value: null,
  unit: null,
  context: 'kamera selfie',
  comparison_target: null,
  reviewer_assessment: 'negative',
  certainty: 'explicit',
  source_excerpt: 'tidak ada opsi perekaman 60 fps di kamera selfie-nya',
  source_coordinates: {
    chunk_index: 8,
    segment_start_index: 358,
    segment_end_index: 358
  }
};

const E140_FIXTURE: EvidenceItem = {
  evidence_id: 'E140',
  topic: 'camera',
  subtopic: 'selfie',
  type: 'FACT',
  claim: 'Tidak ada opsi perekaman 60 fps di kamera selfie.',
  value: null,
  unit: null,
  context: 'perekaman video kamera selfie',
  comparison_target: null,
  reviewer_assessment: 'negative',
  certainty: 'explicit',
  source_excerpt: 'tidak ada opsi perekaman 60 fps di kamera selfie-nya.',
  source_coordinates: {
    chunk_index: 8,
    segment_start_index: 358,
    segment_end_index: 358
  }
};

// ------------------------------------------------------------
// FIXTURE LAIN
// ------------------------------------------------------------

const E062_FIXTURE: EvidenceItem = {
  evidence_id: 'E062',
  topic: 'software',
  subtopic: 'update_policy',
  type: 'FACT',
  claim: 'Jaminan pembaruan hingga 6 generasi Android dan 6 tahun security patch',
  value: '6',
  unit: 'tahun',
  context: 'jaminan pembaruan software',
  comparison_target: null,
  reviewer_assessment: null,
  certainty: 'explicit',
  source_excerpt: '6 generasi Android dan 6 tahun security patch',
  source_coordinates: {
    chunk_index: 2,
    segment_start_index: 160,
    segment_end_index: 160
  }
};

const E179_FIXTURE: EvidenceItem = {
  evidence_id: 'E179',
  topic: 'software',
  subtopic: 'update_policy',
  type: 'FACT',
  claim: 'Jaminan pembaruan hingga 6 generasi Android dan 6 tahun security patch',
  value: '6',
  unit: 'tahun',
  context: 'kebijakan update software',
  comparison_target: null,
  reviewer_assessment: 'positive',
  certainty: 'explicit',
  source_excerpt: '6 generasi Android dan 6 tahun Security Patch',
  source_coordinates: {
    chunk_index: 13,
    segment_start_index: 432,
    segment_end_index: 432
  }
};

// ------------------------------------------------------------
// DESCRIBE
// ------------------------------------------------------------

describe('DUPLICATE VALIDATOR', () => {
  // ==========================================================
  // D-01: E139/E140 — actual fixture
  // ==========================================================

  test('D-01: E139/E140 — same occurrence + same excerpt + related claim → KEEP_FIRST', () => {
    const result = DuplicateValidator.detect([
      E139_FIXTURE,
      E140_FIXTURE
    ]);

    expect(result.candidates).toHaveLength(1);
    expect(result.duplicatePairs).toHaveLength(1);

    expect(result.duplicatePairs[0]).toMatchObject({
      evidence_id_a: 'E139',
      evidence_id_b: 'E140',
      action: 'KEEP_FIRST'
    });
  });

  // ==========================================================
  // D-02: Same claim, different context → PRESERVE
  // ==========================================================

  test('D-02: Same claim, different context → PRESERVE', () => {
    const evidenceList: EvidenceItem[] = [
      {
        evidence_id: 'E001',
        topic: 'gaming',
        subtopic: 'temperature',
        type: 'MEASUREMENT',
        claim: 'Suhu mencapai 45°C',
        context: 'Mobile Legends, match ketiga',
        source_excerpt: 'suhu permukaannya mencapai 45°C',
        source_coordinates: {
          chunk_index: 5,
          segment_start_index: 100,
          segment_end_index: 100
        }
      },
      {
        evidence_id: 'E002',
        topic: 'gaming',
        subtopic: 'temperature',
        type: 'MEASUREMENT',
        claim: 'Suhu mencapai 45°C',
        context: 'Wuthering Waves, back cover',
        source_excerpt: 'suhu mencapai 45°C',
        source_coordinates: {
          chunk_index: 7,
          segment_start_index: 252,
          segment_end_index: 252
        }
      }
    ];

    const result = DuplicateValidator.detect(evidenceList);

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.duplicatePairs[0].action).toBe('PRESERVE');
  });

  // ==========================================================
  // D-03: Same claim, different source occurrence → PRESERVE
  // ==========================================================

  test('D-03: Same claim, different source occurrence → PRESERVE', () => {
    const evidenceList: EvidenceItem[] = [
      E062_FIXTURE,
      E179_FIXTURE
    ];

    const result = DuplicateValidator.detect(evidenceList);

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.duplicatePairs[0].action).toBe('PRESERVE');
  });

  // ==========================================================
  // D-04: Same occurrence + identical evidence → KEEP_FIRST
  // ==========================================================

  test('D-04: Same occurrence + identical evidence → KEEP_FIRST', () => {
    const evidenceList: EvidenceItem[] = [
      {
        evidence_id: 'E001',
        topic: 'display',
        subtopic: 'refresh_rate',
        type: 'FACT',
        claim: 'Refresh rate 120Hz',
        source_excerpt: 'Refresh rate-nya 120Hz',
        context: null,
        source_coordinates: {
          chunk_index: 1,
          segment_start_index: 76,
          segment_end_index: 76
        }
      },
      {
        evidence_id: 'E002',
        topic: 'display',
        subtopic: 'refresh_rate',
        type: 'FACT',
        claim: 'Refresh rate 120Hz',
        source_excerpt: 'Refresh rate-nya 120Hz',
        context: null,
        source_coordinates: {
          chunk_index: 1,
          segment_start_index: 76,
          segment_end_index: 76
        }
      }
    ];

    const result = DuplicateValidator.detect(evidenceList);

    expect(result.candidates).toHaveLength(1);
    expect(result.duplicatePairs[0]).toMatchObject({
      evidence_id_a: 'E001',
      evidence_id_b: 'E002',
      action: 'KEEP_FIRST'
    });
  });

  // ==========================================================
  // D-05: Unknown context, same coords, identical claim → KEEP_FIRST
  // ==========================================================

  test('D-05: Unknown context — same claim, same excerpt, same coords → KEEP_FIRST', () => {
  const evidenceList: EvidenceItem[] = [
    {
      evidence_id: 'E001',
      topic: 'gaming',
      subtopic: 'temperature',
      type: 'MEASUREMENT',
      claim: 'Suhu mencapai 45°C',
      context: null,
      source_excerpt: 'suhu mencapai 45°C',
      source_coordinates: {
        chunk_index: 1,
        segment_start_index: 100,
        segment_end_index: 100
      }
    },
    {
      evidence_id: 'E002',
      topic: 'gaming',
      subtopic: 'temperature',
      type: 'MEASUREMENT',
      claim: 'Suhu mencapai 45°C',
      context: 'Genshin Impact',
      source_excerpt: 'suhu mencapai 45°C',
      source_coordinates: {
        chunk_index: 1,
        segment_start_index: 100,
        segment_end_index: 100
      }
    }
  ];

  const result = DuplicateValidator.detect(evidenceList);

  expect(result.candidates.length).toBeGreaterThan(0);
  expect(result.duplicatePairs[0].action).toBe('KEEP_FIRST');
});

  // ==========================================================
  // D-06: Same segment, different chunk → SAME source → KEEP_FIRST
  // ==========================================================

  test('D-06: Same segment, different chunk → KEEP_FIRST', () => {
    const evidenceList: EvidenceItem[] = [
      {
        evidence_id: 'E001',
        topic: 'display',
        subtopic: 'refresh_rate',
        type: 'FACT',
        claim: 'Refresh rate 120Hz',
        source_excerpt: 'Refresh rate-nya 120Hz',
        context: null,
        source_coordinates: {
          chunk_index: 8,
          segment_start_index: 358,
          segment_end_index: 358
        }
      },
      {
        evidence_id: 'E002',
        topic: 'display',
        subtopic: 'refresh_rate',
        type: 'FACT',
        claim: 'Refresh rate 120Hz',
        source_excerpt: 'Refresh rate-nya 120Hz',
        context: null,
        source_coordinates: {
          chunk_index: 9,
          segment_start_index: 358,
          segment_end_index: 358
        }
      }
    ];

    const result = DuplicateValidator.detect(evidenceList);

    expect(result.candidates).toHaveLength(1);
    expect(result.duplicatePairs[0]).toMatchObject({
      evidence_id_a: 'E001',
      evidence_id_b: 'E002',
      action: 'KEEP_FIRST'
    });
  });

  // ==========================================================
  // D-07: Different segment occurrence → PRESERVE
  // ==========================================================

  test('D-07: Different segment occurrence → PRESERVE', () => {
    const evidenceList: EvidenceItem[] = [
      {
        evidence_id: 'E001',
        topic: 'display',
        subtopic: 'refresh_rate',
        type: 'FACT',
        claim: 'Refresh rate 120Hz',
        source_excerpt: 'Refresh rate-nya 120Hz',
        context: null,
        source_coordinates: {
          chunk_index: 8,
          segment_start_index: 358,
          segment_end_index: 358
        }
      },
      {
        evidence_id: 'E002',
        topic: 'display',
        subtopic: 'refresh_rate',
        type: 'FACT',
        claim: 'Refresh rate 120Hz',
        source_excerpt: 'Refresh rate-nya 120Hz',
        context: null,
        source_coordinates: {
          chunk_index: 9,
          segment_start_index: 400,
          segment_end_index: 400
        }
      }
    ];

    const result = DuplicateValidator.detect(evidenceList);

    expect(result.candidates).toHaveLength(1);
    expect(result.duplicatePairs[0]).toMatchObject({
      evidence_id_a: 'E001',
      evidence_id_b: 'E002',
      action: 'PRESERVE'
    });
  });

  test('D-08: Same source + different excerpt + unknown context → PRESERVE', () => {
  const evidenceList: EvidenceItem[] = [
    {
      evidence_id: 'E001',
      topic: 'camera',
      subtopic: 'main_camera',
      type: 'MEASUREMENT',
      claim: 'Video 1080p 30 fps stabil',
      context: null,
      source_excerpt: 'video 1080p 30 fps stabil',
      source_coordinates: {
        chunk_index: 8,
        segment_start_index: 300,
        segment_end_index: 300
      }
    },
    {
      evidence_id: 'E002',
      topic: 'camera',
      subtopic: 'main_camera',
      type: 'MEASUREMENT',
      claim: 'Video 1080p 60 fps goyang',
      context: null,
      source_excerpt: 'video 1080p 60 fps goyang',
      source_coordinates: {
        chunk_index: 8,
        segment_start_index: 300,
        segment_end_index: 300
      }
    }
  ];

  const result = DuplicateValidator.detect(evidenceList);

  expect(result.candidates).toHaveLength(0);
  expect(result.duplicatePairs).toHaveLength(0);
});

  // ==========================================================
  // NEGATIVE CONTROL: No duplicate → no candidates
  // ==========================================================

  test('NEGATIVE: Different topic → no candidates', () => {
    const evidenceList: EvidenceItem[] = [
      {
        evidence_id: 'E001',
        topic: 'display',
        subtopic: 'brightness',
        type: 'MEASUREMENT',
        claim: 'Brightness 358 nits',
        source_excerpt: 'brightness 358 nits',
        source_coordinates: {
          chunk_index: 1,
          segment_start_index: 81,
          segment_end_index: 81
        }
      },
      {
        evidence_id: 'E002',
        topic: 'gaming',
        subtopic: 'fps',
        type: 'MEASUREMENT',
        claim: 'FPS 60',
        source_excerpt: '60 fps',
        source_coordinates: {
          chunk_index: 2,
          segment_start_index: 200,
          segment_end_index: 200
        }
      }
    ];

    const result = DuplicateValidator.detect(evidenceList);

    expect(result.candidates).toHaveLength(0);
    expect(result.duplicatePairs).toHaveLength(0);
  });

  // ==========================================================
  // NEGATIVE CONTROL: Same source but different excerpt and context
  // ==========================================================

  test('NEGATIVE: Same source but different excerpt and context → PRESERVE', () => {
    const evidenceList: EvidenceItem[] = [
      {
        evidence_id: 'E001',
        topic: 'camera',
        subtopic: 'main_camera',
        type: 'MEASUREMENT',
        claim: 'Video 1080p 30 fps stabil',
        context: 'kamera utama',
        source_excerpt: 'video 1080p 30 fps stabil',
        source_coordinates: {
          chunk_index: 8,
          segment_start_index: 300,
          segment_end_index: 300
        }
      },
      {
        evidence_id: 'E002',
        topic: 'camera',
        subtopic: 'main_camera',
        type: 'MEASUREMENT',
        claim: 'Video 1080p 60 fps goyang',
        context: 'kamera utama',
        source_excerpt: 'video 1080p 60 fps goyang',
        source_coordinates: {
          chunk_index: 8,
          segment_start_index: 301,
          segment_end_index: 301
        }
      }
    ];

    const result = DuplicateValidator.detect(evidenceList);

    expect(result.candidates).toHaveLength(0);
    expect(result.duplicatePairs).toHaveLength(0);
  });
    test('D-09: Same excerpt + DIFFERENT subtopic (SHARED_PREDICATE_DUPLICATE_SPLIT replica) → MERGE', () => {
    const SAME_EXCERPT =
      'kamera selfie dan ultrawide yang perlu peningkatan, terutama di kondisi low light';

    const evidenceList: EvidenceItem[] = [
      {
        evidence_id: 'E201', topic: 'camera', subtopic: 'selfie', type: 'OPINION',
        claim: 'Kamera selfie perlu peningkatan, terutama di kondisi low light.',
        value: null, unit: null, context: 'kamera selfie dan ultrawide',
        comparison_target: null, reviewer_assessment: 'negative', certainty: 'explicit',
        source_excerpt: SAME_EXCERPT,
        source_coordinates: { chunk_index: 4, segment_start_index: 210, segment_end_index: 210 }
      },
      {
        evidence_id: 'E202', topic: 'camera', subtopic: 'ultrawide', type: 'OPINION',
        claim: 'Kamera ultrawide perlu peningkatan, terutama di kondisi low light.',
        value: null, unit: null, context: 'kamera selfie dan ultrawide',
        comparison_target: null, reviewer_assessment: 'negative', certainty: 'explicit',
        source_excerpt: SAME_EXCERPT,
        source_coordinates: { chunk_index: 4, segment_start_index: 210, segment_end_index: 210 }
      }
    ];

    const result = DuplicateValidator.detect(evidenceList);

    expect(result.candidates).toHaveLength(1);
    expect(result.duplicatePairs).toHaveLength(1);
    expect(result.duplicatePairs[0].action).toBe('MERGE');

    const merged = result.duplicatePairs[0].mergedEvidence;
    expect(merged).toBeDefined();
    expect(merged!.subtopic).toBeNull();
    expect(merged!.merged_subtopics).toEqual(['selfie', 'ultrawide']);
    expect(merged!.merged_from_evidence_ids).toEqual(['E201', 'E202']);
    expect(merged!.claim).toContain('selfie');
    expect(merged!.claim).toContain('ultrawide');
    expect(merged!.source_excerpt).toBe(SAME_EXCERPT);
  });

  test('D-10: Same excerpt + different subtopic + DIFFERENT type → PRESERVE (edge case guard)', () => {
    const SAME_EXCERPT = 'tombol volume atas dan tombol volume bawah terasa agak keras';

    const evidenceList: EvidenceItem[] = [
      {
        evidence_id: 'E301', topic: 'design', subtopic: 'volume_up', type: 'FACT',
        claim: 'Tombol volume atas terasa agak keras.',
        value: null, unit: null, context: null,
        comparison_target: null, reviewer_assessment: null, certainty: 'explicit',
        source_excerpt: SAME_EXCERPT,
        source_coordinates: { chunk_index: 2, segment_start_index: 90, segment_end_index: 90 }
      },
      {
        evidence_id: 'E302', topic: 'design', subtopic: 'volume_down', type: 'OPINION',
        claim: 'Reviewer menilai tombol volume bawah terasa agak keras.',
        value: null, unit: null, context: null,
        comparison_target: null, reviewer_assessment: 'negative', certainty: 'explicit',
        source_excerpt: SAME_EXCERPT,
        source_coordinates: { chunk_index: 2, segment_start_index: 90, segment_end_index: 90 }
      }
    ];

    const result = DuplicateValidator.detect(evidenceList);

    expect(result.duplicatePairs).toHaveLength(1);
    expect(result.duplicatePairs[0].action).toBe('PRESERVE');
  });
    test('D-11: Same excerpt + different subtopic + SAME type, but DIFFERENT value → PRESERVE (not silently dropped)', () => {
    const SAME_EXCERPT = 'RAM 8 GB dan storage 256 GB tersedia di varian ini';

    const evidenceList: EvidenceItem[] = [
      {
        evidence_id: 'E401', topic: 'memory', subtopic: 'ram', type: 'FACT',
        claim: 'RAM 8 GB tersedia.',
        value: '8', unit: 'GB', context: null,
        comparison_target: null, reviewer_assessment: null, certainty: 'explicit',
        source_excerpt: SAME_EXCERPT,
        source_coordinates: { chunk_index: 3, segment_start_index: 150, segment_end_index: 150 }
      },
      {
        evidence_id: 'E402', topic: 'storage', subtopic: 'storage_capacity', type: 'FACT',
        claim: 'Storage 256 GB tersedia.',
        value: '256', unit: 'GB', context: null,
        comparison_target: null, reviewer_assessment: null, certainty: 'explicit',
        source_excerpt: SAME_EXCERPT,
        source_coordinates: { chunk_index: 3, segment_start_index: 150, segment_end_index: 150 }
      }
    ];

    const result = DuplicateValidator.detect(evidenceList);

    expect(result.duplicatePairs).toHaveLength(1);
    // Value berbeda (8 vs 256) → bukan SHARED_PREDICATE_DUPLICATE_SPLIT murni,
    // harus PRESERVE, bukan MERGE (yang akan membuang salah satu value diam-diam)
    expect(result.duplicatePairs[0].action).toBe('PRESERVE');
    expect(result.duplicatePairs[0].mergedEvidence).toBeUndefined();
  });

  test('D-12 (DOKUMENTASI PERILAKU SAAT INI — bukan assertion "benar"): Same excerpt + ONE subtopic null → jalur lama (KEEP_FIRST/KEEP_BEST), TIDAK masuk gate MERGE', () => {
    const SAME_EXCERPT =
      'kamera selfie dan ultrawide yang perlu peningkatan, terutama di kondisi low light';

    const evidenceList: EvidenceItem[] = [
      {
        evidence_id: 'E501', topic: 'camera', subtopic: 'selfie', type: 'OPINION',
        claim: 'Kamera selfie perlu peningkatan, terutama di kondisi low light.',
        value: null, unit: null, context: null,
        comparison_target: null, reviewer_assessment: 'negative', certainty: 'explicit',
        source_excerpt: SAME_EXCERPT,
        source_coordinates: { chunk_index: 4, segment_start_index: 210, segment_end_index: 210 }
      },
      {
        evidence_id: 'E502', topic: 'camera', subtopic: null, type: 'OPINION',
        claim: 'Kamera ultrawide perlu peningkatan, terutama di kondisi low light.',
        value: null, unit: null, context: null,
        comparison_target: null, reviewer_assessment: 'negative', certainty: 'explicit',
        source_excerpt: SAME_EXCERPT,
        source_coordinates: { chunk_index: 4, segment_start_index: 210, segment_end_index: 210 }
      }
    ];

    const result = DuplicateValidator.detect(evidenceList);

    expect(result.duplicatePairs).toHaveLength(1);
    // CATATAN: ini mendokumentasikan perilaku SAAT INI, bukan menyatakan
    // ini sudah benar. Kasus ini di luar cakupan gate MERGE (butuh kedua
    // subtopic terisi). Belum ada keputusan tim apakah perlu gate tambahan
    // untuk skenario ini -- lihat rangkuman audit bagian 9 (item terbuka).
    expect(result.duplicatePairs[0].action).not.toBe('MERGE');
  });
});