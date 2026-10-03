// ============================================================
// E.3D — REPRODUCIBILITY HARNESS (PRODUCTION-EQUIVALENT)
// ============================================================
// Mereplikasi jalur production INPUT PATH secara literal dengan
// memanggil implementasi production yang sama (bukan salinan):
//
//   SRT
//     → parseSRT()                    [production-pipeline.ts]
//     → buildEvidenceChunks()         [production-pipeline.ts]
//     → buildChunkText()              [production-pipeline.ts]
//     → buildEvidenceInstruction()    [production-pipeline.ts]
//     → PRODUCTION_SYSTEM_INSTRUCTION_EVIDENCE
//     → Gemini (model + temperature production)
//     → parseEvidenceJSONDetailed()   [production-pipeline.ts,
//                                       core sama dgn production,
//                                       hanya ditambah status utk
//                                       pelaporan E.3D]
//     → manifest regression invariants (validateInvariants, ADR
//        khusus E.3D — LIHAT CATATAN di bawah)
//     → 5 independent runs
//
// CATATAN KEJUJURAN METODOLOGIS:
// Harness ini TIDAK memanggil `EvidenceValidator` production.
// Verdict PASS/FAIL/INCONCLUSIVE berasal dari `validateInvariants()`,
// yaitu validator regresi KHUSUS E.3D yang membaca invariant dari
// manifest.json (required_propositions, excerpt_must_be_literal, dst).
// Ini BUKAN production EvidenceValidator/DuplicateValidator dan
// TIDAK melakukan dedup/timestamp/enrichment seperti /api/analyze-review.
//
// Tidak mengubah production code.
// Tidak mengubah prompt.
// Tidak melakukan deduplication/timestamp/enrichment.
//
// PERUBAHAN v2 (Efisiensi API Call — PROPOSAL APPROVED):
// - Satu generation per fixture group per run.
// - Banyak validator diterapkan terhadap generation yang sama.
// - Fallback `runCaseIsolated()` untuk fixture group dengan metadata berbeda.
// ============================================================

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  parseSRT,
  buildEvidenceChunks,
  buildChunkText,
  buildEvidenceInstruction,
  parseEvidenceJSONDetailed,
  PRODUCTION_SYSTEM_INSTRUCTION_EVIDENCE,
  type ReviewMetadata
} from '../production-pipeline';
import type { SRTSegment } from '../srt';

import {
  normalizeForMatching,
  propositionMatchesExcerpt,
  excerptMatchesChunk,
  containsNormalized as excerptContainsNeedle
} from '../text-matching';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const OUTPUT_DIR = path.join(__dirname, 'output', 'reproducibility');
const MANIFEST_PATH = path.join(__dirname, 'corpus', 'manifest.json');

const MODEL = 'gemini-3.5-flash-lite';
const TEMPERATURE = 0.1;
const RUNS = 1;

const DEFAULT_REVIEWER_FALLBACK = 'Reviewer';

const EVALUATIVE_LEXICON = [
  'mantap', 'kecewa', 'bagus', 'downgrade', 'kurang', 'terlalu panas',
  'tergolong oke', 'cukup baik', 'memadai', 'kokoh', 'lancar',
  'mengesankan', 'disayangkan', 'perlu peningkatan', 'sangat baik',
  'sangat buruk', 'luar biasa', 'buruk', 'jelek', 'oke', 'nyaman',
  'mumpuni', 'diandalkan'
];

// ============================================================
// TYPES
// ============================================================

interface ManifestCase {
  case_id: string;
  failure_type: string;
  fixture: string;
  expected_invariant: Record<string, any>;
  metadata?: ReviewMetadata;
}

interface Manifest {
  cases: ManifestCase[];
}

interface ReproducibilityArtifact {
  case_id: string;
  run: number;
  model: string;
  temperature: number;
  timestamp: string;
  chunkText: string;
  chunk_sha256: string;
  prompt_sha256: string;
  system_instruction_sha256: string;
  rawOutput: string;
  parseStatus: 'SUCCESS' | 'FAILED';
  parseStrategy: string | null;
  parseError?: string;
  parsedEvidence: any[];
  validation: {
    status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    violations: string[];
    invariant_results: Array<{
      invariant: string;
      status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
      violations: string[];
      unavailable: string[];
    }>;
  };
}

interface ReproducibilitySummary {
  case_id: string;
  runs: number;
  pass: number;
  fail: number;
  inconclusive: number;
}

// ============================================================
// SHA-256
// ============================================================

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ============================================================
// MANIFEST INVARIANT VALIDATOR (KHUSUS E.3D — bukan production)
// ============================================================

function validateInvariants(
  evidenceList: any[],
  invariant: Record<string, any>,
  chunkText: string,
  chunkSegments: SRTSegment[]
): {
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  violations: string[];
  invariant_results: Array<{
    invariant: string;
    status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    violations: string[];
    unavailable: string[];
  }>;
} {
  const violations: string[] = [];
  const invariant_results: Array<{
    invariant: string;
    status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    violations: string[];
    unavailable: string[];
  }> = [];

  if (invariant.required_propositions) {
    const result = validateRequiredPropositions(
      evidenceList,
      invariant.required_propositions
    );
    invariant_results.push(result);
    violations.push(...result.violations);
  }

  if (invariant.excerpt_must_be_literal) {
    const result = validateLiteralExcerpt(evidenceList, chunkText);
    invariant_results.push(result);
    violations.push(...result.violations);
  }

  if (invariant.required_properties) {
    const result = validateRequiredProperties(
      evidenceList,
      invariant.required_properties
    );
    invariant_results.push(result);
    violations.push(...result.violations);
  }

  if (invariant.no_compound_value) {
    const result = validateNoCompoundValue(evidenceList);
    invariant_results.push(result);
    violations.push(...result.violations);
  }

  if (invariant.check_assessment_lexicon) {
    const result = validateAssessmentLexicon(evidenceList);
    invariant_results.push(result);
    violations.push(...result.violations);
  }

  if (invariant.expected_type_assessment) {
    const result = validateExpectedTypeAssessment(
      evidenceList,
      invariant.expected_type_assessment
    );
    invariant_results.push(result);
    violations.push(...result.violations);
  }

  if (invariant.forbidden_combinations) {
    const result = validateForbiddenCombinations(
      evidenceList,
      invariant.forbidden_combinations
    );
    invariant_results.push(result);
    violations.push(...result.violations);
  }

  if (invariant.shared_predicate_ownership) {
    const result = validateSharedPredicateOwnership(
      evidenceList,
      invariant.shared_predicate_ownership
    );
    invariant_results.push(result);
    violations.push(...result.violations);

    // Monitor tambahan, tidak butuh konfigurasi manifest terpisah --
    // lihat komentar di validateSubtopicNullAsymmetry().
    const asymmetryResult = validateSubtopicNullAsymmetry(evidenceList);
    invariant_results.push(asymmetryResult);
    violations.push(...asymmetryResult.violations);
  }

  let finalStatus: 'PASS' | 'FAIL' | 'INCONCLUSIVE';

  if (invariant_results.some(r => r.status === 'FAIL')) {
    finalStatus = 'FAIL';
  } else if (invariant_results.some(r => r.status === 'INCONCLUSIVE')) {
    finalStatus = 'INCONCLUSIVE';
  } else {
    finalStatus = 'PASS';
  }

  return { status: finalStatus, violations, invariant_results };
}

function validateRequiredPropositions(
  evidenceList: any[],
  requiredPropositions: string[]
) {
  const violations: string[] = [];
  const unavailable: string[] = [];

  if (!requiredPropositions || requiredPropositions.length === 0) {
    return { invariant: 'required_propositions', status: 'PASS' as const, violations, unavailable };
  }

  if (!evidenceList || evidenceList.length === 0) {
    return {
      invariant: 'required_propositions',
      status: 'INCONCLUSIVE' as const,
      violations,
      unavailable: ['EVIDENCE_LIST_EMPTY']
    };
  }

  for (const prop of requiredPropositions) {
    const found = evidenceList.some(ev => {
      const excerpt = ev.source_excerpt || '';
      return propositionMatchesExcerpt(prop, excerpt);
    });

    if (!found) {
      violations.push(`MISSING_REQUIRED_PROPOSITION: ${prop}`);
    }
  }

  return {
    invariant: 'required_propositions',
    status: violations.length > 0 ? ('FAIL' as const) : ('PASS' as const),
    violations,
    unavailable
  };
}

function validateLiteralExcerpt(evidenceList: any[], chunkText: string) {
  const violations: string[] = [];
  const unavailable: string[] = [];

  if (!chunkText) {
    return {
      invariant: 'excerpt_must_be_literal',
      status: 'INCONCLUSIVE' as const,
      violations,
      unavailable: ['CHUNK_TEXT_UNAVAILABLE']
    };
  }

  if (!evidenceList || evidenceList.length === 0) {
    return {
      invariant: 'excerpt_must_be_literal',
      status: 'INCONCLUSIVE' as const,
      violations,
      unavailable: ['EVIDENCE_LIST_EMPTY']
    };
  }

  for (const ev of evidenceList) {
    const excerpt = ev.source_excerpt || '';
    if (!excerpt) continue;

    if (!excerptMatchesChunk(excerpt, chunkText)) {
      violations.push(`NON_LITERAL_EXCERPT: "${excerpt}"`);
    }
  }

  return {
    invariant: 'excerpt_must_be_literal',
    status: violations.length > 0 ? ('FAIL' as const) : ('PASS' as const),
    violations,
    unavailable
  };
}

function validateRequiredProperties(
  evidenceList: any[],
  requiredProperties: Array<{ property: string; value: string; unit: string }>
) {
  const violations: string[] = [];
  const unavailable: string[] = [];

  if (!requiredProperties || requiredProperties.length === 0) {
    return { invariant: 'required_properties', status: 'PASS' as const, violations, unavailable };
  }

  if (!evidenceList || evidenceList.length === 0) {
    return {
      invariant: 'required_properties',
      status: 'INCONCLUSIVE' as const,
      violations,
      unavailable: ['EVIDENCE_LIST_EMPTY']
    };
  }

  for (const prop of requiredProperties) {
    const found = evidenceList.some(ev => {
      const claimHasProperty = (ev.claim || '')
        .toLowerCase()
        .includes(prop.property.toLowerCase());

      return (
        claimHasProperty &&
        String(ev.value ?? '') === prop.value &&
        String(ev.unit ?? '') === prop.unit
      );
    });

    if (!found) {
      violations.push(`MISSING_REQUIRED_PROPERTY: ${prop.property} = ${prop.value} ${prop.unit}`);
    }
  }

  return {
    invariant: 'required_properties',
    status: violations.length > 0 ? ('FAIL' as const) : ('PASS' as const),
    violations,
    unavailable
  };
}

function validateNoCompoundValue(evidenceList: any[]) {
  const violations: string[] = [];
  const unavailable: string[] = [];

  if (!evidenceList || evidenceList.length === 0) {
    return {
      invariant: 'no_compound_value',
      status: 'INCONCLUSIVE' as const,
      violations,
      unavailable: ['EVIDENCE_LIST_EMPTY']
    };
  }

  const compoundEvidence = evidenceList.filter(ev => {
    const claim = (ev.claim || '').toLowerCase();
    return claim.includes('ram') && claim.includes('storage');
  });

  if (compoundEvidence.length > 0) {
    violations.push('COMPOUND_PROPERTY_DETECTED');
  }

  return {
    invariant: 'no_compound_value',
    status: violations.length > 0 ? ('FAIL' as const) : ('PASS' as const),
    violations,
    unavailable
  };
}

function validateForbiddenCombinations(
  evidenceList: any[],
  forbiddenCombinations: Array<Record<string, string>>
) {
  const violations: string[] = [];
  const unavailable: string[] = [];

  if (!forbiddenCombinations || forbiddenCombinations.length === 0) {
    return { invariant: 'forbidden_combinations', status: 'PASS' as const, violations, unavailable };
  }

  if (!evidenceList || evidenceList.length === 0) {
    return {
      invariant: 'forbidden_combinations',
      status: 'INCONCLUSIVE' as const,
      violations,
      unavailable: ['EVIDENCE_LIST_EMPTY']
    };
  }

  for (const ev of evidenceList) {
    for (const combo of forbiddenCombinations) {
      if (
        combo.type === 'FACT' &&
        combo.reviewer_assessment === 'not_null' &&
        ev.type === 'FACT' &&
        ev.reviewer_assessment !== null &&
        ev.reviewer_assessment !== undefined
      ) {
        violations.push(
          `FORBIDDEN_COMBINATION: FACT + reviewer_assessment=${ev.reviewer_assessment}`
        );
      }
    }
  }

  return {
    invariant: 'forbidden_combinations',
    status: violations.length > 0 ? ('FAIL' as const) : ('PASS' as const),
    violations,
    unavailable
  };
}

function validateAssessmentLexicon(evidenceList: any[]) {
  const violations: string[] = [];
  const unavailable: string[] = [];

  if (!evidenceList || evidenceList.length === 0) {
    return {
      invariant: 'check_assessment_lexicon',
      status: 'INCONCLUSIVE' as const,
      violations,
      unavailable: ['EVIDENCE_LIST_EMPTY']
    };
  }

  for (const ev of evidenceList) {
    const hasAssessment =
      ev.reviewer_assessment !== null && ev.reviewer_assessment !== undefined;

    if (!hasAssessment) continue;

    const excerpt = normalizeForMatching(ev.source_excerpt || '');
    const hasLexicalSupport = EVALUATIVE_LEXICON.some(word =>
      excerpt.includes(normalizeForMatching(word))
    );

    if (!hasLexicalSupport) {
      violations.push(
        `UNLEXICALIZED_ASSESSMENT: type=${ev.type}, assessment=${ev.reviewer_assessment}, excerpt="${ev.source_excerpt}"`
      );
    }
  }

  return {
    invariant: 'check_assessment_lexicon',
    status: violations.length > 0 ? ('FAIL' as const) : ('PASS' as const),
    violations,
    unavailable
  };
}

// ============================================================
// SHARED PREDICATE OWNERSHIP (REG-008)
// ============================================================
// Menguji rule prompt "SHARED PREDICATE OWNERSHIP" (v4.2): banyak subjek
// yang berbagi satu predikat/evaluasi → default SATU evidence, jangan
// dipecah kecuali tiap subjek punya predikat/nilai independen.
//
// KONTRAK TERKUNCI (hasil audit dua-pihak, Claude + ChatGPT):
//
// Untuk tiap grup { subjects: string[], must_remain_single: true }:
//
//   full(group)     = evidence yang source_excerpt-nya mengandung SEMUA
//                      subjects di grup — containment INDEPENDEN per-subjek
//                      (subjects.every(s => excerpt.includes(normalize(s)))),
//                      BUKAN satu substring gabungan persis seperti
//                      "speaker kiri dan speaker kanan". Urutan/kata
//                      penghubung di antara subjek TIDAK relevan bagi
//                      pemeriksaan ini.
//   touching(group) = evidence yang source_excerpt-nya mengandung
//                      MINIMAL SATU subjek di grup.
//
//   PASS         : full.size === 1
//   FAIL         : full.size > 1                              (duplicate
//                    full-excerpt split — proposisi sama disalin ke >1
//                    evidence)
//                  ATAU (full.size === 0 DAN touching.size > 1)  (partial
//                    split — subjek dipecah ke evidence terpisah, tidak
//                    ada satu pun yang memuat keduanya)
//   INCONCLUSIVE : full.size === 0 DAN touching.size <= 1
//                    - touching.size === 0 → NOT_FOUND (subjek tidak
//                      muncul di evidence manapun)
//                    - touching.size === 1 → PARTIAL_EXTRACTION (hanya
//                      1 dari N subjek ditemukan; tidak bisa disimpulkan
//                      apakah ini miss ekstraksi atau memang bukan bug ini)
//
// SENGAJA full.size===1 dicek PALING AWAL — evidence lain yang kebetulan
// menyentuh SATU subjek tapi bukan bagian dari proposisi shared-predicate
// yang sama (mis. "speaker kiri menggunakan driver 10 watt" — fakta
// independen, bukan fragmen dari "speaker kiri dan speaker kanan terdengar
// pecah") TIDAK dianggap sebagai split, selama tetap ada satu evidence
// yang memuat proposisi lengkap. Ini yang membedakan "subject occurrence"
// dari "shared-predicate ownership" — evidence yang sekadar menyinggung
// satu subjek bukan berarti ikut memecah proposisi tersebut.
//
// Memakai normalizeForMatching() yang sama dengan validator lain — TIDAK
// ada matcher baru/lokal yang diimplementasikan di sini.
//
// Generalisasi: berlaku untuk N subjek per grup (bukan hardcode 2), sesuai
// skema JSON subjects: string[] yang memang generik.
// ============================================================

function validateSharedPredicateOwnership(
  evidenceList: any[],
  groups: Array<{ subjects: string[]; must_remain_single: boolean }>
) {
  const violations: string[] = [];
  const unavailable: string[] = [];

  if (!groups || groups.length === 0) {
    return { invariant: 'shared_predicate_ownership', status: 'PASS' as const, violations, unavailable };
  }

  if (!evidenceList || evidenceList.length === 0) {
    return {
      invariant: 'shared_predicate_ownership',
      status: 'INCONCLUSIVE' as const,
      violations,
      unavailable: ['EVIDENCE_LIST_EMPTY']
    };
  }

  for (const group of groups) {
    if (!group.must_remain_single) {
      // Kontrol negatif (mis. RAM+storage, battery+charging) SENGAJA
      // tidak dijadikan assertion formal — domain rule berbeda
      // (MULTI-PROPERTY VALUE GUARD), di luar scope invariant ini.
      continue;
    }

    const subjects = group.subjects;

    const containsAllSubjects = (excerptRaw: string): boolean => {
      const excerpt = normalizeForMatching(excerptRaw || '');
      return subjects.every(s => excerpt.includes(normalizeForMatching(s)));
    };

    const containsAnySubject = (excerptRaw: string): boolean => {
      const excerpt = normalizeForMatching(excerptRaw || '');
      return subjects.some(s => excerpt.includes(normalizeForMatching(s)));
    };

    const fullMatchEvidence = evidenceList.filter(ev => containsAllSubjects(ev.source_excerpt || ''));
    const touchingEvidence = evidenceList.filter(ev => containsAnySubject(ev.source_excerpt || ''));

    const groupLabel = subjects.join(' + ');

    if (fullMatchEvidence.length === 1) {
      // PASS untuk grup ini — proposisi shared-predicate tetap satu evidence.
      continue;
    }

    if (fullMatchEvidence.length > 1) {
      violations.push(
        `SHARED_PREDICATE_DUPLICATE_SPLIT: subjects="${groupLabel}", ` +
        `${fullMatchEvidence.length} evidence masing-masing memuat seluruh subjek ` +
        `(proposisi disalin ke lebih dari satu evidence)`
      );
      continue;
    }

    // fullMatchEvidence.length === 0 di titik ini
    if (touchingEvidence.length > 1) {
      violations.push(
        `SHARED_PREDICATE_PARTIAL_SPLIT: subjects="${groupLabel}", ` +
        `${touchingEvidence.length} evidence masing-masing hanya menyentuh sebagian subjek ` +
        `(tidak ada satu evidence pun yang memuat proposisi lengkap)`
      );
      continue;
    }

    if (touchingEvidence.length === 0) {
      unavailable.push(`NOT_FOUND: subjects="${groupLabel}" tidak muncul di evidence manapun`);
    } else {
      // touchingEvidence.length === 1, fullMatchEvidence.length === 0
      unavailable.push(
        `PARTIAL_EXTRACTION: subjects="${groupLabel}", hanya sebagian subjek ditemukan ` +
        `(1 evidence menyentuh grup ini, tapi tidak memuat semua subjek)`
      );
    }
  }

  let status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  if (violations.length > 0) {
    status = 'FAIL';
  } else if (unavailable.length > 0) {
    status = 'INCONCLUSIVE';
  } else {
    status = 'PASS';
  }

  return { invariant: 'shared_predicate_ownership', status, violations, unavailable };
}

// ============================================================
// SUBTOPIC NULL-ASYMMETRY MONITOR (D-12 follow-up)
// ============================================================
// BUKAN enforcement, murni observasional. Menutup item terbuka
// "manifest case null-asimetris" (rangkuman audit, bagian 11.4 #5).
//
// Latar belakang: DuplicateValidator (production, duplicate.ts) punya
// gate MERGE yang MENSYARATKAN kedua subtopic terisi
// (!!subtopicA && !!subtopicB) sebelum boleh menggabung dua evidence
// dengan source_excerpt identik. Kasus SATU subtopic null, satunya
// terisi -- JATUH ke jalur lama (KEEP_FIRST/KEEP_BEST), belum pernah
// teramati nyata di 38 run eksperimen manapun (D-12, dokumentasi
// perilaku, bukan assertion "benar"). Monitor ini mendeteksi kalau
// pola itu muncul di run mendatang, TANPA mengubah production code.
//
// Berjalan UNCONDITIONAL untuk setiap case yang punya
// shared_predicate_ownership di manifest -- tidak butuh konfigurasi
// invariant terpisah, otomatis ikut aktif untuk case baru manapun
// (termasuk EXP-G1/G2) yang sudah punya key tersebut.
//
// Kriteria deteksi (independen dari subjects group manapun -- generik
// terhadap SEMUA pasangan evidence dalam batch):
//   - source_excerpt IDENTIK pasca-normalizeForMatching, DAN
//   - salah satu subtopic kosong/null, yang lain terisi.
// ============================================================

function validateSubtopicNullAsymmetry(evidenceList: any[]) {
  const violations: string[] = [];
  const unavailable: string[] = [];

  if (!evidenceList || evidenceList.length < 2) {
    return {
      invariant: 'subtopic_null_asymmetry_monitor',
      status: 'INCONCLUSIVE' as const,
      violations,
      unavailable: ['EVIDENCE_LIST_TOO_SHORT']
    };
  }

  for (let i = 0; i < evidenceList.length; i++) {
    for (let j = i + 1; j < evidenceList.length; j++) {
      const a = evidenceList[i];
      const b = evidenceList[j];

      const excerptA = normalizeForMatching(a.source_excerpt || '');
      const excerptB = normalizeForMatching(b.source_excerpt || '');

      if (!excerptA || !excerptB || excerptA !== excerptB) continue;

      const subtopicA = String(a.subtopic ?? '').trim();
      const subtopicB = String(b.subtopic ?? '').trim();

      const oneNullOneFilled =
        (subtopicA === '' && subtopicB !== '') ||
        (subtopicA !== '' && subtopicB === '');

      if (oneNullOneFilled) {
        violations.push(
          `SUBTOPIC_NULL_ASYMMETRY: pasangan evidence dengan source_excerpt ` +
          `identik ("${a.source_excerpt}") tapi subtopic asimetris ` +
          `(A="${subtopicA || 'null'}", B="${subtopicB || 'null'}"). ` +
          `Di luar cakupan gate MERGE duplicate.ts saat ini (lihat D-12) -- ` +
          `berpotensi jatuh ke KEEP_FIRST/KEEP_BEST dan silent data loss ` +
          `jika ini variant SHARED_PREDICATE_DUPLICATE_SPLIT.`
        );
      }
    }
  }

  return {
    invariant: 'subtopic_null_asymmetry_monitor',
    status: violations.length > 0 ? ('FAIL' as const) : ('PASS' as const),
    violations,
    unavailable
  };
}

function validateExpectedTypeAssessment(
  evidenceList: any[],
  expectations: Array<{
    excerpt_contains: string;
    expected_type: string[];
    expected_assessment: string | null;
  }>
) {
  const violations: string[] = [];
  const unavailable: string[] = [];

  if (!expectations || expectations.length === 0) {
    return { invariant: 'expected_type_assessment', status: 'PASS' as const, violations, unavailable };
  }

  if (!evidenceList || evidenceList.length === 0) {
    return {
      invariant: 'expected_type_assessment',
      status: 'INCONCLUSIVE' as const,
      violations,
      unavailable: ['EVIDENCE_LIST_EMPTY']
    };
  }

  for (const exp of expectations) {
    const matches = evidenceList.filter(ev =>
      excerptContainsNeedle(exp.excerpt_contains, ev.source_excerpt || '')
    );

    if (matches.length === 0) {
      unavailable.push(`NOT_FOUND: "${exp.excerpt_contains}"`);
      continue;
    }

    for (const ev of matches) {
      const typeOk = exp.expected_type.includes(ev.type);
      const assessmentOk = ev.reviewer_assessment === exp.expected_assessment;

      if (!typeOk || !assessmentOk) {
        violations.push(
          `TYPE_ASSESSMENT_MISMATCH: excerpt_contains="${exp.excerpt_contains}" ` +
          `expected type=${exp.expected_type.join('|')} assessment=${exp.expected_assessment}, ` +
          `got type=${ev.type} assessment=${ev.reviewer_assessment}`
        );
      }
    }
  }

  let status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  if (violations.length > 0) {
    status = 'FAIL';
  } else if (unavailable.length > 0) {
    status = 'INCONCLUSIVE';
  } else {
    status = 'PASS';
  }

  return { invariant: 'expected_type_assessment', status, violations, unavailable };
}

// ============================================================
// LLM CALL — Production Equivalent
// ============================================================

async function callGeminiAPI(
  chunkText: string,
  promptInstruction: string,
  systemInstruction: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY tidak ditemukan.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{ parts: [{ text: `${promptInstruction}\n\n--- TEKS UNTUK DIKOREKSI ---\n${chunkText}` }] }],
    system_instruction: { parts: [{ text: systemInstruction }] },
    generationConfig: { temperature: TEMPERATURE }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API Error (Status ${response.status}): ${errorText.substring(0, 200)}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error('Gemini mengembalikan respons kosong.');
  }

  return text.trim();
}

// ============================================================
// GENERATION — MURNI API CALL, TANPA VALIDASI
// ============================================================

async function generateForFixture(
  representativeCase: ManifestCase,
  runNumber: number
): Promise<{
  chunkText: string;
  chunk_sha256: string;
  prompt_sha256: string;
  system_instruction_sha256: string;
  chunk: SRTSegment[];
  rawOutput: string;
  parseStatus: 'SUCCESS' | 'FAILED';
  parseStrategy: string | null;
  parseError?: string;
  parsedEvidence: any[];
  error?: string;
}> {
  const fixturePath = path.join(FIXTURE_DIR, representativeCase.fixture);
  const fixtureText = fs.readFileSync(fixturePath, 'utf8');

  const segments = parseSRT(fixtureText);
  const chunks = buildEvidenceChunks(segments, 18000, 3);

  if (chunks.length === 0) {
    throw new Error(`Tidak ada chunk dari fixture ${representativeCase.fixture}`);
  }

  const chunk = chunks[0];
  const chunkText = buildChunkText(chunk);
  const metadata: ReviewMetadata = representativeCase.metadata ?? {};

  const promptInstruction = buildEvidenceInstruction(
    metadata,
    DEFAULT_REVIEWER_FALLBACK,
    1,
    1
  );
  const promptHash = sha256(promptInstruction);
  const systemInstructionHash = sha256(PRODUCTION_SYSTEM_INSTRUCTION_EVIDENCE);

  try {
    const rawOutput = await callGeminiAPI(
      chunkText,
      promptInstruction,
      PRODUCTION_SYSTEM_INSTRUCTION_EVIDENCE
    );
    const parseResult = parseEvidenceJSONDetailed(rawOutput);

    return {
      chunkText,
      chunk_sha256: sha256(chunkText),
      prompt_sha256: promptHash,
      system_instruction_sha256: systemInstructionHash,
      chunk,
      rawOutput,
      parseStatus: parseResult.status,
      parseStrategy: parseResult.strategy,
      parseError: parseResult.error,
      parsedEvidence: parseResult.evidence
    };
  } catch (err: any) {
    return {
      chunkText,
      chunk_sha256: sha256(chunkText),
      prompt_sha256: promptHash,
      system_instruction_sha256: systemInstructionHash,
      chunk,
      rawOutput: '',
      parseStatus: 'FAILED',
      parseStrategy: null,
      parsedEvidence: [],
      error: err?.message || 'Unknown error'
    };
  }
}

// ============================================================
// VALIDATE — MURNI VALIDASI, TANPA API CALL
// ============================================================

function validateForCase(
  caseDef: ManifestCase,
  runNumber: number,
  generation: Awaited<ReturnType<typeof generateForFixture>>
): ReproducibilityArtifact {
  const baseArtifact: ReproducibilityArtifact = {
    case_id: caseDef.case_id,
    run: runNumber,
    model: MODEL,
    temperature: TEMPERATURE,
    timestamp: new Date().toISOString(),
    chunkText: generation.chunkText,
    chunk_sha256: generation.chunk_sha256,
    prompt_sha256: generation.prompt_sha256,
    system_instruction_sha256: generation.system_instruction_sha256,
    rawOutput: generation.rawOutput,
    parseStatus: generation.parseStatus,
    parseStrategy: generation.parseStrategy,
    parseError: generation.parseError,
    parsedEvidence: generation.parsedEvidence,
    validation: { status: 'INCONCLUSIVE', violations: [], invariant_results: [] }
  };

  if (generation.error) {
    return {
      ...baseArtifact,
      validation: {
        status: 'INCONCLUSIVE',
        violations: [generation.error],
        invariant_results: []
      }
    };
  }

  const validationResult = validateInvariants(
    generation.parsedEvidence,
    caseDef.expected_invariant,
    generation.chunkText,
    generation.chunk
  );

  return { ...baseArtifact, validation: validationResult };
}

// ============================================================
// RUN CASE ISOLATED — Fallback untuk metadata berbeda
// ============================================================

// ============================================================
// RESET CASE DIR — mencegah kontaminasi summary oleh file
// run-*.json sisa sesi sebelumnya (mis. bekas RUNS lama yang
// lebih besar dari RUNS saat ini). Dipanggil SEBELUM run pertama
// ditulis, baik di jalur isolated maupun grouped-generation.
// ============================================================
function resetCaseDir(caseDir: string): void {
  if (fs.existsSync(caseDir)) {
    fs.rmSync(caseDir, { recursive: true, force: true });
  }
  fs.mkdirSync(caseDir, { recursive: true });
}

async function runCaseIsolated(caseDef: ManifestCase): Promise<void> {
  const caseDir = path.join(OUTPUT_DIR, caseDef.case_id);
  resetCaseDir(caseDir);

  const results: ReproducibilityArtifact[] = [];

  for (let run = 1; run <= RUNS; run++) {
    console.log(`   Run #${run}... (isolated generation)`);

    const generation = await generateForFixture(caseDef, run);
    const result = validateForCase(caseDef, run, generation);

    results.push(result);

    const outputPath = path.join(caseDir, `run-${String(run).padStart(2, '0')}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');

    console.log(`      [${caseDef.case_id}] Validation: ${result.validation.status}`);
    if (result.validation.violations.length > 0) {
      console.log(`      Violations: ${result.validation.violations.join('; ')}`);
    }
  }

  const passCount = results.filter(r => r.validation.status === 'PASS').length;
  const failCount = results.filter(r => r.validation.status === 'FAIL').length;
  const inconclusiveCount = results.filter(r => r.validation.status === 'INCONCLUSIVE').length;

  const summary: ReproducibilitySummary = {
    case_id: caseDef.case_id,
    runs: RUNS,
    pass: passCount,
    fail: failCount,
    inconclusive: inconclusiveCount
  };

  const summaryPath = path.join(caseDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log(`   📊 ${caseDef.case_id}: ${JSON.stringify(summary)}\n`);
}

// ============================================================
// SELF-TEST — normalizeForMatching() + validateExpectedTypeAssessment
//             + validateAssessmentLexicon() + validateSharedPredicateOwnership()
// ============================================================
// Dijalankan SEBELUM API call apapun. Kalau ada assertion yang
// gagal, harness berhenti (process.exit(1)) sebelum satu pun
// request ke Gemini dikirim. Tidak ada file/import terpisah —
// ini menguji fungsi yang SAMA PERSIS dipakai oleh
// validateInvariants() di bawah, karena berada di file yang sama.
//
// Struktur:
//   A. normalizeForMatching() — positive (surface variation → match),
//      negative (semantic variation → tetap tidak match), idempotence.
//      Diuji LEWAT containment wrapper (propositionMatchesExcerpt /
//      excerptMatchesChunk / excerptContainsNeedle), BUKAN equality
//      langsung — supaya self-test benar-benar membuktikan perilaku
//      validator sesungguhnya (yang pakai containment), bukan cuma
//      fungsi normalize() dites terisolasi.
//   B. validateExpectedTypeAssessment — 4 assertion lama (tidak boleh
//      berubah pasca-refactor) + 1 assertion baru (equivalence: hasil
//      normalizeForMatching() harus sama dengan .toLocaleLowerCase('id-ID')
//      lokal yang lama, membuktikan refactor behavior-preserving).
// ============================================================

function runSelfTests(): void {
  console.log('🧪 Self-test: normalizeForMatching() + validateExpectedTypeAssessment + validateSharedPredicateOwnership...\n');

  let failures = 0;

  const check = (
    label: string,
    actualStatus: string,
    expectedStatus: string
  ) => {
    if (actualStatus !== expectedStatus) {
      console.error(`   ❌ ${label} GAGAL: expected ${expectedStatus}, got ${actualStatus}`);
      failures++;
    } else {
      console.log(`   ✅ ${label} → ${expectedStatus}: OK`);
    }
  };

  const checkBool = (label: string, actual: boolean, expected: boolean) => {
    if (actual !== expected) {
      console.error(`   ❌ ${label} GAGAL: expected ${expected}, got ${actual}`);
      failures++;
    } else {
      console.log(`   ✅ ${label} → ${expected}: OK`);
    }
  };

  // ----------------------------------------------------------
  // A. normalizeForMatching() — via containment wrapper
  // ----------------------------------------------------------
  console.log('  --- normalizeForMatching() ---');

  // A1. POSITIVE — needle punya trailing '.', haystack tidak (arah
  // load-bearing untuk validateLiteralExcerpt: excerpt=needle, chunkText=haystack)
  checkBool(
    'A1 (trailing period pada needle → tetap match)',
    excerptMatchesChunk(
      'videonya masih terlihat stabil dan minim jitter.',
      '...4K 30 fps, videonya masih terlihat stabil dan minim jitter di segmen ini...'
    ),
    true
  );

  // A2. POSITIVE — case difference
  checkBool(
    'A2 (case difference → tetap match)',
    propositionMatchesExcerpt(
      'PERFORMA gaming smartphone ini MEROSOT',
      'performa gaming smartphone ini merosot setelah 30 menit'
    ),
    true
  );

  // A3. POSITIVE — multiple whitespace + NBSP (pemisah nilai-unit, pola umum
  // di transkrip) + unicode quotes
  checkBool(
    'A3 (whitespace/NBSP/quote variation → tetap match)',
    propositionMatchesExcerpt(
      '4K 30 fps videonya masih terlihat stabil',
      '“4K\u00A030   fps   videonya  masih terlihat  stabil” kata reviewer'
    ),
    true
  );

  // A4. NEGATIVE — kata fungsi "di " hilang di awal → HARUS FAIL
  // (koreksi eksplisit terhadap tabel awal dok. 15 yang keliru menulis PASS;
  // perilaku final adalah FAIL, konsisten dengan larangan stopword removal)
  checkBool(
    'A4 (prefix "di " hilang → HARUS tidak match)',
    propositionMatchesExcerpt(
      'di 4K 30 fps, videonya masih terlihat stabil',
      '4K 30 fps, videonya masih terlihat stabil dan minim jitter'
    ),
    false
  );

  // A5. NEGATIVE — koma tambahan di tengah → HARUS FAIL (STRICT)
  checkBool(
    'A5 (koma tambahan di tengah → HARUS tidak match)',
    propositionMatchesExcerpt(
      '4K 30 fps, videonya masih terlihat stabil dan minim jitter',
      '4K 30 fps, videonya, masih terlihat stabil dan minim jitter'
    ),
    false
  );

  // A6. NEGATIVE — trailing ',' berbeda dari proposition tanpa koma → STRICT
  checkBool(
    'A6 (trailing koma → HARUS tidak match secara boundary-equal)',
    normalizeForMatching('stabil,') === normalizeForMatching('stabil'),
    false
  );

  // A7. NEGATIVE — trailing ';' → STRICT
  checkBool(
    'A7 (trailing titik-koma → HARUS tidak match secara boundary-equal)',
    normalizeForMatching('stabil;') === normalizeForMatching('stabil'),
    false
  );

  // A8. NEGATIVE — ellipsis (3 titik) TIDAK dinormalisasi sama seperti titik tunggal
  checkBool(
    'A8 (ellipsis "..." → HARUS tidak setara dengan tanpa titik)',
    normalizeForMatching('videonya belum selesai...') === normalizeForMatching('videonya belum selesai'),
    false
  );

  // A9. NEGATIVE — dua titik ".." juga tidak dinormalisasi
  checkBool(
    'A9 (double dot ".." → HARUS tidak setara dengan tanpa titik)',
    normalizeForMatching('videonya belum selesai..') === normalizeForMatching('videonya belum selesai'),
    false
  );

  // A10. NEGATIVE — synonym tidak dianggap match (bukan semantic normalizer)
  checkBool(
    'A10 (sinonim "menurun" vs "berkurang" → HARUS tidak match)',
    propositionMatchesExcerpt(
      'kualitas video menurun',
      'kualitas video berkurang setelah update'
    ),
    false
  );

  // A11. NEGATIVE — word reorder tidak dianggap match
  checkBool(
    'A11 (urutan kata dibalik → HARUS tidak match)',
    propositionMatchesExcerpt(
      'baterai boros tapi kamera bagus',
      'kamera bagus tapi baterai boros'
    ),
    false
  );

  // A12. IDEMPOTENCE — kasus counterexample nyata: spasi SEBELUM titik,
  // lalu spasi trailing. Tanpa step 7 (trim ulang), pass pertama dan
  // kedua menghasilkan string berbeda ("jitter " vs "jitter").
  {
    const input = 'jitter . ';
    const once = normalizeForMatching(input);
    const twice = normalizeForMatching(once);
    checkBool(
      `A12 (idempotence, input problematik "${input}")`,
      once === twice,
      true
    );
  }

  // A13. IDEMPOTENCE — sanity check tambahan pada input "aman" biasa
  {
    const input = '“Videonya   stabil\u00A0dan minim jitter.”';
    const once = normalizeForMatching(input);
    const twice = normalizeForMatching(once);
    checkBool(
      'A13 (idempotence, input umum)',
      once === twice,
      true
    );
  }

  // A14. EDGE CASE — string persis "." tidak crash, menghasilkan string kosong
  checkBool(
    'A14 (edge case: input "." → tidak crash, hasil string kosong)',
    normalizeForMatching('.') === '',
    true
  );

  console.log('\n  --- validateExpectedTypeAssessment ---');

  // Test 1: false negative — OPINION pada CHANGE word harus FAIL
  const wrongData = [{
    type: 'OPINION',
    reviewer_assessment: 'negative',
    source_excerpt: 'Performa gaming smartphone ini merosot setelah bermain lebih dari 30 menit.'
  }];
  check(
    'Test 1 (false negative)',
    validateExpectedTypeAssessment(wrongData, [
      { excerpt_contains: 'merosot', expected_type: ['OBSERVATION'], expected_assessment: null }
    ]).status,
    'FAIL'
  );

  // Test 2: true positive — klasifikasi benar harus PASS
  const correctData = [{
    type: 'OBSERVATION',
    reviewer_assessment: null,
    source_excerpt: 'Performa gaming smartphone ini merosot setelah bermain lebih dari 30 menit.'
  }];
  check(
    'Test 2 (true positive)',
    validateExpectedTypeAssessment(correctData, [
      { excerpt_contains: 'merosot', expected_type: ['OBSERVATION'], expected_assessment: null }
    ]).status,
    'PASS'
  );

  // Test 3: excerpt tidak ditemukan harus INCONCLUSIVE, bukan PASS/FAIL diam-diam
  check(
    'Test 3 (NOT_FOUND)',
    validateExpectedTypeAssessment(correctData, [
      { excerpt_contains: 'frasa yang tidak ada', expected_type: ['OBSERVATION'], expected_assessment: null }
    ]).status,
    'INCONCLUSIVE'
  );

  // Test 4: case-insensitivity — beda kapitalisasi tetap harus match
  const caseData = [{
    type: 'OBSERVATION',
    reviewer_assessment: null,
    source_excerpt: 'PERFORMA gaming smartphone ini MEROSOT setelah bermain.'
  }];
  check(
    'Test 4 (case-insensitive match)',
    validateExpectedTypeAssessment(caseData, [
      { excerpt_contains: 'Merosot', expected_type: ['OBSERVATION'], expected_assessment: null }
    ]).status,
    'PASS'
  );

  // Test 5 (BARU, wajib pasca-refactor): equivalence — perilaku matching
  // lama (.toLocaleLowerCase('id-ID').includes()) dibandingkan LANGSUNG
  // terhadap wrapper baru (excerptContainsNeedle, via normalizeForMatching)
  // pada string representatif yang TIDAK mengandung karakter yang kena
  // transformasi tambahan (NBSP/quote/trailing-period/whitespace-ganda) —
  // sehingga untuk string semacam ini, hasil old vs new WAJIB identik.
  // Implementasi "old-style" ditulis ulang independen di sini (bukan
  // memanggil fungsi baru dengan cara berbeda) supaya perbandingannya
  // benar-benar bisa gagal kalau refactor mengubah perilaku.
  {
    const oldStyleMatch = (needle: string, haystack: string): boolean =>
      haystack.toLocaleLowerCase('id-ID').includes(needle.toLocaleLowerCase('id-ID'));

    const equivalenceCases: Array<[string, string]> = [
      ['merosot', 'Performa gaming smartphone ini merosot setelah bermain lebih dari 30 menit'],
      ['MEROSOT', 'performa gaming smartphone ini merosot setelah bermain'],
      ['terjaga dengan baik', 'Kualitas speaker tetap terjaga dengan baik meski volume dinaikkan'],
      ['tidak ditemukan sama sekali', 'Detail warna dan kontras layar AMOLED']
    ];

    let equivalenceFailures = 0;
    for (const [needle, haystack] of equivalenceCases) {
      const oldResult = oldStyleMatch(needle, haystack);
      const newResult = excerptContainsNeedle(needle, haystack);
      if (oldResult !== newResult) {
        console.error(
          `   ❌ Test 5 (equivalence) GAGAL untuk needle="${needle}": old=${oldResult}, new=${newResult}`
        );
        equivalenceFailures++;
      }
    }

    checkBool(
      'Test 5 (equivalence lama-vs-baru pada string tanpa transformasi tambahan)',
      equivalenceFailures === 0,
      true
    );
  }

  console.log('\n  --- validateAssessmentLexicon ---');

  // Lexicon Test 1: dukungan leksikal normal → PASS
  check(
    'Lexicon Test 1 (positive lexical support)',
    validateAssessmentLexicon([{
      type: 'OPINION',
      reviewer_assessment: 'positive',
      source_excerpt: 'Produk ini tergolong oke untuk kebutuhan harian.'
    }]).status,
    'PASS'
  );

  // Lexicon Test 2: NBSP di antara kata lexicon multi-kata → PASS
  // (load-bearing: GAGAL di kode lama sebelum refactor, verifikasi manual:
  // "tergolong\u00A0oke".toLowerCase().includes("tergolong oke") === false)
  check(
    'Lexicon Test 2 (NBSP lexical support — genuinely load-bearing)',
    validateAssessmentLexicon([{
      type: 'OPINION',
      reviewer_assessment: 'positive',
      source_excerpt: 'Produk ini tergolong\u00A0oke untuk kebutuhan harian.'
    }]).status,
    'PASS'
  );

  // Lexicon Test 3: benar-benar tidak ada dukungan leksikal → FAIL
  check(
    'Lexicon Test 3 (no lexical support)',
    validateAssessmentLexicon([{
      type: 'OPINION',
      reviewer_assessment: 'positive',
      source_excerpt: 'Perangkat ini memiliki layar AMOLED 120Hz.'
    }]).status,
    'FAIL'
  );

  console.log('\n  --- validateSharedPredicateOwnership ---');

  const SPO_GROUP = [
    { subjects: ['speaker kiri', 'speaker kanan'], must_remain_single: true }
  ];

  // T1: TRUE POSITIVE — satu evidence memuat SEMUA subjek → PASS
  check(
    'SPO Test 1 (single evidence, full subject set → PASS)',
    validateSharedPredicateOwnership(
      [{
        source_excerpt: 'Speaker kiri dan speaker kanan pada laptop ini sama-sama terdengar pecah saat volume dinaikkan penuh.'
      }],
      SPO_GROUP
    ).status,
    'PASS'
  );

  // T2: PARTIAL SPLIT — subjek dipecah ke dua evidence terpisah,
  // tidak ada satupun yang memuat keduanya → FAIL
  check(
    'SPO Test 2 (partial split across 2 evidence → FAIL)',
    validateSharedPredicateOwnership(
      [
        { source_excerpt: 'Speaker kiri pada laptop ini terdengar pecah saat volume dinaikkan penuh.' },
        { source_excerpt: 'Speaker kanan pada laptop ini terdengar pecah saat volume dinaikkan penuh.' }
      ],
      SPO_GROUP
    ).status,
    'FAIL'
  );

  // T3: DUPLICATE FULL EXCERPT — proposisi lengkap disalin ke >1 evidence → FAIL
  check(
    'SPO Test 3 (duplicate full-excerpt split → FAIL)',
    validateSharedPredicateOwnership(
      [
        { source_excerpt: 'Speaker kiri dan speaker kanan pada laptop ini sama-sama terdengar pecah saat volume dinaikkan penuh.' },
        { source_excerpt: 'Speaker kiri dan speaker kanan pada laptop ini sama-sama terdengar pecah saat volume dinaikkan penuh.' }
      ],
      SPO_GROUP
    ).status,
    'FAIL'
  );

  // T4: NOT_FOUND — subjek tidak muncul sama sekali di evidence manapun → INCONCLUSIVE
  check(
    'SPO Test 4 (subjects tidak ditemukan sama sekali → INCONCLUSIVE)',
    validateSharedPredicateOwnership(
      [{ source_excerpt: 'Layar AMOLED perangkat ini sangat tajam dan cerah.' }],
      SPO_GROUP
    ).status,
    'INCONCLUSIVE'
  );

  // T5: UNRELATED SINGLE-SUBJECT MENTION — evidence lain menyentuh HANYA
  // SATU subjek (bukan fragmen dari proposisi shared-predicate yang sama).
  // Full match tetap ada di evidence lain → HARUS tetap PASS, bukan FAIL
  // palsu seperti pada desain union murni yang sudah ditolak.
  // CATATAN: evidence kedua SENGAJA hanya menyebut "speaker kiri" saja
  // (bukan keduanya) — kalau kalimat menyebut kedua subjek sekaligus
  // (meski untuk fakta independen), itu tetap secara sah ter-flag sebagai
  // full-match kedua oleh validator (containment murni per-subjek, tanpa
  // semantik) — bukan bug validator, tapi skenario berbeda dari yang
  // dimaksud T5.
  check(
    'SPO Test 5 (unrelated single-subject mention, full match tetap ada → PASS)',
    validateSharedPredicateOwnership(
      [
        { source_excerpt: 'Speaker kiri dan speaker kanan pada laptop ini sama-sama terdengar pecah saat volume dinaikkan penuh.' },
        { source_excerpt: 'Speaker kiri memiliki grill metal berbahan aluminium yang cukup kokoh.' }
      ],
      SPO_GROUP
    ).status,
    'PASS'
  );

  // T6: PARTIAL_EXTRACTION — hanya SATU subjek ditemukan (di satu evidence),
  // subjek lain tidak muncul sama sekali → INCONCLUSIVE, bukan FAIL/PASS
  // (tidak cukup informasi untuk menyimpulkan apakah ini bug split atau
  // memang bukan kasus shared-predicate ini)
  check(
    'SPO Test 6 (hanya 1 dari 2 subjek ditemukan → INCONCLUSIVE)',
    validateSharedPredicateOwnership(
      [{ source_excerpt: 'Speaker kiri pada laptop ini terdengar pecah saat volume dinaikkan penuh.' }],
      SPO_GROUP
    ).status,
    'INCONCLUSIVE'
  );

  if (failures > 0) {
    console.error(`\n🛑 Self-test GAGAL (${failures} kegagalan). Harness DIHENTIKAN — TIDAK ADA API call yang dikirim.\n`);
    process.exit(1);
  }

  console.log('\n  --- validateSubtopicNullAsymmetry ---');

  // ASYM Test 1: TRUE POSITIVE -- excerpt identik, satu subtopic null,
  // satu terisi -> FAIL (harus terdeteksi)
  check(
    'ASYM Test 1 (subtopic null-asimetris terdeteksi → FAIL)',
    validateSubtopicNullAsymmetry([
      { subtopic: 'selfie', source_excerpt: 'kamera selfie dan ultrawide perlu peningkatan' },
      { subtopic: null, source_excerpt: 'kamera selfie dan ultrawide perlu peningkatan' }
    ]).status,
    'FAIL'
  );

  // ASYM Test 2: NEGATIVE -- kedua subtopic terisi (beda) -> di luar
  // scope monitor ini (sudah ditangani gate MERGE production) -> PASS
  check(
    'ASYM Test 2 (kedua subtopic terisi, excerpt sama → PASS, di luar scope monitor)',
    validateSubtopicNullAsymmetry([
      { subtopic: 'selfie', source_excerpt: 'kamera selfie dan ultrawide perlu peningkatan' },
      { subtopic: 'ultrawide', source_excerpt: 'kamera selfie dan ultrawide perlu peningkatan' }
    ]).status,
    'PASS'
  );

  // ASYM Test 3: NEGATIVE -- kedua subtopic null -> bukan asimetri -> PASS
  check(
    'ASYM Test 3 (kedua subtopic null, excerpt sama → PASS, bukan asimetri)',
    validateSubtopicNullAsymmetry([
      { subtopic: null, source_excerpt: 'kamera selfie dan ultrawide perlu peningkatan' },
      { subtopic: null, source_excerpt: 'kamera selfie dan ultrawide perlu peningkatan' }
    ]).status,
    'PASS'
  );

  // ASYM Test 4: NEGATIVE -- excerpt BEDA, subtopic asimetris -> tidak
  // relevan (bukan pasangan shared-predicate-split candidate) -> PASS
  check(
    'ASYM Test 4 (excerpt berbeda, subtopic asimetris → PASS, tidak relevan)',
    validateSubtopicNullAsymmetry([
      { subtopic: 'selfie', source_excerpt: 'kamera selfie perlu peningkatan' },
      { subtopic: null, source_excerpt: 'baterai tahan 8 jam pemakaian normal' }
    ]).status,
    'PASS'
  );

  // ASYM Test 5: EDGE CASE -- kurang dari 2 evidence -> INCONCLUSIVE,
  // bukan PASS/FAIL diam-diam
  check(
    'ASYM Test 5 (evidence < 2 → INCONCLUSIVE)',
    validateSubtopicNullAsymmetry([
      { subtopic: 'selfie', source_excerpt: 'kamera selfie perlu peningkatan' }
    ]).status,
    'INCONCLUSIVE'
  );

    console.log('\n✅ Semua self-test lulus (normalizeForMatching() + validateExpectedTypeAssessment + validateAssessmentLexicon + validateSharedPredicateOwnership + validateSubtopicNullAsymmetry). Lanjut ke API call.\n');
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  runSelfTests();
  console.log('\n📊 E.3D — Reproducibility Harness (Production-Equivalent)\n');

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const manifestRaw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const manifest: Manifest = JSON.parse(manifestRaw);

  //const targetCases = manifest.cases.filter(
  //  c => ['REG-001B', 'REG-002', 'REG-005', 'REG-006', 'REG-007', 'REG-008', 'REG-009', 
  // 'REG-010A', 'REG-010B', 'REG-010C', 'REG-010D', 'REG-010E', 'EXP-B1', 'EXP-B2',
  // 'EXP-D1', 'EXP-D2', 'EXP-E', 'EXP-F1', 'EXP-F2', 'EXP-C1', 'EXP-C2', 'EXP-G1', 'EXP-G2'].includes(c.case_id)
  //);

  // Jadi (khusus untuk retry REG-008 saja):
  const targetCases = manifest.cases.filter(
    c => ['EXP-G1', 'EXP-G2'].includes(c.case_id)
  );

  // Kelompokkan case berdasarkan fixture
  const fixtureGroups = new Map<string, ManifestCase[]>();
  for (const caseDef of targetCases) {
    const key = caseDef.fixture;
    const group = fixtureGroups.get(key) ?? [];
    group.push(caseDef);
    fixtureGroups.set(key, group);
  }

  for (const [fixture, casesInGroup] of fixtureGroups) {
    const metadataSignature = (m?: ReviewMetadata) => JSON.stringify(m ?? {});
    const allSameMetadata = casesInGroup.every(
      c => metadataSignature(c.metadata) === metadataSignature(casesInGroup[0].metadata)
    );

    if (!allSameMetadata) {
      console.warn(
        `⚠️  Fixture ${fixture} dipakai case dengan metadata BERBEDA -- ` +
        `tidak bisa digabung, fallback ke generation terpisah per case.`
      );
      for (const caseDef of casesInGroup) {
        await runCaseIsolated(caseDef);
      }
      continue;
    }

    console.log(
      `\n📦 Fixture: ${fixture} (dipakai oleh: ${casesInGroup.map(c => c.case_id).join(', ')})\n`
    );

    // Reset lebih dulu SEMUA caseDir dalam grup ini, sebelum run
    // pertama ditulis. Ini menghapus file run-*.json/summary.json
    // sisa sesi sebelumnya (mis. bekas RUNS=5 yang sekarang RUNS=3)
    // supaya tidak ada kontaminasi apa pun pada summary di bawah.
    const caseDirs = new Map<string, string>();
    for (const caseDef of casesInGroup) {
      const caseDir = path.join(OUTPUT_DIR, caseDef.case_id);
      resetCaseDir(caseDir);
      caseDirs.set(caseDef.case_id, caseDir);
    }

    // Akumulasi hasil IN-MEMORY per case_id selama eksekusi berjalan.
    // Summary WAJIB dihitung dari sini, BUKAN dari readdirSync — lihat
    // catatan bug lama di changelog: readdirSync menghitung ulang isi
    // folder dan bisa ikut menghitung file lama yang gagal terhapus.
    const resultsByCase = new Map<string, ReproducibilityArtifact[]>();
    for (const caseDef of casesInGroup) {
      resultsByCase.set(caseDef.case_id, []);
    }

    for (let run = 1; run <= RUNS; run++) {
      console.log(`   Run #${run}... (1 generation → ${casesInGroup.map(c => c.case_id).join(', ')})`);

      const generation = await generateForFixture(casesInGroup[0], run);

      for (const caseDef of casesInGroup) {
        const result = validateForCase(caseDef, run, generation);
        resultsByCase.get(caseDef.case_id)!.push(result);

        const caseDir = caseDirs.get(caseDef.case_id)!;
        const outputPath = path.join(caseDir, `run-${String(run).padStart(2, '0')}.json`);
        fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');

        console.log(
          `      [${caseDef.case_id}] Validation: ${result.validation.status}` +
          (result.validation.violations.length > 0
            ? ` -- ${result.validation.violations.join('; ')}`
            : '')
        );
      }
    }

    // Summary per case — dihitung dari resultsByCase (in-memory,
    // persis RUNS entri), bukan dari isi direktori.
    for (const caseDef of casesInGroup) {
      const caseDir = caseDirs.get(caseDef.case_id)!;
      const results = resultsByCase.get(caseDef.case_id)!;

      const passCount = results.filter(r => r.validation.status === 'PASS').length;
      const failCount = results.filter(r => r.validation.status === 'FAIL').length;
      const inconclusiveCount = results.filter(r => r.validation.status === 'INCONCLUSIVE').length;

      const summary: ReproducibilitySummary = {
        case_id: caseDef.case_id,
        runs: results.length,
        pass: passCount,
        fail: failCount,
        inconclusive: inconclusiveCount
      };

      const summaryPath = path.join(caseDir, 'summary.json');
      fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

      console.log(`   📊 ${caseDef.case_id}: ${JSON.stringify(summary)}`);
    }
  }

  console.log('============================================');
  console.log(`📊 E.3D selesai. Output: ${OUTPUT_DIR}`);
  console.log('============================================\n');
}

main();