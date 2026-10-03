// ============================================================
// ANCHOR-BASED PROVENANCE RESOLVER — INTERNAL
// ============================================================
// BUKAN validator keempat. Dipanggil DARI DALAM
// ProvenanceValidator.resolve(). Tidak diekspor ke
// evidence-validator.ts, tidak didaftarkan di validators/index.ts
// sebagai peer Grounding/Provenance.
//
// INVARIANT ARSITEKTUR (direvisi — lihat CHANGELOG SPAN EXPANSION
// di bawah untuk alasan perubahan dari audit ronde 3 sebelumnya):
//
//   1. Candidate set WAJIB berasal dari findSourceMatches().
//      DILARANG membuat matcher/window baru untuk MENENTUKAN
//      candidate span itu sendiri (segmentStartIndex..segmentEndIndex
//      tempat excerpt LITERAL ditemukan tidak pernah berubah).
//
//   2. Anchor comparison memakai normalizer yang sama dengan
//      search.ts (normalizeForSearch). DILARANG membuat normalizer
//      lokal atau alias semantic.
//
//   3. [DIREVISI] Anchor DICOBA LEBIH DULU terhadap teks candidate
//      span itu sendiri (perilaku asli, tidak berubah). HANYA jika
//      TIDAK ADA satu pun kandidat yang didukung pada fase sempit
//      ini (supportedNarrow.length === 0), resolver mencoba fase
//      kedua: mencocokkan anchor terhadap jendela yang diperluas
//      sejauh ANCHOR_EXPANSION_RADIUS segmen ke depan/belakang dari
//      TIAP kandidat secara independen. Koordinat yang dikembalikan
//      SELALU span asli yang sempit (segmentStartIndex..segmentEndIndex
//      dari findSourceMatches) — perluasan HANYA alat bantu
//      disambiguasi anchor, TIDAK PERNAH mengubah lokasi excerpt yang
//      dilaporkan. Kalau fase sempit sudah menghasilkan >1 kandidat
//      (ambigu), fase lebar TIDAK dicoba — melebarkan jendela pada
//      kondisi yang sudah ambigu hanya bisa menambah kecocokan, tidak
//      pernah mengurangi jadi 1.
//
//   4. RESOLVED hanya jika cardinality(candidateSupport) === 1, pada
//      fase manapun ia RESOLVED (sempit atau lebar).
//      Tidak ada fallback "ambil yang pertama/terdekat".
//
// ============================================================
// CHANGELOG — SPAN EXPANSION (audit lanjutan, 13 run produksi)
// ============================================================
// Invariant #3 versi asli (dikunci audit ronde 3) MELARANG TOTAL
// perluasan window, dengan alasan "cross-segment coreference bukan
// tanggung jawab resolver ini". Setelah 13 run produksi berturut-
// turut (45hfkSE5DvA), pola berikut TERBUKTI TIDAK PERNAH bisa
// ter-resolve di bawah invariant lama:
//
//   Segmen 96: "Ini adalah kamera selfie 13 MP, bukaan f/2.2, fixed focus."
//   Segmen 97: "Perekaman videonya up to 1080p 30 fps."
//   Segmen 101: "Kemudian untuk kamera berikutnya ada kamera ultrawide 8 MP, bukaan f/2.2."
//   Segmen 102: "Ini fixed focus juga ya, perekaman videonya up to 1080p 30 fps."
//
// Excerpt "up to 1080p 30 fps" cocok di SEGMEN 97 DAN 102 (dua
// candidate span terpisah, masing-masing 1 segmen). Subtopic anchor
// ("selfie" / "ultrawide") TIDAK PERNAH muncul di span 97 atau span
// 102 itu sendiri — kata pembeda hanya ada di segmen SEBELUMNYA (96
// dan 101). Di bawah invariant lama, KEDUA evidence ini SELALU
// AMBIGUOUS, permanen, tidak peduli seberapa sering diekstraksi ulang.
//
// KEPUTUSAN: melonggarkan invariant #3 dengan cara YANG PALING
// SEMPIT dan TERUKUR yang menutup kasus ini, tanpa membuka celah baru:
//   - Radius kecil dan tetap (1 segmen), bukan tanpa batas. Radius=2
//     sempat dicoba dan JUGA menutup kasus di atas, tapi terbukti
//     membuka false-positive pada fixture yang sama (anchor "macro"
//     salah ter-resolve ke ultrawide lewat segmen 103 yang tidak
//     terkait) -- lihat komentar ANCHOR_EXPANSION_RADIUS di bawah.
//     Radius=1 sudah cukup untuk seluruh kasus produksi nyata tanpa
//     risiko itu.
//   - Hanya FALLBACK setelah fase sempit gagal total (0 kandidat),
//     bukan pengganti fase sempit.
//   - Koordinat hasil TETAP span sempit asli — tidak pernah
//     melaporkan lokasi yang lebih luas dari yang sebenarnya
//     didukung excerpt literal.
//   - cardinality-check (RESOLVED hanya jika tepat 1) tetap berlaku
//     penuh di fase lebar.
//
// Test #4/#5/#6 di anchor-resolver.contract.test.ts (sebelumnya
// tripwire "tidak boleh melebar") SEKARANG diperbarui menjadi
// tripwire SEBALIKNYA: memastikan pelebaran ini BENAR-BENAR
// menyelesaikan pola di atas, dengan radius yang dibatasi dan
// koordinat yang tetap sempit. Lihat catatan di file test.
// ============================================================

import type {
  EvidenceContext,
  SourceCoordinates,
  SegmentMatch
} from '../types';
import { findSourceMatches } from '../search';
import { normalizeForSearch } from '../srt';

export type ProvenanceResolutionStatus = 'RESOLVED' | 'AMBIGUOUS';

export interface ProvenanceResolution {
  status: ProvenanceResolutionStatus;
  coordinates: SourceCoordinates | null;
}

// Radius perluasan, dalam satuan segmen SRT, ke depan DAN ke
// belakang dari candidate span. Nilai ini SENGAJA kecil dan
// eksplisit (bukan konstanta tersembunyi di dalam fungsi) supaya
// mudah diaudit dan disesuaikan tanpa membongkar logika resolver.
//
// RADIUS=1 (bukan 2): radius=2 SUDAH DICOBA lebih dulu dan terbukti
// cukup untuk menutup pola produksi (jarak 1 segmen antara kalimat
// deklarasi kamera dan kalimat kapabilitas rekam), TAPI radius=2
// juga terbukti membuka false-positive nyata pada fixture yang SAMA:
// anchor "macro" (ejaan Inggris) dengan excerpt "bukaan f/2.2" salah
// ter-RESOLVED ke segmen 101 (ultrawide), padahal "bukaan f/2.2"
// tidak pernah disebut terkait kamera macro sama sekali -- "macro"
// hanya kebetulan muncul di segmen 103 (kamera macro, topik lain),
// yang masih terjangkau radius=2 dari kandidat 101. Radius=1 menutup
// SEMUA kasus produksi nyata yang sama (#4/#5/#6 di
// anchor-resolver.contract.test.ts) TANPA membuka celah ini, karena
// segmen 103 sudah di luar jangkauan radius=1 dari kandidat 101.
// Kalau di masa depan ditemukan pola nyata yang butuh radius lebih
// besar, naikkan nilai ini SATU per SATU sambil menjalankan ulang
// seluruh contract test -- jangan langsung lompat ke nilai besar.
export const ANCHOR_EXPANSION_RADIUS = 1;

// ------------------------------------------------------------
// HELPER — teks candidate span PERSIS (tanpa perluasan). Dipakai
// untuk fase 1 (sempit) DAN untuk menentukan koordinat akhir yang
// dilaporkan, di kedua fase.
// ------------------------------------------------------------

function getCandidateSpanText(
  candidate: SegmentMatch,
  context: EvidenceContext
): string {
  return context.chunkSegments
    .filter(
      seg =>
        seg.index >= candidate.segmentStartIndex &&
        seg.index <= candidate.segmentEndIndex
    )
    .map(seg => seg.text)
    .join(' ');
}

// ------------------------------------------------------------
// HELPER — teks candidate span DIPERLUAS sejauh `radius` segmen
// ke depan/belakang. HANYA dipakai untuk mencocokkan anchor di
// fase 2 (lebar). TIDAK PERNAH dipakai untuk candidateToCoordinates
// — koordinat yang dilaporkan selalu dari getCandidateSpanText
// (span sempit asli).
// ------------------------------------------------------------

function getExpandedSpanText(
  candidate: SegmentMatch,
  context: EvidenceContext,
  radius: number
): string {
  const lowerBound = candidate.segmentStartIndex - radius;
  const upperBound = candidate.segmentEndIndex + radius;
  return context.chunkSegments
    .filter(seg => seg.index >= lowerBound && seg.index <= upperBound)
    .map(seg => seg.text)
    .join(' ');
}

function candidateToCoordinates(
  candidate: SegmentMatch,
  context: EvidenceContext
): SourceCoordinates {
  return {
    chunk_index: context.chunkIndex,
    segment_start_index: candidate.segmentStartIndex,
    segment_end_index: candidate.segmentEndIndex,
    char_start: null,
    char_end: null
  };
}

// ------------------------------------------------------------
// HELPER — cek anchor vs satu span text, dengan batas kata (bukan
// substring bebas). Dipakai di kedua fase.
// ------------------------------------------------------------

function anchorSupportsSpan(normalizedAnchor: string, spanText: string): boolean {
  const normalizedSpan = normalizeForSearch(spanText);
  return (` ${normalizedSpan} `).includes(` ${normalizedAnchor} `);
}

// ------------------------------------------------------------
// resolveProvenanceAnchor()
// ------------------------------------------------------------

export function resolveProvenanceAnchor(
  sourceExcerpt: string | null | undefined,
  anchor: string | null | undefined,
  context: EvidenceContext
): ProvenanceResolution {
  const candidates = findSourceMatches(sourceExcerpt, context);

  // 0 match: bukan tanggung jawab resolver ini (Grounding sudah
  // FAIL sebelum resolver dipanggil). Defensif: AMBIGUOUS+null.
  if (candidates.length === 0) {
    return { status: 'AMBIGUOUS', coordinates: null };
  }

  // 1 match → RESOLVED (anchor tidak diperlukan).
  if (candidates.length === 1) {
    return {
      status: 'RESOLVED',
      coordinates: candidateToCoordinates(candidates[0], context)
    };
  }

  // >1 match: anchor wajib ada dan diskriminatif.
  const normalizedAnchor = normalizeForSearch(anchor || '');

  if (!normalizedAnchor) {
    return { status: 'AMBIGUOUS', coordinates: null };
  }

  // ---- FASE 1: sempit (perilaku asli, invariant #3 lama) ----
  const supportedNarrow = candidates.filter(candidate =>
    anchorSupportsSpan(normalizedAnchor, getCandidateSpanText(candidate, context))
  );

  if (supportedNarrow.length === 1) {
    return {
      status: 'RESOLVED',
      coordinates: candidateToCoordinates(supportedNarrow[0], context)
    };
  }

  if (supportedNarrow.length > 1) {
    // Sudah ambigu di level sempit. Melebarkan jendela hanya akan
    // menambah kecocokan (superset), tidak pernah mengurangi jadi 1.
    // Tidak ada gunanya mencoba fase 2 di sini.
    return { status: 'AMBIGUOUS', coordinates: null };
  }

  // ---- FASE 2: lebar (BARU) — hanya dicoba kalau fase 1 = 0 ----
  const supportedWide = candidates.filter(candidate =>
    anchorSupportsSpan(
      normalizedAnchor,
      getExpandedSpanText(candidate, context, ANCHOR_EXPANSION_RADIUS)
    )
  );

  if (supportedWide.length !== 1) {
    return { status: 'AMBIGUOUS', coordinates: null };
  }

  // PENTING: koordinat tetap dari span SEMPIT asli (candidates),
  // BUKAN dari jendela yang diperluas. Perluasan hanya membantu
  // menemukan candidate MANA yang didukung anchor -- tidak mengubah
  // di MANA excerpt literal itu sendiri berada.
  return {
    status: 'RESOLVED',
    coordinates: candidateToCoordinates(supportedWide[0], context)
  };
}