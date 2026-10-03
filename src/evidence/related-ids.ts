// src/evidence/related-ids.ts
//
// Memetakan related_evidence_ids yang ditulis LLM (nomor LOKAL per chunk,
// mis. "E031") ke evidence_id FINAL (mis. "Bmgp2VZufRY-E030").
//
// Latar belakang bug: LLM menomori item menurut urutan keluarannya sendiri,
// termasuk item yang kemudian dibuang (gagal struktural / karantina).
// assignEvidenceIds menomori ulang hanya item yang lolos, sehingga semua
// nomor setelah item terbuang bergeser.
//
// Alur pemakaian di pipeline:
//   1. Per chunk, panggil buildChunkLocalKeys(chunkEvidence) SEBELUM filter
//      struktural/validasi. Hasilnya satu LocalKey per item parse.
//   2. Saat item lolos validasi, push LocalKey-nya ke array paralel
//      `allEvidenceKeys` (indeks sama dengan allEvidence).
//   3. Setelah assignEvidenceIds: remapRelatedIds(identified, keys).
//   4. Setelah duplicate gate: redirectRelatedIds(preserved, removed, merged).

export interface LocalKey {
  chunkIndex: number;
  /** Nomor lokal ternormalisasi, mis. "E031" (atau null jika tak ada). */
  localId: string | null;
  /** Posisi 1-based di array hasil parse chunk (sebelum filter apa pun). */
  position: number;
  /** Cara nomor lokal ditentukan; ikut di key agar label mode tidak bergantung pada diagnostik terpisah. */
  mode: 'llm-ids' | 'position';
}

/** Diagnostik per chunk: kenapa mode dipilih dan nomor lokal apa saja yang ada. */
export interface ChunkKeyDiagnostics {
  chunkIndex: number;
  mode: 'llm-ids' | 'position';
  /** Alasan mode: 'ok' bila evidence_id LLM lengkap dan unik. */
  reason: 'ok' | 'missing-ids' | 'duplicate-ids' | 'empty-chunk';
  /** Rentang nomor lokal terkecil..terbesar (untuk melihat basis penomoran LLM). */
  idRange: [string, string] | null;
  totalParsed: number;
  missingIds: number;
  duplicateIds: string[];
  /** Semua nomor lokal (dari SEMUA item parse, termasuk yang dibuang). */
  allLocalIds: string[];
}

export interface DroppedRef {
  from: string;          // evidence_id final item sumber
  ref: string;           // nilai mentah dari LLM
  reason: 'target-removed' | 'target-nonexistent' | 'target-unclassified' | 'unparseable';
}

export interface ChunkRemapStats {
  chunkIndex: number;
  mode: 'llm-ids' | 'position';
  reason: ChunkKeyDiagnostics['reason'] | 'unknown';
  itemsAccepted: number;
  emitted: number;
  mapped: number;
  droppedTargetRemoved: number;     // menunjuk item yang di-quarantine/dibuang
  droppedTargetNonexistent: number; // nomor tidak ada di chunk sama sekali
  droppedTargetUnclassified: number; // diagnostik chunk tidak tersedia, jadi tak bisa dibedakan
  droppedUnparseable: number;
  droppedSelf: number;
  droppedDuplicate: number;
  samples: DroppedRef[];            // maks 8 contoh per chunk
}

interface HasRelated {
  evidence_id?: string | null;
  related_evidence_ids?: unknown;
}

export interface RemapStats {
  totalRefs: number;
  mapped: number;
  droppedUnknown: number; // menunjuk item terbuang / tak dikenal
  droppedSelf: number;
  droppedDuplicate: number;
  chunksUsingLlmIds: number;
  chunksUsingPosition: number;
  perChunk: ChunkRemapStats[];
}

const LOCAL_RE = /E(\d{1,6})\b/i;

/** "E31", "e031", "Bmgp2VZufRY-E031" -> "E031". Selain itu null. */
export function normalizeLocalId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(LOCAL_RE);
  if (!m) return null;
  return `E${m[1].padStart(3, '0')}`;
}

function posToLocal(position: number): string {
  return `E${String(position).padStart(3, '0')}`;
}

/**
 * Bangun LocalKey untuk satu chunk dari SEMUA item hasil parse
 * (sebelum isValidEvidence). Memakai evidence_id buatan LLM jika semuanya
 * ada dan unik; jika tidak, jatuh ke posisi 1-based.
 */
export function buildChunkLocalKeys(
  chunkEvidence: Array<{ evidence_id?: unknown }>,
  chunkIndex: number
): { keys: LocalKey[]; mode: 'llm-ids' | 'position'; diagnostics: ChunkKeyDiagnostics } {
  const llmIds = chunkEvidence.map(e => normalizeLocalId(e?.evidence_id));
  const missingIds = llmIds.filter(id => id === null).length;
  const counts = new Map<string, number>();
  for (const id of llmIds) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  const duplicateIds = [...counts.entries()].filter(([, c]) => c > 1).map(([id]) => id);

  let reason: ChunkKeyDiagnostics['reason'] = 'ok';
  if (llmIds.length === 0) reason = 'empty-chunk';
  else if (missingIds > 0) reason = 'missing-ids';
  else if (duplicateIds.length > 0) reason = 'duplicate-ids';
  const mode: 'llm-ids' | 'position' = reason === 'ok' ? 'llm-ids' : 'position';

  const keys: LocalKey[] = chunkEvidence.map((_, i) => ({
    chunkIndex,
    position: i + 1,
    mode,
    localId: mode === 'llm-ids' ? llmIds[i] : posToLocal(i + 1)
  }));
  const allLocalIds = keys.map(k => k.localId).filter((x): x is string => !!x);
  const sorted = [...allLocalIds].sort();
  const idRange: [string, string] | null = sorted.length ? [sorted[0], sorted[sorted.length - 1]] : null;
  return {
    keys,
    mode,
    diagnostics: { chunkIndex, mode, reason, idRange, totalParsed: llmIds.length, missingIds, duplicateIds, allLocalIds }
  };
}

function toRefArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v.trim()) return [v];
  return [];
}

/**
 * Langkah 3: petakan nomor lokal -> evidence_id final.
 * `evidence` dan `keys` harus sejajar (indeks sama).
 * Referensi dipetakan hanya di dalam chunk yang sama.
 */
export function remapRelatedIds<T extends HasRelated>(
  evidence: T[],
  keys: LocalKey[],
  chunkDiagnostics: ChunkKeyDiagnostics[] = []
): { evidence: T[]; stats: RemapStats } {
  if (evidence.length !== keys.length) {
    throw new Error(
      `remapRelatedIds: panjang evidence (${evidence.length}) != keys (${keys.length})`
    );
  }

  const map = new Map<string, string>(); // "chunk:E###" -> final id
  evidence.forEach((ev, i) => {
    const k = keys[i];
    if (k.localId && ev.evidence_id) map.set(`${k.chunkIndex}:${k.localId}`, ev.evidence_id);
  });

  // Toleran terhadap pemanggilan lama (mis. array string): hanya objek berdiagnostik yang dipakai.
  const validDiag = (Array.isArray(chunkDiagnostics) ? chunkDiagnostics : []).filter(
    (d): d is ChunkKeyDiagnostics => !!d && typeof d === 'object' && Array.isArray((d as any).allLocalIds)
  );
  const diagByChunk = new Map(validDiag.map(d => [d.chunkIndex, d]));
  const allIdsByChunk = new Map(validDiag.map(d => [d.chunkIndex, new Set(d.allLocalIds)]));
  const modeByChunk = new Map<number, 'llm-ids' | 'position'>();
  for (const k of keys) if (!modeByChunk.has(k.chunkIndex)) modeByChunk.set(k.chunkIndex, k.mode);
  const chunksWithoutDiag = [...modeByChunk.keys()].filter(ci => !diagByChunk.has(ci));
  if (chunksWithoutDiag.length > 0) {
    console.warn(
      `⚠️ remapRelatedIds: diagnostik chunk ${chunksWithoutDiag.map(c => c + 1).join(', ')} tidak diterima; ` +
      `referensi terbuang tidak bisa dibedakan antara 'item terbuang' dan 'nomor tak ada'. ` +
      `Periksa bahwa buildChunkLocalKeys().diagnostics di-push ke array yang dikirim sebagai argumen ke-3.`
    );
  }
  const perChunkMap = new Map<number, ChunkRemapStats>();
  const chunkStats = (ci: number): ChunkRemapStats => {
    let c = perChunkMap.get(ci);
    if (!c) {
      const d = diagByChunk.get(ci);
      c = {
        chunkIndex: ci,
        mode: modeByChunk.get(ci) ?? d?.mode ?? 'position',
        reason: d?.reason ?? 'unknown',
        itemsAccepted: 0,
        emitted: 0,
        mapped: 0,
        droppedTargetRemoved: 0,
        droppedTargetNonexistent: 0,
        droppedTargetUnclassified: 0,
        droppedUnparseable: 0,
        droppedSelf: 0,
        droppedDuplicate: 0,
        samples: []
      };
      perChunkMap.set(ci, c);
    }
    return c;
  };

  const stats: RemapStats = {
    totalRefs: 0,
    mapped: 0,
    droppedUnknown: 0,
    droppedSelf: 0,
    droppedDuplicate: 0,
    chunksUsingLlmIds: [...modeByChunk.values()].filter(m => m === 'llm-ids').length,
    chunksUsingPosition: [...modeByChunk.values()].filter(m => m === 'position').length,
    perChunk: []
  };

  const out = evidence.map((ev, i) => {
    const cs = chunkStats(keys[i].chunkIndex);
    cs.itemsAccepted++;
    const raw = toRefArray(ev.related_evidence_ids);
    if (raw.length === 0) return { ...ev, related_evidence_ids: null };

    const seen = new Set<string>();
    const result: string[] = [];
    const note = (ref: string, reason: DroppedRef['reason']) => {
      if (cs.samples.length < 8) cs.samples.push({ from: ev.evidence_id ?? '?', ref, reason });
    };
    for (const r of raw) {
      stats.totalRefs++;
      cs.emitted++;
      const local = normalizeLocalId(r);
      const finalId = local ? map.get(`${keys[i].chunkIndex}:${local}`) : undefined;
      if (!finalId) {
        stats.droppedUnknown++;
        if (!local) {
          cs.droppedUnparseable++;
          note(String(r), 'unparseable');
        } else if (!allIdsByChunk.has(keys[i].chunkIndex)) {
          cs.droppedTargetUnclassified++;
          note(String(r), 'target-unclassified');
        } else if (allIdsByChunk.get(keys[i].chunkIndex)!.has(local)) {
          cs.droppedTargetRemoved++;
          note(String(r), 'target-removed');
        } else {
          cs.droppedTargetNonexistent++;
          note(String(r), 'target-nonexistent');
        }
        continue;
      }
      if (finalId === ev.evidence_id) {
        stats.droppedSelf++;
        cs.droppedSelf++;
        continue;
      }
      if (seen.has(finalId)) {
        stats.droppedDuplicate++;
        cs.droppedDuplicate++;
        continue;
      }
      seen.add(finalId);
      result.push(finalId);
      stats.mapped++;
      cs.mapped++;
    }
    return { ...ev, related_evidence_ids: result.length ? result : null };
  });

  stats.perChunk = [...perChunkMap.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
  return { evidence: out as T[], stats };
}

/**
 * Langkah 4: setelah duplicate gate.
 * - id yang dihapus sebagai duplikat -> diarahkan ke kept_evidence_id
 * - id a/b yang digabung -> diarahkan ke merged_evidence_id
 * - referensi ke id yang tidak ada di hasil akhir, ke diri sendiri,
 *   atau ganda -> dibuang
 */
export function redirectRelatedIds<T extends HasRelated>(
  preserved: T[],
  removed: Array<{ evidence_id: string; kept_evidence_id: string }>,
  merged: Array<{ evidence_id_a: string; evidence_id_b: string; merged_evidence_id: string }>
): { evidence: T[]; dropped: number } {
  const redirect = new Map<string, string>();
  for (const r of removed) redirect.set(r.evidence_id, r.kept_evidence_id);
  for (const m of merged) {
    redirect.set(m.evidence_id_a, m.merged_evidence_id);
    redirect.set(m.evidence_id_b, m.merged_evidence_id);
  }
  const resolve = (id: string): string => {
    let cur = id;
    for (let hop = 0; hop < 5 && redirect.has(cur) && redirect.get(cur) !== cur; hop++) {
      cur = redirect.get(cur)!;
    }
    return cur;
  };

  const finalIds = new Set(preserved.map(e => e.evidence_id).filter(Boolean) as string[]);
  let dropped = 0;

  const evidence = preserved.map(ev => {
    const raw = toRefArray(ev.related_evidence_ids);
    if (raw.length === 0) return ev;
    const seen = new Set<string>();
    const result: string[] = [];
    for (const r of raw) {
      const target = resolve(r);
      if (!finalIds.has(target) || target === ev.evidence_id || seen.has(target)) {
        dropped++;
        continue;
      }
      seen.add(target);
      result.push(target);
    }
    return { ...ev, related_evidence_ids: result.length ? result : null };
  });

  return { evidence: evidence as T[], dropped };
}