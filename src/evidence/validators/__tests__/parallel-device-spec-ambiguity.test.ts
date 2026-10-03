// ============================================================
// REGRESSION TEST — PARALLEL_DEVICE_SPEC_AMBIGUITY
// ============================================================
// Tujuan: mengunci bahwa gap GROUNDING/PROVENANCE yang ditemukan dari
// log production (Test Gemini temperature 0.0, Chunk #2, kategori
// kuarantine "Ambiguous") SUDAH DIPERBAIKI lewat redesign:
//
//   - GroundingValidator menjadi existence-only (Stage 5)
//   - ProvenanceValidator menerima anchor (evidence.subtopic) dan
//     mendelegasikan occurrence disambiguation ke anchor resolver
//     (Stage 4)
//   - EvidenceValidator meneruskan evidence.subtopic sebagai anchor
//     (Stage 6)
//   - [BARU] anchor-resolver.ts menambah fase 2 (span expansion,
//     radius=1 segmen) sebagai fallback saat anchor tidak ada di
//     candidate span sendiri -- lihat Bagian F, yang menutup pola
//     "up to 1080p 30 fps" yang SEBELUMNYA tidak tertutup oleh
//     Bagian D (Bagian D hanya memakai "bukaan f/2.2", yang sudah
//     RESOLVED lewat fase 1 sejak awal, tidak pernah menguji fase 2).
//
// Sebelum redesign, excerpt template pendek ("bukaan f/2.2",
// "fixed focus", "up to 1080p 30 fps") yang muncul PERSIS 2x di chunk
// (sekali per device paralel selfie vs ultrawide) otomatis dianggap
// ambigu → false quarantine.
//
// Setelah redesign, anchor (subtopic) memilih candidate span yang
// tepat → provenance RESOLVED → evidence diterima.
//
// STATUS TEST INI: POSITIVE REGRESSION ASSERTION.
// Test-test di Bagian A dan D meng-assert perilaku BENAR pasca-fix.
// Bagian B tetap meng-assert jalur fail-safe (multiple occurrence +
// tidak ada anchor → tetap AMBIGUOUS, tidak boleh menebak).
// Bagian C adalah kontrol negatif untuk excerpt yang memang spesifik.
//
// FIXTURE: segmen 95-103 disalin verbatim dari
// "INPUT External/transcript.srt" (Samsung Galaxy A26 5G review).
// chunkIndex/timestamps dipertahankan sesuai SRT asli.
//
// Tidak mengubah production code.
// Tidak mengubah prompt.
// ============================================================

import { describe, test, expect } from 'vitest';
import { GroundingValidator } from '../grounding';
import { ProvenanceValidator } from '../provenance';
import { EvidenceValidator } from '../evidence-validator';
import type { EvidenceContext, EvidenceItem, EvidenceValidationReport } from '../../types';

// ------------------------------------------------------------
// FIXTURE — segmen 95-103, verbatim dari transcript.srt asli
// ------------------------------------------------------------

const context: EvidenceContext = {
  chunkIndex: 1,
  chunkSegments: [
    { index: 95, start: '00:05:09,129', end: '00:05:15,569', text: 'Lalu untuk di bezel atas layar ini, terdapat earpiece yang ditemani oleh kamera selfie dengan model waterdrop.' },
    { index: 96, start: '00:05:15,569', end: '00:05:20,569', text: 'Ini adalah kamera selfie 13 MP, bukaan f/2.2, fixed focus.' },
    { index: 97, start: '00:05:20,569', end: '00:05:24,129', text: 'Perekaman videonya up to 1080p 30 fps.' },
    { index: 98, start: '00:05:24,129', end: '00:05:27,610', text: 'Beralih ke sisi belakang, ini adalah 50 MP Main Camera.' },
    { index: 99, start: '00:05:27,610', end: '00:05:29,529', text: 'Bukaannya f/1.8, auto focus.' },
    { index: 100, start: '00:05:29,529', end: '00:05:35,089', text: 'Perekaman video bisa sampai 4K 30 fps dan ada pilihan juga untuk 1080p 60 fps.' },
    { index: 101, start: '00:05:35,089', end: '00:05:40,050', text: 'Kemudian untuk kamera berikutnya ada kamera ultrawide 8 MP, bukaan f/2.2.' },
    { index: 102, start: '00:05:40,050', end: '00:05:44,370', text: 'Ini fixed focus juga ya, perekaman videonya up to 1080p 30 fps.' },
    { index: 103, start: '00:05:44,370', end: '00:05:48,550', text: 'Kemudian ada kamera 2 MP macro camera dan ada LED flash.' }
  ],
  chunkText: [
    'Lalu untuk di bezel atas layar ini, terdapat earpiece yang ditemani oleh kamera selfie dengan model waterdrop.',
    'Ini adalah kamera selfie 13 MP, bukaan f/2.2, fixed focus.',
    'Perekaman videonya up to 1080p 30 fps.',
    'Beralih ke sisi belakang, ini adalah 50 MP Main Camera.',
    'Bukaannya f/1.8, auto focus.',
    'Perekaman video bisa sampai 4K 30 fps dan ada pilihan juga untuk 1080p 60 fps.',
    'Kemudian untuk kamera berikutnya ada kamera ultrawide 8 MP, bukaan f/2.2.',
    'Ini fixed focus juga ya, perekaman videonya up to 1080p 30 fps.',
    'Kemudian ada kamera 2 MP macro camera dan ada LED flash.'
  ].join(' ')
};

describe('PARALLEL_DEVICE_SPEC_AMBIGUITY — fix terverifikasi', () => {

  // ============================================================
  // BAGIAN A — GroundingValidator existence-only
  // ============================================================
  // Sebelum redesign: excerpt template pendek yang muncul >1x
  // ditandai SUSPECT/HIGH oleh Grounding → memicu false quarantine.
  //
  // Setelah redesign: Grounding hanya cek existence. Keberadaan >1
  // match bukan urusan Grounding — itu domain Provenance.
  // ============================================================
  describe('A. GroundingValidator existence-only: multiple match = PASS', () => {

    test('"bukaan f/2.2" muncul di segmen 96 (selfie) DAN 101 (ultrawide) → PASS', () => {
      const result = GroundingValidator.validate('bukaan f/2.2', context);
      expect(result.status).toBe('PASS');
      expect(result.severity).toBe('LOW');
    });

    test('"fixed focus" muncul di segmen 96 (selfie) DAN 102 (ultrawide) → PASS', () => {
      const result = GroundingValidator.validate('fixed focus', context);
      expect(result.status).toBe('PASS');
      expect(result.severity).toBe('LOW');
    });

    test('"up to 1080p 30 fps" muncul di segmen 97 (selfie) DAN 102 (ultrawide) → PASS', () => {
      const result = GroundingValidator.validate('up to 1080p 30 fps', context);
      expect(result.status).toBe('PASS');
      expect(result.severity).toBe('LOW');
    });
  });

  // ============================================================
  // BAGIAN B — ProvenanceValidator fail-safe saat anchor tidak tersedia
  // ============================================================
  // Regression guard untuk jalur: multiple occurrence + anchor null
  // (tidak tersedia) → WAJIB tetap AMBIGUOUS → wrapper SUSPECT.
  // Resolver tidak boleh menebak occurrence manapun secara arbitrer.
  //
  // Anchor sengaja null di sini (bukan 'selfie'/'ultrawide') supaya
  // coverage berbeda dari contract test #1–#3 dan Bagian D, yang
  // menguji jalur anchor-tersedia.
  // ============================================================
  describe('B. ProvenanceValidator fail-safe: multiple occurrence tanpa anchor → SUSPECT', () => {

    test('"bukaan f/2.2" tanpa anchor → coordinates null, status SUSPECT', () => {
      const result = ProvenanceValidator.resolve('bukaan f/2.2', null, context);
      expect(result.coordinates).toBeNull();
      expect(result.result.status).toBe('SUSPECT');
    });

    test('"fixed focus" tanpa anchor → coordinates null, status SUSPECT', () => {
      const result = ProvenanceValidator.resolve('fixed focus', null, context);
      expect(result.coordinates).toBeNull();
      expect(result.result.status).toBe('SUSPECT');
    });
  });

  // ============================================================
  // BAGIAN C — KONTROL: excerpt unik tetap PASS
  // ============================================================
  // Membuktikan bahwa existence-only tidak berarti "semua dianggap
  // valid tanpa peduli kondisi". Excerpt yang memang hanya punya 1
  // occurrence tetap PASS.
  // ============================================================
  describe('C. Kontrol — excerpt yang cukup spesifik tetap PASS', () => {

    test('KONTROL: "kamera selfie 13 MP" unik (hanya di segmen 96) → PASS', () => {
      const result = GroundingValidator.validate('kamera selfie 13 MP', context);
      expect(result.status).toBe('PASS');
    });

    test('KONTROL: "kamera ultrawide 8 MP" unik (hanya di segmen 101) → PASS', () => {
      const result = GroundingValidator.validate('kamera ultrawide 8 MP', context);
      expect(result.status).toBe('PASS');
    });

    test('KONTROL: "Bukaannya f/1.8" unik (kamera utama, segmen 99) → PASS', () => {
      const result = GroundingValidator.validate('Bukaannya f/1.8', context);
      expect(result.status).toBe('PASS');
    });
  });

  // ============================================================
  // BAGIAN D — END-TO-END: bukti fix menghilangkan false quarantine
  // ============================================================
  // Mereplikasi persis pola production: dua evidence ATOMIK dan BENAR
  // (satu tentang selfie, satu tentang ultrawide), masing-masing pakai
  // source_excerpt pendek yang templatenya sama.
  //
  // Sebelum redesign: keduanya false-quarantine karena Grounding SUSPECT.
  // Setelah redesign:
  //   - Grounding existence-only → PASS
  //   - Provenance menerima subtopic sebagai anchor → memilih
  //     candidate span yang tepat → RESOLVED → PASS
  //   - EvidenceValidator → accepted, VALID
  // ============================================================
  describe('D. Fix end-to-end: dua evidence sah diterima, bukan lagi false-quarantine', () => {

    const selfieEvidence: EvidenceItem = {
      topic: 'camera',
      subtopic: 'selfie',
      type: 'FACT',
      claim: 'Kamera selfie memiliki bukaan f/2.2.',
      source_excerpt: 'bukaan f/2.2',
      reviewer_assessment: null
    };

    const ultrawideEvidence: EvidenceItem = {
      topic: 'camera',
      subtopic: 'ultrawide',
      type: 'FACT',
      claim: 'Kamera ultrawide memiliki bukaan f/2.2.',
      source_excerpt: 'bukaan f/2.2',
      reviewer_assessment: null
    };

    test('evidence selfie (bukaan f/2.2) DITERIMA karena anchor memilih candidate span yang tepat', () => {
      const report: EvidenceValidationReport = EvidenceValidator.validate(selfieEvidence, context);
      expect(report.accepted).toBe(true);
      expect(report.quarantineReason).toBeUndefined();
      expect(report.finalStatus).toBe('VALID');

      // Penguatan (dari Senior 1): buktikan PROVENANCE memang PASS,
      // bukan hanya "evidence kebetulan lolos".
      const provenance = report.results.find(r => r.rule === 'PROVENANCE');
      expect(provenance?.status).toBe('PASS');

      // Bukti lebih spesifik: coordinates terisi (resolver berhasil).
      expect(selfieEvidence.source_coordinates?.segment_start_index).toBe(96);
    });

    test('evidence ultrawide (bukaan f/2.2) JUGA DITERIMA dan ter-resolve ke segmen 101 yang berbeda dari selfie', () => {
      const report: EvidenceValidationReport = EvidenceValidator.validate(ultrawideEvidence, context);
      expect(report.accepted).toBe(true);
      expect(report.quarantineReason).toBeUndefined();
      expect(report.finalStatus).toBe('VALID');

      const provenance = report.results.find(r => r.rule === 'PROVENANCE');
      expect(provenance?.status).toBe('PASS');

      expect(ultrawideEvidence.source_coordinates?.segment_start_index).toBe(101);
    });

    test('KEDUA evidence diterima dan resolve ke segmen berbeda — bukan lagi sama-sama di-drop', () => {
      const evidenceA: EvidenceItem = { ...selfieEvidence };
      const evidenceB: EvidenceItem = { ...ultrawideEvidence };
      const reportA = EvidenceValidator.validate(evidenceA, context);
      const reportB = EvidenceValidator.validate(evidenceB, context);

      expect(reportA.accepted).toBe(true);
      expect(reportB.accepted).toBe(true);

      // Bukti bahwa keduanya benar-benar di-resolve ke occurrence BERBEDA,
      // bukan sekadar "dua-duanya diterima dengan coordinates kebetulan sama".
      expect(evidenceA.source_coordinates?.segment_start_index).toBe(96);
      expect(evidenceB.source_coordinates?.segment_start_index).toBe(101);
    });
  });

  // ============================================================
  // BAGIAN E — REGRESI PRODUKSI: subtopic kebab-case sungguhan
  // ============================================================
  // Bagian D di atas memakai subtopic satu-kata ('selfie', 'ultrawide'),
  // yang TIDAK PERNAH gagal karena tidak mengandung hyphen. Bagian ini
  // menutup gap coverage itu memakai fixture yang sama persis dengan
  // Bagian D, dan sekaligus mendokumentasikan DUA hal yang BERBEDA:
  //
  //   E1 -- yang SUDAH diperbaiki srt.ts (hyphen -> spasi): subtopic
  //         kebab-case berbahasa/ejaan SAMA dengan transkrip
  //         ('kamera-ultrawide', 'kamera-selfie') sekarang RESOLVED
  //         dengan bersih, karena substring "kamera ultrawide"/
  //         "kamera selfie" memang literal ada di span kandidat.
  //
  //   E2 -- yang MASIH BELUM diperbaiki (di luar cakupan patch hyphen):
  //         subtopic kebab-case berbahasa INGGRIS ('camera-selfie',
  //         persis subtopic asli Q004 di produksi) TIDAK PERNAH bisa
  //         match literal terhadap transkrip Indonesia yang menulis
  //         "kamera" (bukan "camera"). Anchor tetap AMBIGUOUS, dan
  //         yang menyelamatkannya dari quarantine murni N8 (excerpt
  //         pendek diturunkan ke MEDIUM), BUKAN mekanisme anchor.
  //         Ini replika persis hasil produksi asli: eligible_multi=5,
  //         resolved_multi=0 -- anchor tidak pernah benar-benar
  //         menang untuk subtopic berbahasa Inggris, hanya N8 yang
  //         menyelamatkan evidence-nya dari quarantine.
  // ============================================================
  describe('E. REGRESI: subtopic kebab-case (bentuk asli produksi) harus tetap resolve', () => {

    test('subtopic "kamera-ultrawide" (kebab-case, Indonesia) → tetap RESOLVED ke segmen 101', () => {
      const evidence: EvidenceItem = {
        topic: 'camera',
        subtopic: 'kamera-ultrawide',
        type: 'FACT',
        source_excerpt: 'bukaan f/2.2',
        reviewer_assessment: null
      };
      const report = EvidenceValidator.validate(evidence, context);
      expect(report.accepted).toBe(true);
      expect(report.finalStatus).toBe('VALID');
      expect(evidence.source_coordinates?.segment_start_index).toBe(101);
    });

    test('subtopic "kamera-selfie" (kebab-case, Indonesia, urutan sesuai transkrip) → RESOLVED SPESIFIK ke segmen 96, bukan 101', () => {
      // Membuktikan pencocokan bukan kebetulan: anchor "kamera selfie"
      // hanya cocok literal di span 96 ("kamera selfie 13 MP...") dan
      // TIDAK cocok di span 101 ("kamera ultrawide..."), jadi
      // cardinality(supported) === 1 dan resolve ke span yang benar.
      const evidence: EvidenceItem = {
        topic: 'camera',
        //subtopic: 'ultrawide-camera',
        subtopic: 'kamera-selfie',
        type: 'FACT',
        //claim: 'Kamera ultrawide memiliki bukaan f/2.2.',
        claim: 'Kamera selfie memiliki bukaan f/2.2.',
        source_excerpt: 'bukaan f/2.2',
        reviewer_assessment: null
      };
      const report = EvidenceValidator.validate(evidence, context);
      expect(report.accepted).toBe(true);
      expect(report.finalStatus).toBe('VALID');
      expect(evidence.source_coordinates?.segment_start_index).toBe(96);
    });

    test('GAP TERBUKA: subtopic "camera-selfie" (kebab-case, English) TIDAK bisa resolve terhadap transkrip Indonesia ("kamera") -- diselamatkan N8, bukan anchor', () => {
      // Ini replika persis Q004 di produksi (45hfkSE5DvA, chunk 2).
      // Patch hyphen (srt.ts) TIDAK menutup gap ini -- gap ini soal
      // ejaan/bahasa berbeda ("camera" vs "kamera"), bukan hyphen vs
      // spasi. Test ini sengaja mendokumentasikan status SEKARANG,
      // bukan mengklaim sudah diperbaiki. Kalau suatu saat kontrak
      // subtopic prompt diubah agar konsisten memakai ejaan transkrip
      // (bukan "canonical English"), test ini WAJIB diperbarui untuk
      // mengharapkan RESOLVED penuh -- lihat catatan audit soal
      // kontradiksi "English kanonik vs literal dari span" di prompts.ts.
      const evidence: EvidenceItem = {
        topic: 'camera',
        subtopic: 'camera-selfie',
        type: 'FACT',
        claim: 'Kamera selfie memiliki bukaan f/2.2.',
        source_excerpt: 'bukaan f/2.2',
        reviewer_assessment: null
      };
      const report = EvidenceValidator.validate(evidence, context);
      expect(report.accepted).toBe(true);
      expect(report.finalStatus).toBe('VALID_WITH_NORMALIZATION');
      expect(evidence.source_coordinates).toBeNull();

      const provenance = report.results.find(r => r.rule === 'PROVENANCE');
      expect(provenance?.status).toBe('SUSPECT');
      expect(provenance?.severity).toBe('MEDIUM');
    });
  });

  // ============================================================
  // BAGIAN F — SPAN EXPANSION END-TO-END: replika PALING LANGSUNG
  // dari bug produksi 13-run (45hfkSE5DvA, Q001/Q002 di hampir setiap
  // run sejak Test1)
  // ============================================================
  // Bagian D di atas TIDAK menguji fase 2 sama sekali -- "bukaan f/2.2"
  // sudah RESOLVED lewat fase 1 (anchor ada di span kandidat sendiri).
  // Bug produksi sebenarnya ada di excerpt "up to 1080p 30 fps": kata
  // pembeda "selfie"/"ultrawide" TIDAK ADA di span kandidat itu sendiri
  // (seg 97 / seg 102), hanya ada di segmen SEBELUMNYA (96 / 101).
  // Inilah yang selama 13 run selalu berakhir SUSPECT HIGH quarantine.
  // Bagian ini membuktikan fase 2 (radius=1) menutup pola ini secara
  // end-to-end lewat EvidenceValidator, bukan cuma resolver mentah.
  // ============================================================
  describe('F. SPAN EXPANSION end-to-end: pola "up to 1080p 30 fps" (bug produksi 13-run) sekarang RESOLVED', () => {

    const selfieVideoEvidence: EvidenceItem = {
      topic: 'camera',
      subtopic: 'selfie',
      type: 'FACT',
      claim: 'Kamera selfie mendukung perekaman video hingga 1080p 30 fps.',
      source_excerpt: 'up to 1080p 30 fps',
      reviewer_assessment: null
    };

    const ultrawideVideoEvidence: EvidenceItem = {
      topic: 'camera',
      subtopic: 'ultrawide',
      type: 'FACT',
      claim: 'Kamera ultrawide mendukung perekaman video hingga 1080p 30 fps.',
      source_excerpt: 'up to 1080p 30 fps',
      reviewer_assessment: null
    };

    test('evidence selfie ("up to 1080p 30 fps") DITERIMA lewat fase 2 -- anchor "selfie" ditemukan di segmen predecessor (96), bukan di span kandidat sendiri (97)', () => {
      const report: EvidenceValidationReport = EvidenceValidator.validate(selfieVideoEvidence, context);
      expect(report.accepted).toBe(true);
      expect(report.quarantineReason).toBeUndefined();
      expect(report.finalStatus).toBe('VALID');

      const provenance = report.results.find(r => r.rule === 'PROVENANCE');
      expect(provenance?.status).toBe('PASS');

      expect(selfieVideoEvidence.source_coordinates?.segment_start_index).toBe(97);
      expect(selfieVideoEvidence.source_coordinates?.segment_end_index).toBe(97);
    });

    test('evidence ultrawide ("up to 1080p 30 fps") JUGA DITERIMA lewat fase 2, resolve ke segmen 102 -- berbeda dari selfie meski excerpt-nya identik', () => {
      const report: EvidenceValidationReport = EvidenceValidator.validate(ultrawideVideoEvidence, context);
      expect(report.accepted).toBe(true);
      expect(report.quarantineReason).toBeUndefined();
      expect(report.finalStatus).toBe('VALID');

      const provenance = report.results.find(r => r.rule === 'PROVENANCE');
      expect(provenance?.status).toBe('PASS');

      expect(ultrawideVideoEvidence.source_coordinates?.segment_start_index).toBe(102);
      expect(ultrawideVideoEvidence.source_coordinates?.segment_end_index).toBe(102);
    });

    test('KEDUA evidence resolve ke segmen berbeda dan koordinat TETAP span sempit (97/102), BUKAN jendela lebar yang dipakai untuk mencari anchor (mis. bukan 96-98)', () => {
      const evidenceA: EvidenceItem = { ...selfieVideoEvidence };
      const evidenceB: EvidenceItem = { ...ultrawideVideoEvidence };
      EvidenceValidator.validate(evidenceA, context);
      EvidenceValidator.validate(evidenceB, context);

      // Bukti eksplisit: segment_start_index === segment_end_index untuk
      // KEDUANYA -- membuktikan koordinat yang dilaporkan adalah span
      // 1-segmen asli dari findSourceMatches, BUKAN rentang gabungan
      // dari jendela radius=1 yang dipakai internal resolver untuk
      // mencocokkan anchor.
      expect(evidenceA.source_coordinates?.segment_start_index).toBe(97);
      expect(evidenceA.source_coordinates?.segment_end_index).toBe(97);
      expect(evidenceB.source_coordinates?.segment_start_index).toBe(102);
      expect(evidenceB.source_coordinates?.segment_end_index).toBe(102);
    });
  });
});