// ============================================================
// ASSESSMENT VALIDATOR
// ============================================================
// Hanya OPINION yang boleh memiliki reviewer_assessment.
// Semua type lain WAJIB null.
//
// RIWAYAT VERSI (ASSESSMENT_RULES_VERSION; dicetak oleh replay-run.ts)
//   legacy        : sebelum versi dilabeli. Semua kata evaluatif pada type
//                   non-OPINION = SUSPECT HIGH (karantina); claim + excerpt
//                   dipindai sekaligus; frasa whitelist / discourse "cukup"
//                   meloloskan SELURUH teks.
//   assessment-v2 : (1) whitelist & discourse "cukup" hanya menetralkan frasa
//                       itu sendiri, bukan seluruh teks;
//                   (2) "kurang dari" (perbandingan angka) dinetralkan;
//                   (3) "cukup untuk/bisa/kalau/saja" tidak lagi dianggap
//                       discourse marker (itu penilaian: "cukup untuk seharian");
//                   (4) severity bergantung type: FACT/MEASUREMENT/type tak
//                       dikenal + kata evaluatif DI KLAIM = HIGH (karantina);
//                       OBSERVATION/RECOMMENDATION/COMPARISON/CLAIM dan hit
//                       yang hanya ada di excerpt = LOW (diterima + flag);
//                   (5) type di-trim; placeholder "null"/"none"/"n/a"/"-" pada
//                       reviewer_assessment dianggap kosong.
//
// Mengapa LOW dan bukan retype ke OPINION: OPINION wajib punya
// reviewer_assessment (aturan 1 di bawah). Mengubah type tanpa mengarang
// polaritas hanya memindahkan item ke karantina yang sama. Item tetap diterima
// apa adanya dan ditandai, jadi tidak ada informasi yang hilang.
// ============================================================

import type { ValidationResult } from '../types';

export const ASSESSMENT_RULES_VERSION = 'assessment-v2';

const ALLOWED_TYPES_FOR_ASSESSMENT = ['OPINION'];

// Type yang kata evaluatifnya DI KLAIM hanya ditandai (severity LOW).
// Type lain (FACT, MEASUREMENT, tak dikenal) tetap memblokir (HIGH).
const FLAG_ONLY_TYPES = new Set(['OBSERVATION', 'RECOMMENDATION', 'COMPARISON', 'CLAIM']);

// Nilai placeholder yang berarti "kosong" (model kadang menulis "null" sebagai
// string; normalisasi di hulu seharusnya sudah membersihkannya, ini jaring kedua).
const NULLISH_ASSESSMENT = new Set(['', 'null', 'none', 'n/a', 'na', '-', 'undefined']);

// Keputusan kebijakan (audit 8 run, 3 video): 'agak' DIHAPUS dari leksikon.
// 'agak' adalah kata penguat deskriptif ("agak lama", "agak hitam",
// "agak berbeda"), bukan penilaian. Penilaian sungguhan ("agak jelek") tetap
// tertangkap lewat kata evaluatif lain ('jelek').
export const EVALUATIVE_WORDS: readonly string[] = [
  'cukup', 'cukup jelas', 'cukup bagus', 'cukup luas', 'cukup stabil',
  'mantap', 'bagus', 'cakep', 'jelek', 'kurang', 'buruk', 'cakep banget',
  'tergolong', 'terbilang', 'memadai', 'minim', 'jauh lebih', 'luar biasa'
];

// Idiom yang mengandung kata leksikon tetapi BUKAN penilaian. Dinetralkan
// (dibuang dari teks) sebelum pencocokan.
//   "kurang lebih" = "kira-kira"
//   "kurang dari"  = "< angka" (mis. "kurang dari 3 juta")
const NEUTRAL_IDIOMS: RegExp[] = [
  /\bkurang\s+lebih\b/gi,
  /\bkurang\s+dari\b/gi
];

// "cukup" sebagai discourse marker (bukan penilaian):
//   "cukup kalian pakai mode ini"   -> kata ganti orang kedua/pertama jamak
//   "cukup sekian", "cukup segitu"  -> penutup
//   "Cukup tekan kalian ..."        -> satu kata sisip, hanya di awal kalimat
// Sengaja TIDAK termasuk: untuk, bisa, kalau, saja. "Baterai cukup untuk
// seharian" dan "cukup bisa diandalkan" adalah penilaian.
const DISCOURSE_CUKUP: RegExp[] = [
  /\bcukup\s+(?:kalian|kamu|anda|kita|sekian|segitu|gitu)\b/gi,
  /(^|[.!?]\s+)cukup\s+[a-z]+\s+(?:kalian|kamu|anda|kita)\b/gi
];

// Whitelist frasa teknis. Hanya frasa yang benar-benar MENGANDUNG kata
// leksikon yang berguna di sini (frasa lain tidak punya efek). Sejak
// assessment-v2 hanya frasa itu yang dinetralkan; kata evaluatif lain di
// teks yang sama tetap dihitung.
export const TECHNICAL_WHITELIST_PHRASES: readonly string[] = [
  'minim noise',
  'noise-nya itu minim',
  'noise nya itu minim',
  'minim jitter',
  'tergolong konsisten',
  'tergolong tipis'
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Dikompilasi sekali. Word-boundary agar "berkurang" tidak cocok dengan "kurang".
const LEXICON = EVALUATIVE_WORDS.map(w => ({
  w,
  re: new RegExp(`(^|[^a-z])${escapeRe(w)}([^a-z]|$)`, 'i')
}));

const WHITELIST_REGEXES = TECHNICAL_WHITELIST_PHRASES.map(
  p => new RegExp(`(^|[^a-z])${escapeRe(p)}(?=[^a-z]|$)`, 'gi')
);

function discourseReplacer(_m: string, ...rest: unknown[]): string {
  // Regex tanpa grup: rest[0] adalah offset (number). Dengan grup: string awal kalimat.
  return typeof rest[0] === 'string' ? `${rest[0]} ` : ' ';
}

/** Buang idiom, frasa whitelist, dan "cukup" discourse dari teks (hanya frasa itu). */
function neutralize(raw: string): string {
  let t = raw;
  for (const re of NEUTRAL_IDIOMS) t = t.replace(re, ' ');
  for (const re of WHITELIST_REGEXES) t = t.replace(re, '$1 ');
  for (const re of DISCOURSE_CUKUP) t = t.replace(re, discourseReplacer);
  return t;
}

/**
 * Kata evaluatif yang tersisa SETELAH netralisasi idiom / whitelist /
 * discourse. Satu-satunya sumber kebenaran untuk keputusan di validate().
 */
export function findEvaluativeWords(rawText: string): string[] {
  const text = neutralize(rawText);
  return LEXICON.filter(({ re }) => re.test(text)).map(({ w }) => w);
}

function hasAssessmentValue(v: string | null | undefined): boolean {
  if (v === null || v === undefined) return false;
  return !NULLISH_ASSESSMENT.has(String(v).trim().toLowerCase());
}

export const AssessmentValidator = {
  validate(
    type: string | undefined,
    reviewerAssessment: string | null | undefined,
    claim?: string | null,
    sourceExcerpt?: string | null
  ): ValidationResult {
    const normalizedType = String(type ?? '').trim().toUpperCase() || 'OPINION';
    const hasAssessment = hasAssessmentValue(reviewerAssessment);

    // Aturan 0: non-OPINION tidak boleh punya assessment
    if (hasAssessment && !ALLOWED_TYPES_FOR_ASSESSMENT.includes(normalizedType)) {
      return {
        pass: false,
        status: 'FAIL',
        rule: 'ASSESSMENT',
        reason: `${normalizedType} tidak boleh memiliki reviewer_assessment (hanya OPINION yang boleh)`,
        severity: 'HIGH'
      };
    }

    // Aturan 1: OPINION wajib punya assessment
    if (normalizedType === 'OPINION' && !hasAssessment) {
      return {
        pass: false,
        status: 'SUSPECT',
        rule: 'ASSESSMENT',
        reason: 'OPINION wajib memiliki reviewer_assessment',
        severity: 'HIGH'
      };
    }

    // Aturan 2: non-OPINION tetapi mengandung kata evaluatif
    if (!ALLOWED_TYPES_FOR_ASSESSMENT.includes(normalizedType)) {
      // Klaim dan excerpt dipindai TERPISAH. Excerpt adalah kutipan literal
      // yang sering memuat kalimat tetangga; hit yang hanya ada di sana tidak
      // pernah memblokir.
      const claimHits = findEvaluativeWords(claim || '');
      const excerptHits = findEvaluativeWords(sourceExcerpt || '');
      const all = Array.from(new Set([...claimHits, ...excerptHits]));

      if (all.length > 0) {
        const blocks = claimHits.length > 0 && !FLAG_ONLY_TYPES.has(normalizedType);
        const severity: 'HIGH' | 'LOW' = blocks ? 'HIGH' : 'LOW';
        const triggers = all.slice(0, 3).map(w => `"${w}"`).join(', ');
        let reason =
          `Type ${normalizedType} mengandung kata evaluatif — kemungkinan salah klasifikasi [kata: ${triggers}]`;
        if (!blocks) {
          reason += claimHits.length === 0
            ? ' (kata hanya ada di source_excerpt; ditandai saja)'
            : ' (ditandai saja, tidak memblokir)';
        }
        return { pass: false, status: 'SUSPECT', rule: 'ASSESSMENT', reason, severity };
      }
    }

    return { pass: true, status: 'PASS', rule: 'ASSESSMENT', severity: 'LOW' };
  }
};
