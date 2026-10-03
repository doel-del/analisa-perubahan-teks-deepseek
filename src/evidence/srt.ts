// ============================================================
// SRT SHARED TYPES & NORMALIZATION
// ============================================================
// Single source of truth untuk SRTSegment.
// Tidak ada duplikasi definisi di types.ts.
// ============================================================

export interface SRTSegment {
  index: number;
  start: string;
  end: string;
  text: string;
}

export function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[“”"'`]/g, '')
    // BARU: subtopic kebab-case ("knox-vault") harus bisa dicocokkan
    // terhadap teks transkrip berspasi ("Knox Vault"). Tanpa baris ini,
    // findSourceMatches dan anchor-resolver TIDAK PERNAH bisa mencocokkan
    // subtopic multi-kata apa pun terhadap span kandidat, sehingga
    // mekanisme anchor gagal total untuk seluruh kelas subtopic yang
    // diwajibkan format kebab-case oleh prompt.
    .replace(/[-–—_]/g, ' ')
    .replace(/[.,!?;:()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}