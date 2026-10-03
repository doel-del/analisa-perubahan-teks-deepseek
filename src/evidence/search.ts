// ============================================================
// EVIDENCE SEARCH HELPER
// ============================================================
// Digunakan oleh GroundingValidator dan ProvenanceValidator.
// Mencari source_excerpt dalam originating chunk.
// ============================================================

import type { EvidenceContext, SegmentMatch } from './types';
import { normalizeForSearch } from './srt';

// ------------------------------------------------------------
// DETEKSI ELIPSIS — penanda kuat bahwa excerpt adalah gabungan
// fragmen non-kontinu (bukan kutipan literal berurutan).
// Dipakai HANYA untuk memperjelas PESAN di dalam kondisi yang
// SUDAH FAIL (0 match) -- BUKAN gate independen. Kalau elipsis
// dijadikan gate independen, excerpt yang literal memang
// mengandung "..." di transkrip asli (reviewer bicara terbata-
// bata) bisa salah dihukum padahal excerpt-nya valid dan tetap
// cocok lewat findSourceMatches.
// ------------------------------------------------------------
export function excerptContainsEllipsis(excerpt: string | null | undefined): boolean {
  return /\.{3,}|…/.test(excerpt || '');
}

export function findSourceMatches(
  sourceExcerpt: string | null | undefined,
  context: EvidenceContext
): SegmentMatch[] {
  const excerpt = normalizeForSearch(sourceExcerpt || '');

  if (!excerpt) {
    return [];
  }

  const matches: SegmentMatch[] = [];

  // 1. Exact normalized: single segment
  for (const segment of context.chunkSegments) {
    const segText = normalizeForSearch(segment.text);
    if (segText.includes(excerpt)) {
      matches.push({
        segmentStartIndex: segment.index,
        segmentEndIndex: segment.index
      });
    }
  }

  // 2. Exact normalized: 2 contiguous segments
  for (let i = 0; i < context.chunkSegments.length - 1; i++) {
    const combined = normalizeForSearch(
      context.chunkSegments[i].text + ' ' +
      context.chunkSegments[i + 1].text
    );

    if (combined.includes(excerpt)) {
      const seg1 = normalizeForSearch(context.chunkSegments[i].text);
      const seg2 = normalizeForSearch(context.chunkSegments[i + 1].text);

      const isEntirelyInSeg1 = seg1.includes(excerpt);
      const isEntirelyInSeg2 = seg2.includes(excerpt);

      if (!isEntirelyInSeg1 && !isEntirelyInSeg2) {
        matches.push({
          segmentStartIndex: context.chunkSegments[i].index,
          segmentEndIndex: context.chunkSegments[i + 1].index
        });
      }
    }
  }

  
  // 3. Exact normalized: 3..N contiguous segments (N=6)
  const MAX_SPAN = 6;
  for (let span = 3; span <= MAX_SPAN; span++) {
    for (let i = 0; i + span <= context.chunkSegments.length; i++) {
      const window = context.chunkSegments.slice(i, i + span);
      const combined = normalizeForSearch(
        window.map(s => s.text).join(' ')
      );

      if (!combined.includes(excerpt)) continue;

      // Skip if fully contained in any smaller sub-span (already found)
      let containedInSmaller = false;
      for (let sub = 1; sub < span; sub++) {
        for (let j = 0; j + sub <= window.length; j++) {
          const subCombined = normalizeForSearch(
            window.slice(j, j + sub).map(s => s.text).join(' ')
          );
          if (subCombined.includes(excerpt)) {
            containedInSmaller = true;
            break;
          }
        }
        if (containedInSmaller) break;
      }

      if (!containedInSmaller) {
        matches.push({
          segmentStartIndex: window[0].index,
          segmentEndIndex: window[window.length - 1].index
        });
      }
    }
  }

  // Dedup final berdasarkan span unik
  const unique = new Map<string, SegmentMatch>();

  for (const match of matches) {
    const key = `${match.segmentStartIndex}:${match.segmentEndIndex}`;
    unique.set(key, match);
  }

  return [...unique.values()];
}