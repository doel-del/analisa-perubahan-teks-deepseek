// ============================================================
// ASSESSMENT VALIDATOR
// ============================================================
// Hanya OPINION yang boleh memiliki reviewer_assessment.
// Semua type lain WAJIB null.
// ============================================================

import type { ValidationResult } from '../types';

const ALLOWED_TYPES_FOR_ASSESSMENT = ['OPINION'];

// Keputusan kebijakan (audit 8 run, 3 video): 'agak' DIHAPUS dari leksikon.
// 'agak' adalah kata penguat deskriptif ("agak lama", "agak hitam",
// "agak berbeda"), bukan penilaian. Sebagai satu-satunya pemicu, ia
// mengkarantina klaim non-evaluatif di setiap run. Penilaian sungguhan
// ("agak jelek") tetap tertangkap lewat kata evaluatif lain ('jelek').
const EVALUATIVE_WORDS = [
  'cukup', 'cukup jelas', 'cukup bagus', 'cukup luas', 'cukup stabil',
  'mantap', 'bagus', 'cakep', 'jelek', 'kurang', 'buruk', 'cakep banget',
  'tergolong', 'terbilang', 'memadai', 'minim', 'jauh lebih', 'luar biasa'
];

// Idiom yang mengandung kata leksikon tetapi BUKAN penilaian. Dinetralkan
// sebelum pencocokan. "kurang lebih" = "kira-kira"; tanpa ini kata 'kurang'
// memicu pada setiap perbandingan "kurang lebih mirip".
const NEUTRAL_IDIOMS: RegExp[] = [
  /\bkurang\s+lebih\b/gi
];

function neutralizeIdioms(text: string): string {
  return NEUTRAL_IDIOMS.reduce((t, re) => t.replace(re, ' '), text);
}

// N6: Whitelist frasa teknis. Frasa ini mengandung kata evaluatif
// (minim, tergolong, agak) tetapi dalam konteks teknis/terukur.
// Dikonfirmasi dari audit 4-run transkrip lab-style.
const TECHNICAL_WHITELIST_PHRASES = [
  'minim noise',
  'noise-nya itu minim',
  'noise nya itu minim',
  'minim jitter',
  'tergolong konsisten',
  'tetap konsisten',
  'agak goyang',
  'sedikit goyang',
  'tergolong tipis',
  'simpel dan minimalis',
  'sudah mulai menurun',
  'mulai menurun',
  'masih terjaga',
  'terjaga dengan baik'
];

// N6: Word-boundary matching untuk menghindari false positive substring.
// Contoh: "kurang" di dalam "berkurang" bukan kata evaluatif.
export function findEvaluativeWords(rawText: string): string[] {
  const text = neutralizeIdioms(rawText);
  return EVALUATIVE_WORDS.filter(w => {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i');
    return regex.test(text);
  });
}

function containsEvaluativeWord(text: string): boolean {
  return findEvaluativeWords(text).length > 0;
}

function isWhitelistedTechnicalPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return TECHNICAL_WHITELIST_PHRASES.some(phrase =>
    lower.includes(phrase)
  );
}

// Cek apakah "cukup" di sini adalah discourse marker, bukan evaluatif
function isDiscourseMarkerCukup(text: string): boolean {
  const lower = text.toLowerCase();

  // "cukup" diikuti kata kerja imperatif, kata ganti orang, atau kata sambung
  // → discourse marker, artinya "sederhananya / singkatnya"
  if (/\bcukup\s+(kalian|kamu|anda|kita|bisa|untuk|kalau|saja|sekian|gitu)\b/i.test(lower)) {
    return true;
  }

  // "cukup" di awal segmen sebelum subjek orang
  if (/(^|\.\s+)cukup\s+(?:[a-z]+\s+)?(?:kalian|kamu|anda|kita|bisa)\b/i.test(lower)) {
    return true;
  }

  return false;
}

export const AssessmentValidator = {
  validate(
    type: string | undefined,
    reviewerAssessment: string | null | undefined,
    claim?: string | null,
    sourceExcerpt?: string | null
  ): ValidationResult {
    const normalizedType = (type || 'OPINION').toUpperCase();

    const hasAssessment =
      reviewerAssessment !== null &&
      reviewerAssessment !== undefined &&
      String(reviewerAssessment).trim() !== '';

    // Rule lama: non-OPINION tidak boleh punya assessment
    if (hasAssessment && !ALLOWED_TYPES_FOR_ASSESSMENT.includes(normalizedType)) {
      return {
        pass: false,
        status: 'FAIL',
        rule: 'ASSESSMENT',
        reason: `${normalizedType} tidak boleh memiliki reviewer_assessment (hanya OPINION yang boleh)`,
        severity: 'HIGH'
      };
    }

    // Rule baru 1: OPINION wajib punya assessment
    if (normalizedType === 'OPINION' && !hasAssessment) {
      return {
        pass: false,
        status: 'SUSPECT',
        rule: 'ASSESSMENT',
        reason: 'OPINION wajib memiliki reviewer_assessment',
        severity: 'HIGH'
      };
    }

    // Rule baru 2: non-OPINION tapi mengandung kata evaluatif
    if (!ALLOWED_TYPES_FOR_ASSESSMENT.includes(normalizedType)) {
      const text = (claim || '') + ' ' + (sourceExcerpt || '');

      // N7.a: Jika seluruh teks hanya mengandung frasa teknis yang
      // di-whitelist, tidak perlu SUSPECT.
      if (isWhitelistedTechnicalPhrase(text)) {
        return {
          pass: true,
          status: 'PASS',
          rule: 'ASSESSMENT',
          severity: 'LOW'
        };
      }

      // N7.b: Word-boundary matching (bukan substring).
      if (containsEvaluativeWord(text) && !isDiscourseMarkerCukup(text)) {
        // Sebutkan kata pemicu agar mudah ditinjau (tidak mengubah keputusan).
        const triggers = findEvaluativeWords(text)
          .slice(0, 3)
          .map(w => `"${w}"`)
          .join(', ');
        return {
          pass: false,
          status: 'SUSPECT',
          rule: 'ASSESSMENT',
          reason: `Type ${normalizedType} mengandung kata evaluatif — kemungkinan salah klasifikasi [kata: ${triggers}]`,
          severity: 'HIGH'
        };
      }
    }

    return { pass: true, status: 'PASS', rule: 'ASSESSMENT', severity: 'LOW' };
  }
};
