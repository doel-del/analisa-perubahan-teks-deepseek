// ============================================================
// PRODUCTION PIPELINE — SHARED CORE
// ============================================================
// SINGLE SOURCE OF TRUTH untuk:
//   - SRT parsing
//   - Evidence chunking (buildEvidenceChunks, buildChunkText)
//   - Evidence JSON parsing (production strategy, 4-tier fallback)
//   - Identity / metadata context construction
//   - Evidence extraction prompt instruction builder
//
// ATURAN:
// server.ts (production) DAN reproducibility-harness.ts (E.3D)
// WAJIB mengimpor fungsi-fungsi ini dari file ini.
// JANGAN duplikasi implementasi di tempat lain.
//
// Jika production berubah (mis. algoritma chunking, aturan
// fallback JSON parser, atau cara membangun identity context),
// perubahan hanya dilakukan DI SINI — dan otomatis berlaku
// untuk production maupun reproducibility harness.
// ============================================================

import { ANALYSIS_PROMPT_EVIDENCE } from '../../prompts';
import type { SRTSegment } from './srt';
import type { EvidenceItem } from './types';

export interface ReviewMetadata {
  id?: string;
  url?: string;
  title?: string;
  channel?: string;
  thumbnail?: string;
  duration?: string;
  views?: number;
  uploadDate?: string;
  commentCount?: number;
  [key: string]: any;
}

// ============================================================
// SRT PARSER
// ============================================================

export function parseSRT(srtContent: string): SRTSegment[] {
  const segments: SRTSegment[] = [];

  const normalized = srtContent
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  const blocks = normalized.split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.split('\n');

    if (lines.length < 3) continue;

    const timeMatch = lines[1].match(
      /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/
    );

    if (!timeMatch) continue;

    const parsedIndex = Number.parseInt(lines[0].trim(), 10);
    const index = Number.isFinite(parsedIndex)
      ? parsedIndex
      : segments.length + 1;

    const text = lines
      .slice(2)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) continue;

    segments.push({
      index,
      start: timeMatch[1],
      end: timeMatch[2],
      text
    });
  }

  return segments;
}

// ============================================================
// CHUNKING
// ============================================================

export function buildEvidenceChunks(
  segments: SRTSegment[],
  targetCharacters = 18000,
  overlapSegments = 3
): SRTSegment[][] {
  const chunks: SRTSegment[][] = [];

  if (segments.length === 0) {
    return chunks;
  }

  let startIndex = 0;

  while (startIndex < segments.length) {
    const chunk: SRTSegment[] = [];
    let currentCharacters = 0;
    let cursor = startIndex;

    while (cursor < segments.length) {
      const segment = segments[cursor];
      const segmentSize = segment.text.length + 40;

      if (
        chunk.length > 0 &&
        currentCharacters + segmentSize > targetCharacters
      ) {
        break;
      }

      chunk.push(segment);
      currentCharacters += segmentSize;
      cursor++;

      if (chunk.length === 1 && segmentSize > targetCharacters) {
        break;
      }
    }

    if (chunk.length === 0) {
      break;
    }

    chunks.push(chunk);

    if (cursor >= segments.length) {
      break;
    }

    startIndex = Math.max(cursor - overlapSegments, startIndex + 1);
  }

  return chunks;
}

// production-pipeline.ts
export function buildChunkText(chunk: SRTSegment[]): string {
  return chunk.map(segment => segment.text).join(' ');
}

// ============================================================
// EVIDENCE JSON PARSER — production strategy (4-tier fallback)
// ============================================================
// Satu core implementation. `parseEvidenceJSON` (dipakai production,
// signature tidak berubah) dan `parseEvidenceJSONDetailed` (dipakai
// harness untuk keperluan diagnostic/reproducibility artifact)
// SAMA-SAMA memanggil core yang sama, sehingga tidak mungkin
// tertinggal sinkron satu sama lain.

type ParseStrategy =
  | 'direct_array'
  | 'direct_object'
  | 'fenced'
  | 'evidence_key_scan'
  | 'array_bracket_scan'
  | null;

function parseEvidenceJSONCore(rawOutput: string): {
  evidence: any[];
  strategy: ParseStrategy;
} {
  const raw = rawOutput.replace(/^\uFEFF/, '').trim();

  try {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return { evidence: parsed, strategy: 'direct_array' };
    }

    if (parsed && Array.isArray(parsed.evidence)) {
      return { evidence: parsed.evidence, strategy: 'direct_object' };
    }
  } catch (_) {}

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);

  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1].trim());

      if (Array.isArray(parsed)) {
        return { evidence: parsed, strategy: 'fenced' };
      }

      if (parsed && Array.isArray(parsed.evidence)) {
        return { evidence: parsed.evidence, strategy: 'fenced' };
      }
    } catch (_) {}
  }

  const evidenceIndex = raw.indexOf('"evidence"');

  if (evidenceIndex !== -1) {
    const objectStart = raw.lastIndexOf('{', evidenceIndex);

    if (objectStart !== -1) {
      try {
        const parsed = JSON.parse(raw.substring(objectStart));

        if (parsed && Array.isArray(parsed.evidence)) {
          return { evidence: parsed.evidence, strategy: 'evidence_key_scan' };
        }
      } catch (_) {}
    }
  }

  const arrayStart = raw.indexOf('[');
  const arrayEnd = raw.lastIndexOf(']');

  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    try {
      const parsed = JSON.parse(raw.substring(arrayStart, arrayEnd + 1));

      if (Array.isArray(parsed)) {
        return { evidence: parsed, strategy: 'array_bracket_scan' };
      }
    } catch (_) {}
  }

  return { evidence: [], strategy: null };
}

/**
 * Production signature — dipakai oleh server.ts.
 * Perilaku TIDAK BERUBAH dari implementasi production sebelumnya:
 * mengembalikan array evidence (bisa kosong bila semua strategi gagal).
 */
export function parseEvidenceJSON(rawOutput: string): EvidenceItem[] {
  return parseEvidenceJSONCore(rawOutput).evidence;
}

/**
 * Diagnostic signature — dipakai oleh reproducibility harness.
 * Menjalankan CORE YANG SAMA PERSIS dengan parseEvidenceJSON production,
 * tetapi juga melaporkan status SUCCESS/FAILED dan strategi mana yang
 * berhasil, untuk kebutuhan reproducibility artifact.
 *
 * PENTING: production sendiri tidak pernah "gagal" secara eksplisit —
 * ia hanya mengembalikan [] sebagai fallback terakhir. Field `status`
 * di sini murni untuk pelaporan E.3D, bukan perilaku production yang
 * berbeda.
 */
export function parseEvidenceJSONDetailed(rawOutput: string): {
  status: 'SUCCESS' | 'FAILED';
  evidence: any[];
  strategy: ParseStrategy;
  error?: string;
} {
  const { evidence, strategy } = parseEvidenceJSONCore(rawOutput);

  if (strategy === null) {
    return {
      status: 'FAILED',
      evidence: [],
      strategy: null,
      error: 'Gagal parse JSON dari rawOutput (semua strategi fallback gagal)'
    };
  }

  return { status: 'SUCCESS', evidence, strategy };
}

// ============================================================
// IDENTITY / METADATA CONTEXT
// ============================================================

export function buildMetadataContext(metadata: ReviewMetadata): string {
  const fields = [
    ['ID', metadata.id],
    ['URL', metadata.url],
    ['Judul Video', metadata.title],
    ['Channel', metadata.channel],
    ['Thumbnail', metadata.thumbnail],
    ['Durasi', metadata.duration],
    ['Views', metadata.views],
    ['Tanggal Publikasi', metadata.uploadDate],
    ['Jumlah Komentar', metadata.commentCount]
  ];

  return fields
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `${label}: ${value}`)
    //.join('\\n');
    // PERBAIKAN: source sebelumnya `.join('\\n')` -- dua backslash --
    // yang di-parse JS menjadi STRING LITERAL dua karakter "\n" (backslash
    // + huruf n), BUKAN karakter newline. Akibatnya seluruh field metadata
    // (ID, URL, Judul Video, dst) tergabung jadi SATU baris panjang dengan
    // teks "\n" literal di antaranya, bukan baris terpisah, di setiap
    // prompt summary maupun evidence yang mengandung metadata.
    .join('\n');
}

export function getReviewerName(
  metadata: ReviewMetadata,
  fallback = 'Reviewer'
): string {
  if (typeof metadata.channel === 'string' && metadata.channel.trim()) {
    return metadata.channel.trim();
  }

  return fallback;
}

// ============================================================
// EVIDENCE EXTRACTION PROMPT INSTRUCTION BUILDER
// ============================================================
// Satu-satunya tempat yang menyusun instruction lengkap yang
// dikirim ke model untuk tahap evidence extraction. server.ts
// dan harness WAJIB memanggil fungsi ini, bukan menyusun ulang
// string instruksi secara manual.

export function buildEvidenceInstruction(
  metadata: ReviewMetadata,
  reviewerNameFallback: string,
  batchNumber: number,
  totalBatches: number,
  promptOverride?: string
): string {
  const resolvedReviewerName = getReviewerName(metadata, reviewerNameFallback);
  const metadataContext = buildMetadataContext(metadata);
  const promptToUse = promptOverride ?? ANALYSIS_PROMPT_EVIDENCE;

  return (
    `IDENTITAS REVIEW:\n${metadataContext || `Channel/Reviewer: ${resolvedReviewerName}`}\n\n` +
    `SOURCE OF TRUTH: transcript.srt.\n` +
    `Metadata tidak boleh digunakan untuk membuat evidence isi produk.\n\n` +
    promptToUse
      .replace(/\{batch\}/g, batchNumber.toString())
      .replace(/\{total_batches\}/g, totalBatches.toString()) +
    `\n\n` +
    `==================================================\n` +
    `INSTRUKSI CHUNK\n` +
    `==================================================\n` +
    `Anda sedang memproses bagian ${batchNumber} dari ${totalBatches} bagian transcript.\n` +
    `Chunk ini terdiri dari segment SRT utuh.\n` +
    `Ekstrak SELURUH evidence relevan yang benar-benar terdapat pada chunk ini.\n` +
    `Jangan membatasi jumlah evidence secara artifisial.\n` +
    `Jangan mengarang evidence dari chunk atau review lain.\n` +
    `Pertahankan angka, unit, konteks, perbandingan, opini, caveat, dan trade-off.\n` +
    `source_excerpt WAJIB berasal dari teks transcript yang diberikan.\n` +
    `Output harus berupa JSON valid dengan struktur {"evidence":[...]}.\n`
  );
}

export const PRODUCTION_SYSTEM_INSTRUCTION_EVIDENCE =
  'Anda adalah ekstraktor evidence produk. Hanya output JSON yang valid. Jangan memberikan komentar di luar JSON.';
