// ============================================================
// GROUNDING VALIDATOR — existence only (pasca-redesign)
// ============================================================
// Keberadaan >1 match BUKAN urusan Grounding. Ambiguitas adalah
// domain Provenance. Grounding tidak lagi pernah mengembalikan
// SUSPECT.
// ============================================================

import type {
  EvidenceContext,
  ValidationResult
} from '../types';
import { findSourceMatches, excerptContainsEllipsis } from '../search';

export const GroundingValidator = {
  validate(
    sourceExcerpt: string | null | undefined,
    context: EvidenceContext
  ): ValidationResult {
    const matches = findSourceMatches(sourceExcerpt, context);

    if (matches.length === 0) {
      // Elipsis TIDAK mengubah keputusan (tetap FAIL seperti sebelumnya
      // untuk 0 match) -- hanya memperjelas alasan agar mudah dibedakan
      // dari kasus paraphrase biasa saat ditinjau manual.
      const reason = excerptContainsEllipsis(sourceExcerpt)
        ? 'source_excerpt mengandung elipsis ("..." atau "…") dan tidak ditemukan di originating chunk -- indikasi excerpt bukan kutipan literal berurutan, melainkan rangkuman/gabungan fragmen non-kontinu'
        : 'source_excerpt tidak ditemukan di originating chunk';

      return {
        pass: false,
        status: 'FAIL',
        rule: 'GROUNDING',
        reason,
        severity: 'CRITICAL'
      };
    }

    return {
      pass: true,
      status: 'PASS',
      rule: 'GROUNDING',
      severity: 'LOW'
    };
  }
};