// ============================================================
// TEXT MATCHING — SHARED SURFACE-TEXT NORMALIZATION PRIMITIVE
// ============================================================
// Single source of truth untuk normalizeForMatching() dan wrapper
// containment-nya. Dipindah dari reproducibility-harness.ts (riset)
// supaya modul production (duplicate.ts, dst.) memakai primitive
// normalisasi YANG SAMA PERSIS dengan yang dipakai mengukur
// reproducibility E.3D -- mencegah drift riset vs production.
//
// BUKAN bagian dari production-pipeline.ts (SRT parsing, chunking,
// evidence JSON parsing, prompt builder) -- text matching adalah
// concern independen, konsisten dengan pola srt.ts/types.ts yang
// sudah terpisah di codebase ini. Lihat rangkuman-audit-shared-
// predicate-duplicate-split.md bagian 5 untuk konteks keputusan.
//
// PERILAKU TIDAK BERUBAH dari implementasi asli di
// reproducibility-harness.ts -- ini PEMINDAHAN, bukan rewrite.
// Spesifikasi 7-step (NBSP, unicode quote, trim, collapse whitespace,
// case-fold id-ID, strip trailing '.' non-ellipsis, trim ulang) sudah
// terkunci lewat 14 self-test assertion yang tetap berjalan di harness.
// ============================================================

export function normalizeForMatching(text: string): string {
  if (typeof text !== 'string') return '';

  let result = text;

  result = result.replace(/\u00A0/g, ' ');
  result = result.replace(/[\u2018\u2019]/g, "'");
  result = result.replace(/[\u201C\u201D]/g, '"');
  result = result.trim();
  result = result.replace(/[-–—_]/g, ' ');
  result = result.replace(/\s+/g, ' ');
  result = result.toLocaleLowerCase('id-ID');

  if (result.length === 1 && result === '.') {
    result = '';
  } else if (
    result.length >= 2 &&
    result.endsWith('.') &&
    result[result.length - 2] !== '.'
  ) {
    result = result.slice(0, -1);
  }

  result = result.replace(/\s+$/, '');

  return result;
}

/** needle = proposition, haystack = excerpt (riset: validateRequiredPropositions) */
export function propositionMatchesExcerpt(proposition: string, excerpt: string): boolean {
  return normalizeForMatching(excerpt).includes(normalizeForMatching(proposition));
}

/** needle = excerpt, haystack = chunkText (riset: validateLiteralExcerpt) */
export function excerptMatchesChunk(excerpt: string, chunkText: string): boolean {
  return normalizeForMatching(chunkText).includes(normalizeForMatching(excerpt));
}

/** Containment generik, tanpa asumsi arah needle/haystack tertentu. */
export function containsNormalized(needle: string, haystack: string): boolean {
  return normalizeForMatching(haystack).includes(normalizeForMatching(needle));
}

/** Kesetaraan penuh pasca-normalisasi -- untuk field bervocab terkontrol (mis. subtopic). */
export function equalsNormalized(a: string, b: string): boolean {
  return normalizeForMatching(a) === normalizeForMatching(b);
}