// ============================================================
// REPLAY RUN — parser + validator pada output mentah tersimpan
// ============================================================
// Tanpa API. Membaca (ditulis server.ts sejak patch run log):
//   runs/runs.jsonl
//   runs/<run_id>/chunk-N.raw.txt
//   runs/_srt/<srt_sha>.srt
//
// Pakai (dari root proyek):
//   npx tsx scripts/replay-run.ts                        run terakhir
//   npx tsx scripts/replay-run.ts <run_id | prefix>      satu run
//   npx tsx scripts/replay-run.ts --all                  semua run yang punya raw
//   npx tsx scripts/replay-run.ts <run> --json out.json  simpan keputusan per item
//   npx tsx scripts/replay-run.ts <run> --diff out.json  bandingkan dengan simpanan
//   Tambah --full untuk menampilkan SEMUA item quarantine (default 40 pertama).
//
// Cakupan : parse JSON -> filter struktural -> auto-reconcile tipe ->
//           EvidenceValidator.validate (grounding, provenance, assessment,
//           value, atomicity).
// Di luar : duplicate gate, pemetaan relasi, pemanggilan LLM.
// Chunk yang gagal diparse otomatis didiagnosis (terpotong / sintaks rusak / teks tambahan).
//
// CATATAN DRIFT: isValidEvidence dan reconcileTypeWithAssessment di bawah
// adalah SALINAN dari server.ts. Kolom "parity" membandingkan hasil replay
// dengan angka asli di runs.jsonl. BEDA itu wajar bila validator sengaja
// diubah sejak run; jika kode tidak diubah tetapi BEDA, salinan ini sudah
// tidak sinkron dengan server.ts.
// ============================================================

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  parseSRT,
  buildEvidenceChunks,
  buildChunkText,
  parseEvidenceJSONDetailed
} from '../src/evidence/production-pipeline';
import { EvidenceValidator } from '../src/evidence/validators/evidence-validator';
import type { EvidenceContext, EvidenceItem } from '../src/evidence/types';

// ------------------------------------------------------------
// Tipe
// ------------------------------------------------------------
interface ChunkRecord {
  chunk: number;
  status: string;
  raw_chars: number | null;
  parsed: number;
  accepted: number;
  quarantine: number;
}

interface RunRecord {
  run_id: string;
  review_id?: string | null;
  srt_sha: string;
  chunk_chars?: number;
  chunk_overlap?: number;
  code_hash?: string;
  git_commit?: string;
  parsed_evidence?: number;
  validator_accepted?: number;
  quarantine?: number;
  chunks: ChunkRecord[];
}

interface ItemDecision {
  key: string;            // "<chunk 1-based>:<posisi 1-based pada hasil parse>"
  chunk: number;
  pos: number;
  accepted: boolean;
  type: string;
  claim: string;
  excerpt: string;
  blocking: string[];     // aturan yang menyebabkan quarantine
  reason: string;
}

interface ChunkReplay {
  chunk: number;
  parsed: number;
  structurallyInvalid: number;
  accepted: number;
  quarantine: number;
  parseStatus: string;
  strategy: string;
  note?: string;
  diagnosis?: string[];
}

interface ReplayResult {
  run: RunRecord;
  chunks: ChunkReplay[];
  items: ItemDecision[];
  notes: string[];
}

// ------------------------------------------------------------
// Salinan dari server.ts (lihat CATATAN DRIFT)
// ------------------------------------------------------------
function isValidEvidence(ev: any): boolean {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return false;
  return typeof ev.claim === 'string' && ev.claim.trim().length > 0;
}

function reconcileTypeWithAssessment(ev: EvidenceItem): EvidenceItem {
  const hasAssessment =
    ev.reviewer_assessment !== null &&
    ev.reviewer_assessment !== undefined &&
    String(ev.reviewer_assessment).trim() !== '';
  const normalizedType = (ev.type || '').toUpperCase();
  if (hasAssessment && normalizedType !== 'OPINION') {
    return { ...ev, type: 'OPINION' };
  }
  return ev;
}

// Hash isi file kode kunci (salinan daftar dari server.ts; hanya indikatif).
function computeCodeHash(): string {
  const files: string[] = [
    'server.ts',
    'prompts.ts',
    'src/llm/llm-provider.ts',
    'src/evidence/production-pipeline.ts',
    'src/evidence/related-ids.ts',
    'src/evidence/search.ts',
    'src/evidence/srt.ts',
    'src/evidence/text-matching.ts'
  ];
  try {
    const vdir = 'src/evidence/validators';
    for (const f of fs.readdirSync(vdir).sort()) {
      if (f.endsWith('.ts')) files.push(`${vdir}/${f}`);
    }
  } catch { /* abaikan */ }
  const h = crypto.createHash('sha256');
  for (const f of files) {
    try {
      h.update(f);
      h.update(fs.readFileSync(f));
    } catch { /* file tidak ada */ }
  }
  return h.digest('hex').slice(0, 8);
}

// ------------------------------------------------------------
// I/O
// ------------------------------------------------------------
const RUN_LOG_DIR = path.resolve(process.env.EVIDENCE_RUN_LOG_DIR ?? './runs');

function readRuns(): RunRecord[] {
  const file = path.join(RUN_LOG_DIR, 'runs.jsonl');
  if (!fs.existsSync(file)) return [];
  const out: RunRecord[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.run_id && r.srt_sha && Array.isArray(r.chunks)) out.push(r);
    } catch { /* baris rusak dilewati */ }
  }
  return out;
}

function hasRaw(r: RunRecord): boolean {
  return fs.existsSync(path.join(RUN_LOG_DIR, r.run_id));
}

// ------------------------------------------------------------
// Diagnosis kegagalan parse
// ------------------------------------------------------------
// Menjawab: JSON terpotong? ada kesalahan sintaks di tengah (mis. tanda kutip
// tidak di-escape)? atau ada teks tambahan setelah JSON?
function diagnoseParseFailure(rawOutput: string): string[] {
  const out: string[] = [];
  const text = rawOutput.replace(/^\uFEFF/, '').trim();
  out.push(`panjang=${text.length} | awal: ${JSON.stringify(text.slice(0, 70))}`);
  out.push(`akhir: ${JSON.stringify(text.slice(-110))}`);

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const hasFence = text.includes('```');
  out.push(
    `pagar kode: ${fenced ? 'lengkap' : hasFence ? 'dibuka tetapi TIDAK ditutup (indikasi terpotong)' : 'tidak ada'}`
  );

  const body = (fenced?.[1] ?? text.replace(/^```(?:json)?\s*/i, '')).trim();

  // Pemindaian: kedalaman kurung di luar string, string tidak tertutup,
  // dan teks setelah objek/array pertama selesai.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let firstEnd = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0 && firstEnd < 0) firstEnd = i;
    }
  }
  if (inStr) out.push('string TIDAK tertutup di akhir output (kuat: terpotong di tengah teks)');
  if (depth > 0) out.push(`kurung belum tertutup (kedalaman akhir=${depth}) -> output terpotong`);
  if (firstEnd >= 0 && body.slice(firstEnd + 1).trim().length > 0) {
    out.push(`ada teks SETELAH JSON selesai: ${JSON.stringify(body.slice(firstEnd + 1).trim().slice(0, 100))}`);
  }

  try {
    JSON.parse(body);
    out.push('JSON.parse(isi) BERHASIL tetapi bentuknya bukan {"evidence":[...]} atau [...]');
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    out.push(`JSON.parse: ${msg}`);
    const m = /position (\d+)/.exec(msg);
    if (m) {
      const pos = Number(m[1]);
      out.push(
        `konteks @${pos}: ${JSON.stringify(body.slice(Math.max(0, pos - 90), pos))} <<< DI SINI >>> ` +
        `${JSON.stringify(body.slice(pos, pos + 50))}`
      );
    }
  }
  return out;
}

// ------------------------------------------------------------
// Replay satu run
// ------------------------------------------------------------
function replayRun(run: RunRecord): ReplayResult {
  const notes: string[] = [];
  const chunks: ChunkReplay[] = [];
  const items: ItemDecision[] = [];

  const srtPath = path.join(RUN_LOG_DIR, '_srt', `${run.srt_sha}.srt`);
  if (!fs.existsSync(srtPath)) {
    notes.push(`SRT tidak ditemukan: ${srtPath}`);
    return { run, chunks, items, notes };
  }

  const segments = parseSRT(fs.readFileSync(srtPath, 'utf8'));
  const evChunks = buildEvidenceChunks(
    segments,
    run.chunk_chars ?? 18000,
    run.chunk_overlap ?? 3
  );
  if (evChunks.length !== run.chunks.length) {
    notes.push(
      `Jumlah chunk hasil rekonstruksi (${evChunks.length}) berbeda dari run asli ` +
      `(${run.chunks.length}); cek EVIDENCE_CHUNK_CHARS / EVIDENCE_CHUNK_OVERLAP.`
    );
  }

  evChunks.forEach((chunk, chunkIndex) => {
    const n = chunkIndex + 1;
    const rawPath = path.join(RUN_LOG_DIR, run.run_id, `chunk-${n}.raw.txt`);
    if (!fs.existsSync(rawPath)) {
      chunks.push({
        chunk: n, parsed: 0, structurallyInvalid: 0, accepted: 0, quarantine: 0,
        parseStatus: '-', strategy: '-', note: 'raw tidak ada (chunk gagal di run asli?)'
      });
      return;
    }

    const rawText = fs.readFileSync(rawPath, 'utf8');
    const parsedResult = parseEvidenceJSONDetailed(rawText);
    const parsedItems = parsedResult.evidence as EvidenceItem[];
    const positionOf = new Map<unknown, number>();
    parsedItems.forEach((e, i) => positionOf.set(e, i + 1));

    const valid = parsedItems.filter(isValidEvidence);
    const context: EvidenceContext = {
      chunkIndex,
      chunkText: buildChunkText(chunk),
      chunkSegments: chunk
    };

    let accepted = 0;
    let quarantine = 0;
    for (const ev of valid) {
      const reconciled = reconcileTypeWithAssessment(ev);
      const report = EvidenceValidator.validate(reconciled, context);
      const blocking = report.results
        .filter(r => r.status === 'FAIL' || (r.status === 'SUSPECT' && r.severity === 'HIGH'))
        .map(r => r.rule);
      const pos = positionOf.get(ev) ?? 0;
      if (report.accepted) accepted++; else quarantine++;
      items.push({
        key: `${n}:${pos}`,
        chunk: n,
        pos,
        accepted: report.accepted,
        type: String(reconciled.type ?? ''),
        claim: String(ev.claim ?? ''),
        excerpt: String(ev.source_excerpt ?? ''),
        blocking: report.accepted ? [] : Array.from(new Set(blocking)),
        reason: report.quarantineReason ?? ''
      });
    }

    chunks.push({
      chunk: n,
      parsed: parsedItems.length,
      structurallyInvalid: parsedItems.length - valid.length,
      accepted,
      quarantine,
      parseStatus: parsedResult.status,
      strategy: String(parsedResult.strategy),
      diagnosis: parsedResult.status === 'FAILED' ? diagnoseParseFailure(rawText) : undefined
    });
  });

  return { run, chunks, items, notes };
}

// ------------------------------------------------------------
// Pelaporan
// ------------------------------------------------------------
function trunc(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

function byRule(items: ItemDecision[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    if (it.accepted) continue;
    for (const r of it.blocking) out[r] = (out[r] ?? 0) + 1;
  }
  return out;
}

function printRun(res: ReplayResult, full: boolean, currentHash: string): void {
  const { run, chunks, items, notes } = res;
  console.log('='.repeat(78));
  console.log(
    `RUN ${run.run_id}  review=${run.review_id ?? '-'}  ` +
    `code_hash run=${run.code_hash ?? '-'} sekarang=${currentHash}` +
    `${run.code_hash && run.code_hash !== currentHash ? '  (KODE SUDAH BERUBAH)' : ''}`
  );
  for (const n of notes) console.log(`  ! ${n}`);

  console.log(`  ${pad('chunk', 6)}${pad('parsed', 8)}${pad('accept', 8)}${pad('quar', 6)}${pad('parse', 22)}| asli: parsed/accept/quar -> parity`);
  let tp = 0, ta = 0, tq = 0, allSame = true;
  for (const c of chunks) {
    const orig = run.chunks.find(x => x.chunk === c.chunk);
    const same = !!orig && orig.parsed === c.parsed && orig.accepted === c.accepted && orig.quarantine === c.quarantine;
    if (!same) allSame = false;
    tp += c.parsed; ta += c.accepted; tq += c.quarantine;
    console.log(
      `  ${pad(c.chunk, 6)}${pad(c.parsed, 8)}${pad(c.accepted, 8)}${pad(c.quarantine, 6)}` +
      `${pad(`${c.parseStatus}/${c.strategy}`, 22)}| ` +
      `${orig ? `${orig.parsed}/${orig.accepted}/${orig.quarantine}` : '-'} -> ${same ? 'SAMA' : 'BEDA'}` +
      `${c.note ? '  ' + c.note : ''}`
    );
  }
  for (const c of chunks) {
    if (!c.diagnosis) continue;
    console.log(`  >> chunk ${c.chunk}: PARSE GAGAL, diagnosis:`);
    for (const d of c.diagnosis) console.log(`       ${d}`);
  }
  const rate = tp > 0 ? ((tq / tp) * 100).toFixed(1) : '0.0';
  console.log(`  TOTAL parsed=${tp} accepted=${ta} quarantine=${tq} (${rate}%)  parity keseluruhan: ${allSame ? 'SAMA' : 'BEDA'}`);

  const rules = byRule(items);
  const ruleTxt = Object.keys(rules).sort().map(k => `${k}=${rules[k]}`).join('  ') || '-';
  console.log(`  Quarantine per aturan: ${ruleTxt}`);

  const quar = items.filter(i => !i.accepted);
  const shown = full ? quar : quar.slice(0, 40);
  for (const q of shown) {
    console.log(`  [c${q.chunk}#${q.pos}] ${q.blocking.join('+') || '-'} | ${q.type} | ${trunc(q.claim, 70)}`);
    console.log(`        ${trunc(q.reason, 150)}`);
  }
  if (!full && quar.length > shown.length) {
    console.log(`  ... ${quar.length - shown.length} item lagi (gunakan --full)`);
  }
}

function printAllTable(results: ReplayResult[]): void {
  console.log('='.repeat(78));
  console.log('RINGKASAN SEMUA RUN (hasil replay dengan kode SAAT INI)');
  console.log(`${pad('run', 21)}${pad('review', 13)}${pad('parsed', 8)}${pad('accept', 8)}${pad('quar', 6)}${pad('rasio', 8)}${pad('gagal-parse', 12)}aturan`);
  const totalRules: Record<string, number> = {};
  for (const r of results) {
    const tp = r.chunks.reduce((s, c) => s + c.parsed, 0);
    const tq = r.chunks.reduce((s, c) => s + c.quarantine, 0);
    const ta = r.chunks.reduce((s, c) => s + c.accepted, 0);
    const rules = byRule(r.items);
    for (const k of Object.keys(rules)) totalRules[k] = (totalRules[k] ?? 0) + rules[k];
    const ruleTxt = Object.keys(rules).sort().map(k => `${k}=${rules[k]}`).join(' ') || '-';
    console.log(
      `${pad(r.run.run_id.slice(0, 19), 21)}${pad(String(r.run.review_id ?? '-').slice(0, 11), 13)}` +
      `${pad(tp, 8)}${pad(ta, 8)}${pad(tq, 6)}${pad(tp ? ((tq / tp) * 100).toFixed(1) + '%' : '-', 8)}` +
      `${pad(r.chunks.filter(c => c.parseStatus === 'FAILED').length + '/' + r.chunks.length, 12)}${ruleTxt}`
    );
  }
  console.log(`Total per aturan: ${Object.keys(totalRules).sort().map(k => `${k}=${totalRules[k]}`).join('  ') || '-'}`);
}

function printDiff(res: ReplayResult, prevPath: string): void {
  const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8')) as { run_id?: string; items: ItemDecision[] };
  const before = new Map(prev.items.map(i => [i.key, i]));
  const after = new Map(res.items.map(i => [i.key, i]));
  let flips = 0;
  console.log('-'.repeat(78));
  console.log(`DIFF terhadap ${prevPath}${prev.run_id && prev.run_id !== res.run.run_id ? `  (run simpanan berbeda: ${prev.run_id})` : ''}`);
  for (const [key, a] of after) {
    const b = before.get(key);
    if (!b) { flips++; console.log(`  + BARU  [${key}] ${a.accepted ? 'accepted' : 'quarantine'} | ${trunc(a.claim, 80)}`); continue; }
    if (a.accepted !== b.accepted) {
      flips++;
      console.log(
        `  ${a.accepted ? '↑ LOLOS ' : '↓ DIKARANTINA'} [${key}] ` +
        `${b.blocking.join('+') || 'accepted'} -> ${a.blocking.join('+') || 'accepted'} | ${trunc(a.claim, 80)}`
      );
    }
  }
  for (const [key, b] of before) {
    if (!after.has(key)) { flips++; console.log(`  - HILANG [${key}] | ${trunc(b.claim, 80)}`); }
  }
  console.log(flips === 0 ? '  (tidak ada perubahan keputusan)' : `  Total perubahan: ${flips}`);
}

// ------------------------------------------------------------
// CLI
// ------------------------------------------------------------
function main(): void {
  const args: string[] = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const valueOf = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const skip = new Set<number>();
  for (const f of ['--json', '--diff']) {
    const i = args.indexOf(f);
    if (i >= 0) { skip.add(i); skip.add(i + 1); }
  }
  const positional = args.filter((a, i) => !a.startsWith('--') && !skip.has(i));

  const runs = readRuns();
  if (runs.length === 0) {
    console.error(`Tidak ada run di ${path.join(RUN_LOG_DIR, 'runs.jsonl')}.`);
    process.exit(1);
  }

  const replayable = runs.filter(hasRaw);
  if (replayable.length === 0) {
    console.error('Tidak ada run dengan folder raw (hanya run setelah patch run log yang bisa di-replay).');
    process.exit(1);
  }

  let selected: RunRecord[];
  if (flag('--all')) {
    selected = replayable;
  } else if (positional[0]) {
    selected = replayable.filter(r => r.run_id === positional[0] || r.run_id.startsWith(positional[0]));
    if (selected.length === 0) {
      console.error(`Run "${positional[0]}" tidak ditemukan. Tersedia:\n  ` + replayable.map(r => r.run_id).join('\n  '));
      process.exit(1);
    }
  } else {
    selected = [replayable[replayable.length - 1]];
  }

  const currentHash = computeCodeHash();
  const results = selected.map(replayRun);

  if (flag('--all')) {
    printAllTable(results);
    if (flag('--full')) results.forEach(r => printRun(r, true, currentHash));
  } else {
    results.forEach(r => printRun(r, flag('--full'), currentHash));
  }

  const jsonOut = valueOf('--json');
  if (jsonOut) {
    const payload = results.length === 1
      ? { run_id: results[0].run.run_id, code_hash: currentHash, items: results[0].items }
      : results.map(r => ({ run_id: r.run.run_id, code_hash: currentHash, items: r.items }));
    fs.writeFileSync(jsonOut, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`\nKeputusan per item disimpan ke ${jsonOut}`);
  }

  const diffIn = valueOf('--diff');
  if (diffIn) {
    if (results.length !== 1) {
      console.error('--diff hanya untuk satu run (hindari --all).');
      process.exit(1);
    }
    printDiff(results[0], diffIn);
  }
}

main();
