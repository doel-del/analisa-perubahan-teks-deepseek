// ============================================================
// PROVENANCE VALIDATOR
// ============================================================
// Tanggung jawab:
//   1. Menentukan existence (via findSourceMatches) → FAIL jika 0.
//   2. Mendelegasikan occurrence disambiguation ke
//      resolveProvenanceAnchor() → RESOLVED / AMBIGUOUS.
//
// Resolver internal sengaja TIDAK menangani FAIL — status-nya
// hanya RESOLVED | AMBIGUOUS (dikunci audit Ronde 3). FAIL
// dibangun di sini dari sinyal existence, karena "existence" adalah
// domain findSourceMatches / Grounding, bukan domain resolver.
// ============================================================

import type {
  EvidenceContext,
  SourceCoordinates,
  ValidationResult
} from '../types';
import { findSourceMatches, excerptContainsEllipsis } from '../search';
import { resolveProvenanceAnchor } from './anchor-resolver';

export const ProvenanceValidator = {
  resolve(
    sourceExcerpt: string | null | undefined,
    anchor: string | null | undefined,
    context: EvidenceContext
  ): {
    coordinates: SourceCoordinates | null;
    result: ValidationResult;
  } {
    // Existence gate. Bukan tanggung jawab resolver — resolver
    // berasumsi candidate set sudah non-empty ketika dipanggil.
    const matches = findSourceMatches(sourceExcerpt, context);

    if (matches.length === 0) {
      // Sama seperti GroundingValidator: elipsis TIDAK mengubah
      // keputusan (tetap FAIL), hanya memperjelas alasan.
      const reason = excerptContainsEllipsis(sourceExcerpt)
        ? 'source_excerpt mengandung elipsis ("..." atau "…") dan tidak ditemukan di originating chunk -- indikasi excerpt bukan kutipan literal berurutan, melainkan rangkuman/gabungan fragmen non-kontinu'
        : 'source_excerpt tidak ditemukan di originating chunk';

      return {
        coordinates: null,
        result: {
          pass: false,
          status: 'FAIL',
          rule: 'PROVENANCE',
          reason,
          severity: 'CRITICAL'
        }
      };
    }

    // Occurrence disambiguation. ≥1 match di sini.
    const resolution = resolveProvenanceAnchor(
      sourceExcerpt,
      anchor,
      context
    );

    if (resolution.status === 'AMBIGUOUS') {
      // N8: Excerpt pendek (<20 karakter) sering ambigu karena muncul di
      // multiple spec serupa (mis. "bukaan f/2.2" untuk selfie & ultrawide).
      // Turunkan severity ke MEDIUM sehingga tidak quarantine.
      // Excerpt panjang yang ambigu tetap HIGH.
      const isShortExcerpt = (sourceExcerpt || '').length < 20;

      return {
        coordinates: null,
        result: {
          pass: true,
          status: 'SUSPECT',
          rule: 'PROVENANCE',
          reason: 'source_excerpt ambiguous, lebih dari satu kemungkinan occurrence',
          severity: isShortExcerpt ? 'MEDIUM' : 'HIGH'
        }
      };
    }

    // resolution.status === 'RESOLVED'
    return {
      coordinates: resolution.coordinates,
      result: {
        pass: true,
        status: 'PASS',
        rule: 'PROVENANCE',
        severity: 'LOW'
      }
    };
  }
};