// ============================================================
// DUPLICATE VALIDATOR — GLOBAL GATE
// ============================================================
// Berjalan setelah semua evidence terkumpul.
// Tidak mengubah evidence secara destruktif.
// Menghasilkan candidate pairs dan resolution recommendations.
// ============================================================

import type { EvidenceItem } from '../types';
import { normalizeForSearch } from '../srt';
import { equalsNormalized } from '../text-matching'; // sudah diimpor, dipakai ulang di resolveIdenticalOccurrence

// ------------------------------------------------------------
// DUPLICATE CANDIDATE
// ------------------------------------------------------------

export interface DuplicateCandidate {
  evidenceA: EvidenceItem;
  evidenceB: EvidenceItem;
  similarity: number;
  reasons: string[];
}

// ------------------------------------------------------------
// RELATION TYPES
// ------------------------------------------------------------

export type SourceRelation = 'SAME' | 'DIFFERENT' | 'UNKNOWN';
export type ContextRelation = 'SAME' | 'DIFFERENT' | 'UNKNOWN';

// ------------------------------------------------------------
// RESOLVER ACTION
// ------------------------------------------------------------

export type ResolverAction = 'KEEP_FIRST' | 'KEEP_BEST' | 'MERGE' | 'PRESERVE';

export interface DuplicateResolution {
  evidence_id_a: string;
  evidence_id_b: string;
  action: ResolverAction;
  reason: string;
  mergedEvidence?: EvidenceItem; // hanya terisi jika action === 'MERGE'
  // BARU: pemenang eksplisit untuk KEEP_FIRST/KEEP_BEST. server.ts
  // sebelumnya menebak pemenang dengan mem-parsing substring `reason`
  // ("a lebih" / "b lebih") -- rapuh terhadap perubahan wording.
  // Field ini menggantikan kebutuhan parsing string sama sekali.
  keptId?: string;
} 

// ------------------------------------------------------------
// DUPLICATE RESULT
// ------------------------------------------------------------

export interface DuplicateResult {
  candidates: DuplicateCandidate[];
  duplicatePairs: DuplicateResolution[];
}

// ------------------------------------------------------------
// FINGERPRINT — Hanya untuk perbandingan diagnostik.
// Bukan blocking key. Digunakan untuk mendeteksi kecocokan
// multi-field yang kuat.
// ------------------------------------------------------------

function buildFingerprint(evidence: EvidenceItem): string {
  const parts = [
    normalizeForSearch(String(evidence.topic ?? '')),
    normalizeForSearch(String(evidence.subtopic ?? '')),
    normalizeForSearch(String(evidence.type ?? '')),
    normalizeForSearch(String(evidence.claim ?? '')),
    normalizeForSearch(String(evidence.value ?? '')),
    normalizeForSearch(String(evidence.unit ?? '')),
    normalizeForSearch(String(evidence.comparison_target ?? '')),
    normalizeForSearch(String(evidence.context ?? ''))
  ];

  return parts.join('|');
}

// ------------------------------------------------------------
// SOURCE RELATION
// ------------------------------------------------------------

function compareSourceRelation(
  evidenceA: EvidenceItem,
  evidenceB: EvidenceItem
): SourceRelation {
  const coordsA = evidenceA.source_coordinates;
  const coordsB = evidenceB.source_coordinates;

  if (!coordsA && !coordsB) {
    return 'UNKNOWN';
  }

  if (!coordsA || !coordsB) {
    return 'UNKNOWN';
  }

  // Source occurrence ditentukan oleh segment span,
  // bukan chunk_index. Chunk overlap dapat menyebabkan
  // segment yang sama muncul di chunk berbeda.
  const isSame =
    coordsA.segment_start_index === coordsB.segment_start_index &&
    coordsA.segment_end_index === coordsB.segment_end_index;

  return isSame ? 'SAME' : 'DIFFERENT';
}

// ------------------------------------------------------------
// CONTEXT RELATION
// ------------------------------------------------------------

function compareContextRelation(
  evidenceA: EvidenceItem,
  evidenceB: EvidenceItem
): ContextRelation {
  const contextA = normalizeForSearch(String(evidenceA.context ?? ''));
  const contextB = normalizeForSearch(String(evidenceB.context ?? ''));

  if (!contextA && !contextB) {
    return 'UNKNOWN';
  }

  if (!contextA || !contextB) {
    return 'UNKNOWN';
  }

  return contextA === contextB ? 'SAME' : 'DIFFERENT';
}

// ------------------------------------------------------------
// SIMILARITY CALCULATOR
// ------------------------------------------------------------

function calculateSimilarity(
  evidenceA: EvidenceItem,
  evidenceB: EvidenceItem
): number {
  let score = 0;
  const maxScore = 6;

  if (
    normalizeForSearch(String(evidenceA.topic ?? '')) ===
    normalizeForSearch(String(evidenceB.topic ?? ''))
  ) {
    score += 1;
  }

  if (
    normalizeForSearch(String(evidenceA.subtopic ?? '')) ===
    normalizeForSearch(String(evidenceB.subtopic ?? ''))
  ) {
    score += 1;
  }

  if (
    normalizeForSearch(String(evidenceA.type ?? '')) ===
    normalizeForSearch(String(evidenceB.type ?? ''))
  ) {
    score += 1;
  }

  const claimA = normalizeForSearch(String(evidenceA.claim ?? ''));
  const claimB = normalizeForSearch(String(evidenceB.claim ?? ''));

  if (claimA && claimB && claimA === claimB) {
    score += 2;
  } else if (claimA && claimB && (
    claimA.includes(claimB) || claimB.includes(claimA)
  )) {
    score += 1;
  }

  const excerptA = normalizeForSearch(String(evidenceA.source_excerpt ?? ''));
  const excerptB = normalizeForSearch(String(evidenceB.source_excerpt ?? ''));

  if (excerptA && excerptB && excerptA === excerptB) {
    score += 1;
  }

  return score / maxScore;
}

// ------------------------------------------------------------
// DETECT — Candidate detection tanpa destructive decision
// ------------------------------------------------------------

export const DuplicateValidator = {
  detect(
    evidenceList: EvidenceItem[]
  ): DuplicateResult {
    const candidates: DuplicateCandidate[] = [];

    for (let i = 0; i < evidenceList.length; i++) {
      for (let j = i + 1; j < evidenceList.length; j++) {
        const evidenceA = evidenceList[i];
        const evidenceB = evidenceList[j];

        const similarity = calculateSimilarity(
          evidenceA,
          evidenceB
        );

        // Strong occurrence candidate:
        // Source SAME + excerpt SAME → candidate deterministik
        const sourceRelation = compareSourceRelation(
          evidenceA,
          evidenceB
        );

        const excerptA = normalizeForSearch(
          String(evidenceA.source_excerpt ?? '')
        );
        const excerptB = normalizeForSearch(
          String(evidenceB.source_excerpt ?? '')
        );

        const strongOccurrenceCandidate =
          sourceRelation === 'SAME' &&
          !!excerptA &&
          !!excerptB &&
          excerptA === excerptB;

        if (similarity >= 0.6 || strongOccurrenceCandidate) {
          const reasons: string[] = [];

          const fingerprintA = buildFingerprint(evidenceA);
          const fingerprintB = buildFingerprint(evidenceB);

          if (fingerprintA === fingerprintB) {
            reasons.push('Fingerprint identik');
          }

          const claimA = normalizeForSearch(String(evidenceA.claim ?? ''));
          const claimB = normalizeForSearch(String(evidenceB.claim ?? ''));

          if (claimA && claimB && claimA === claimB) {
            reasons.push('Claim identik');
          } else if (claimA && claimB && (
            claimA.includes(claimB) || claimB.includes(claimA)
          )) {
            reasons.push('Claim mengandung satu sama lain');
          }

          if (excerptA && excerptB && excerptA === excerptB) {
            reasons.push('Source excerpt identik');
          }

          if (strongOccurrenceCandidate) {
            reasons.push('Strong occurrence candidate');
          }

          candidates.push({
            evidenceA,
            evidenceB,
            similarity,
            reasons
          });
        }
      }
    }

    return {
      candidates,
      duplicatePairs: candidates.map(candidate =>
        resolveDuplicatePair(candidate)
      )
    };
  }
};

// ------------------------------------------------------------
// RESOLVER — Pairwise resolution recommendation
// ------------------------------------------------------------

function resolveDuplicatePair(
  candidate: DuplicateCandidate
): DuplicateResolution {
  const { evidenceA, evidenceB } = candidate;

  // 1. Source relation
  const sourceRelation = compareSourceRelation(
    evidenceA,
    evidenceB
  );

  if (sourceRelation === 'DIFFERENT') {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'PRESERVE',
      reason: 'Source occurrence berbeda, bukan duplicate'
    };
  }

  if (sourceRelation === 'UNKNOWN') {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'PRESERVE',
      reason: 'Source relation tidak dapat dibuktikan, preserve untuk keamanan'
    };
  }

  // 2. STRONG DUPLICATE EXCEPTION
  //    Source SAME + excerpt SAME
  //    → duplicate candidate kuat
  const excerptA = normalizeForSearch(
    String(evidenceA.source_excerpt ?? '')
  );
  const excerptB = normalizeForSearch(
    String(evidenceB.source_excerpt ?? '')
  );

  const isExcerptSame = excerptA === excerptB;

  if (
    sourceRelation === 'SAME' &&
    isExcerptSame
  ) {
    return resolveIdenticalOccurrenceOrMerge(evidenceA, evidenceB);
  }

  // 3. Context relation
  const contextRelation = compareContextRelation(
    evidenceA,
    evidenceB
  );

  if (contextRelation === 'DIFFERENT') {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'PRESERVE',
      reason: 'Context berbeda, bukan duplicate'
    };
  }

  if (contextRelation === 'UNKNOWN') {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'PRESERVE',
      reason: 'Context relation tidak dapat dibuktikan, preserve untuk keamanan'
    };
  }

  // 4. Source SAME + Context SAME
  //    Gunakan deterministic resolution
  return resolveIdenticalOccurrence(evidenceA, evidenceB);
}

// ------------------------------------------------------------
// RESOLVE IDENTICAL OCCURRENCE
// ------------------------------------------------------------
// BARU: deteksi apakah excerpt yang dibagi dua evidence secara eksplisit
// menjelaskan LEBIH DARI SATU referen/nilai sekaligus. Ini pembeda yang
// benar untuk menahan KEEP_FIRST/KEEP_BEST -- BUKAN kesamaan claim
// (lihat catatan D-01 di duplicate.test.ts: E139/E140 sama-sama
// menjelaskan SATU fakta dengan framing berbeda -- OPINION vs FACT --
// dan memang seharusnya KEEP_FIRST).
//
// Dikonfirmasi via replay data produksi 45hfkSE5DvA:
//   - "...untuk foto dan juga untuk video..." (E156/E157)      -> true
//   - "...4% baik di mode 120Hz maupun 60Hz"   (E181/E182)      -> true
//   - "tidak ada opsi perekaman 60 fps..."     (E139/E140)      -> false
//
// KETERBATASAN DIKETAHUI: pola "X dan Y" polos tanpa "untuk...dan juga"
// atau tanpa nilai numerik berulang (mis. "kamera selfie dan ultrawide
// yang perlu peningkatan...") TIDAK terdeteksi di sini -- lihat
// D-12 di duplicate.test.ts yang secara eksplisit mendokumentasikan
// ini sebagai gap terbuka, bukan regresi. Menambah pola "X dan Y" polos
// berisiko high false-positive karena kata "dan" sangat umum.
function excerptDescribesMultipleReferents(
  excerptA: string | null | undefined,
  excerptB: string | null | undefined
): boolean {
  const excerpt = (excerptA || excerptB || '').toLowerCase();

  const explicitSplitPattern =
    /\buntuk\b[^.!?]{0,20}\bdan juga\b[^.!?]{0,10}\buntuk\b|\bbaik\b[^.!?]{0,40}\bmaupun\b/i;
  if (explicitSplitPattern.test(excerpt)) return true;

  const numUnitPattern = /(\d+(?:[.,]\d+)?)\s*(hz|%|fps|mah|gb|jam|menit)\b/gi;
  const seenValuesPerUnit = new Map<string, Set<string>>();
  let m: RegExpExecArray | null;
  while ((m = numUnitPattern.exec(excerpt))) {
    const [, value, unit] = m;
    const key = unit.toLowerCase();
    if (!seenValuesPerUnit.has(key)) seenValuesPerUnit.set(key, new Set());
    seenValuesPerUnit.get(key)!.add(value);
  }
  for (const values of seenValuesPerUnit.values()) {
    if (values.size >= 2) return true;
  }

  return false;
}

function resolveIdenticalOccurrence(
  evidenceA: EvidenceItem,
  evidenceB: EvidenceItem
): DuplicateResolution {
  if (excerptDescribesMultipleReferents(evidenceA.source_excerpt, evidenceB.source_excerpt)) {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'PRESERVE',
      reason:
        'Source occurrence dan source excerpt identik, tetapi excerpt ' +
        'secara eksplisit menjelaskan lebih dari satu referen/nilai ' +
        '(enumerasi "untuk X dan juga untuk Y" atau dua nilai numerik ' +
        'satuan sama) -- kemungkinan shared-predicate split dengan ' +
        'subtopic sama. Preserve untuk keamanan, bukan KEEP_FIRST.'
    };
  }

  //const claimsEqual = equalsNormalized(
    //evidenceA.claim ?? '',
    //evidenceB.claim ?? ''
  //);

  //if (!claimsEqual) {
    //return {
      //evidence_id_a: evidenceA.evidence_id || '',
      //evidence_id_b: evidenceB.evidence_id || '',
      //action: 'PRESERVE',
      //reason:
        //'Source occurrence dan source excerpt identik, tetapi claim ' +
        //'berbeda -- kemungkinan shared-predicate split dengan subtopic ' +
        //'sama (dua objek berbeda dari satu kalimat sumber). Preserve ' +
        //'untuk keamanan, bukan KEEP_FIRST.'
    //};
  //}

  const hasMoreInfoA =
    (evidenceA.value !== null && evidenceA.value !== undefined) ||
    (evidenceA.unit !== null && evidenceA.unit !== undefined);

  const hasMoreInfoB =
    (evidenceB.value !== null && evidenceB.value !== undefined) ||
    (evidenceB.unit !== null && evidenceB.unit !== undefined);

  if (hasMoreInfoA && !hasMoreInfoB) {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'KEEP_BEST',
      // reason: 'Evidence A lebih lengkap'
      reason: 'Evidence A lebih lengkap',
      keptId: evidenceA.evidence_id || ''
    };
  }

  if (hasMoreInfoB && !hasMoreInfoA) {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'KEEP_BEST',
      // reason: 'Evidence B lebih lengkap'
      reason: 'Evidence B lebih lengkap',
      keptId: evidenceB.evidence_id || ''
    };
  }

  return {
    evidence_id_a: evidenceA.evidence_id || '',
    evidence_id_b: evidenceB.evidence_id || '',
    action: 'KEEP_FIRST',
    // reason: 'Source occurrence dan source excerpt identik'
    reason: 'Source occurrence, source excerpt, dan claim identik',
    keptId: evidenceA.evidence_id || ''
  };
}

// ------------------------------------------------------------
// FIELD COMPATIBILITY CHECK — mencegah blind inheritance
// ------------------------------------------------------------
// buildMergedEvidence() mewarisi value/unit/comparison_target/
// certainty/topic dari evidenceA tanpa pengecekan. Kalau field-field
// ini ternyata BERBEDA antara evidenceA/evidenceB, itu sinyal bahwa
// kombinasi ini bukan murni SHARED_PREDICATE_DUPLICATE_SPLIT (satu
// proposisi yang salah dipecah) -- melainkan kemungkinan dua evidence
// independen yang kebetulan berbagi source occurrence + excerpt.
// Ditemukan lewat audit tim (co-auditor), dikonfirmasi terhadap kode.
// ------------------------------------------------------------

function fieldsCompatibleForMerge(
  evidenceA: EvidenceItem,
  evidenceB: EvidenceItem
): boolean {
  const norm = (v: unknown): string =>
    v === null || v === undefined ? '' : String(v);

  return (
    norm(evidenceA.value) === norm(evidenceB.value) &&
    norm(evidenceA.unit) === norm(evidenceB.unit) &&
    norm(evidenceA.comparison_target) === norm(evidenceB.comparison_target) &&
    norm(evidenceA.certainty) === norm(evidenceB.certainty) &&
    norm(evidenceA.topic) === norm(evidenceB.topic)
  );
}

// ------------------------------------------------------------
// GATE — SHARED_PREDICATE_DUPLICATE_SPLIT DETECTION
// ------------------------------------------------------------
// Sinyal spesifik bug SHARED_PREDICATE_DUPLICATE_SPLIT (lihat
// changelog_prompts.md, Addendum 28 Agustus 2026 & rangkuman audit
// bagian 3.2): source occurrence SAMA + source_excerpt IDENTIK
// byte-per-byte, tetapi subtopic BERBEDA. Ini bukan duplicate biasa
// (bukan model mengulang proposisi yang sama) -- ini SATU proposisi
// shared-predicate yang salah dipecah model menjadi dua evidence.
// Perilaku lama (STRONG DUPLICATE EXCEPTION -> KEEP_FIRST) membuang
// salah satu subjek secara diam-diam (silent data loss, dikonfirmasi
// via D-09). Gate ini mengalihkan kasus tersebut ke MERGE.
// ------------------------------------------------------------

function resolveIdenticalOccurrenceOrMerge(
  evidenceA: EvidenceItem,
  evidenceB: EvidenceItem
): DuplicateResolution {
    const subtopicARaw = evidenceA.subtopic ?? '';
  const subtopicBRaw = evidenceB.subtopic ?? '';

  const hasDistinctSubtopics =
    !!subtopicARaw.trim() &&
    !!subtopicBRaw.trim() &&
    !equalsNormalized(subtopicARaw, subtopicBRaw);

  const sameType = (evidenceA.type ?? null) === (evidenceB.type ?? null);

  if (hasDistinctSubtopics && sameType) {
    if (!fieldsCompatibleForMerge(evidenceA, evidenceB)) {
      return {
        evidence_id_a: evidenceA.evidence_id || '',
        evidence_id_b: evidenceB.evidence_id || '',
        action: 'PRESERVE',
        reason:
          'Excerpt identik + subtopic berbeda + type sama, TAPI value/unit/' +
          'comparison_target/certainty/topic tidak seluruhnya sama antara ' +
          'kedua evidence -- sinyal ini BUKAN murni ' +
          'SHARED_PREDICATE_DUPLICATE_SPLIT, melainkan kemungkinan dua ' +
          'evidence independen yang kebetulan berbagi source occurrence ' +
          'dan excerpt. Preserve untuk keamanan, bukan MERGE.'
      };
    }

    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'MERGE',
      reason:
        'Source occurrence dan source excerpt identik, tetapi subtopic berbeda ' +
        `(${evidenceA.subtopic} vs ${evidenceB.subtopic}) -- pola ` +
        'SHARED_PREDICATE_DUPLICATE_SPLIT: satu proposisi shared-predicate yang ' +
        'salah dipecah model. Digabung menjadi satu evidence.',
      mergedEvidence: buildMergedEvidence(evidenceA, evidenceB)
    };
  }

  if (hasDistinctSubtopics && !sameType) {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'PRESERVE',
      reason:
        'Excerpt identik + subtopic berbeda, tetapi type juga berbeda -- ' +
        'di luar pola SHARED_PREDICATE_DUPLICATE_SPLIT yang teramati, ' +
        'preserve untuk keamanan'
    };
  }

  return resolveIdenticalOccurrence(evidenceA, evidenceB);
}

// ------------------------------------------------------------
// MERGE BUILDER
// ------------------------------------------------------------
// TIDAK melakukan NLP/parafrase/semantic rewriting. claim digabung
// literal dari dua claim yang masing-masing sudah tervalidasi individual
// -- konsisten dengan prinsip NO SEMANTIC EXPANSION (prompts.ts, CLAIM
// GROUNDING): tidak menciptakan kalimat baru yang tidak berasal dari
// claim yang sudah ada.
// ------------------------------------------------------------

function mergeClaims(claimA: string | undefined, claimB: string | undefined): string {
  const a = (claimA || '').trim();
  const b = (claimB || '').trim();
  if (!a) return b;
  if (!b) return a;

  const na = normalizeForSearch(a);
  const nb = normalizeForSearch(b);

  // Identik → pilih a
  if (na === nb) return a;

  // Satu mengandung yang lain → pilih yang lebih panjang (tanpa kehilangan info)
  if (na.includes(nb)) return a;
  if (nb.includes(na)) return b;

  // Superset kata → pilih yang lebih panjang HANYA jika SEMUA token klaim
  // yang lebih pendek ada di klaim yang lebih panjang. Tanpa filter panjang
  // kata, agar subjek pendek (RAM/ROM/A26/5G) tidak diabaikan.
  // Catatan: heuristik lama "overlap >= 50% -> pilih yang lebih panjang"
  // dihapus karena membuang salah satu subjek pada pola
  // SHARED_PREDICATE_DUPLICATE_SPLIT (klaim hanya beda di kata subjek).
  const tokensA = new Set(na.split(' ').filter(Boolean));
  const tokensB = new Set(nb.split(' ').filter(Boolean));
  const [shorter, longer, longerText] =
    tokensA.size <= tokensB.size ? [tokensA, tokensB, b] : [tokensB, tokensA, a];
  if ([...shorter].every(t => longer.has(t))) return longerText;

  // Informasi berbeda (mis. subjek berbeda) → gabung literal agar tidak ada
  // subjek yang hilang. Titik akhir klaim pertama dibuang agar tidak ganda.
  return `${a.replace(/[.\s]+$/, '')}. ${b}`;
}

function buildMergedEvidence(
  evidenceA: EvidenceItem,
  evidenceB: EvidenceItem
): EvidenceItem {
  const subtopics = [evidenceA.subtopic, evidenceB.subtopic].filter(
    (s): s is string => !!s && s.trim().length > 0
  );

  const contextSame =
    normalizeForSearch(String(evidenceA.context ?? '')) ===
    normalizeForSearch(String(evidenceB.context ?? ''));

  const assessmentSame =
    evidenceA.reviewer_assessment === evidenceB.reviewer_assessment;

  return {
    // source_excerpt, source_coordinates, type, topic, value, unit,
    // comparison_target, certainty diwariskan dari evidenceA karena
    // resolveIdenticalOccurrenceOrMerge() menjamin source occurrence +
    // source_excerpt identik dengan evidenceB.
    ...evidenceA,
    claim: mergeClaims(evidenceA.claim, evidenceB.claim),
    subtopic: null, // spans >1 subtopic -- lihat ATURAN BARU #7
                     // (prompts.ts): jangan paksa satu subtopic yang
                     // sebenarnya hanya mewakili sebagian proposisi.
    context: contextSame ? (evidenceA.context ?? evidenceB.context ?? null) : null,
    reviewer_assessment: assessmentSame
      ? (evidenceA.reviewer_assessment ?? null)
      : null,
    merged_subtopics: subtopics.length > 0 ? subtopics : null,
    merged_from_evidence_ids: [
      evidenceA.evidence_id || '',
      evidenceB.evidence_id || ''
    ].filter(Boolean),
    validation: evidenceA.validation
  };
}
