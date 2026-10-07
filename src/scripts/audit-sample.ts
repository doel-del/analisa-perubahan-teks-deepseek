// ============================================================
// AUDIT SAMPLE — CSV audit presisi lintas varian (tanpa API)
// ============================================================
// Letakkan di: scripts/audit-sample.ts
//
// Pertanyaan yang dijawab: apakah item TAMBAHAN dari varian baru sama akuratnya
// dengan item yang sudah stabil? Tiga kelompok (per review, tingkat EXCERPT):
//
//   baru-varian : item varian target yang TIDAK punya padanan (exact / contained)
//                 di run baseline mana pun  -> informasi tambahan dari varian
//   kontrol     : item varian target yang punya padanan di baseline
//   hilang      : item baseline yang tidak punya padanan di varian target
//                 -> apa yang HILANG bila pindah ke varian target
//
// Pakai:
//   npx tsx scripts/audit-sample.ts --variant 4000/2 --against 8000/2 \
//     --reviews c1qTN1rmO2g,07DQ9c6-KxA,WD3wS0TCU7Q,SqmQtAFjIW8,kwoPr9769gc \
//     --csv audit-4000.csv --sample 40 --control 20 --lost 15 --sep ';'
//   opsi: --seed 42 (acak yang bisa diulang), --sep tab
//   --against-runs K [--against-offset O]
//        pakai K run baseline tertua (setelah melewati O) agar jumlah run sama dengan varian
//        (mis. 2 vs 2). Jalankan juga dengan --against-offset 1 sebagai cek sensitivitas.
//   --stratify
//        sampel round-robin antar review (satu video tidak mendominasi sampel).
//
// Unit hitung = proposisi, bukan string excerpt: dalam satu sisi (varian atau baseline), excerpt
// dari run BERBEDA yang identik atau saling memuat (>= 15 karakter) digabung jadi satu item, dan
// "run_muncul" menghitung run yang memuat padanan tsb. Item lain dari run yang sama tidak digabung.
//
// Hanya item yang LOLOS validator. Kolom "kelompok" ada di paling kanan; sembunyikan
// sebelum melabeli agar buta. "run_muncul" = di berapa run varian asalnya excerpt
// yang sama muncul (mis. 2/2 = stabil).
//
// Pencocokan "contained" memakai substring dan hanya berlaku bila excerpt yang lebih
// pendek >= 15 karakter ternormalisasi (menghindari "fixed focus" cocok dengan apa saja).
// ============================================================

import fs from 'fs';
import path from 'path';
import {
  parseSRT,
  buildEvidenceChunks,
  buildChunkText,
  parseEvidenceJSONDetailed,
  normalizeNullishFields
} from '../src/evidence/production-pipeline';
import { normalizeForSearch } from '../src/evidence/srt';
import { EvidenceValidator } from '../src/evidence/validators/evidence-validator';
import type { EvidenceContext, EvidenceItem } from '../src/evidence/types';

const RUN_LOG_DIR = path.resolve(process.env.EVIDENCE_RUN_LOG_DIR ?? './runs');
const MIN_CONTAIN = 15;

interface RunRecord {
  run_id: string;
  review_id?: string | null;
  srt_sha: string;
  chunk_chars?: number;
  chunk_overlap?: number;
}

interface Item {
  review: string;
  run_id: string;
  variant: string;
  chunk: number;
  key: string;
  excerpt: string;
  claim: string;
  type: string;
  subtopic: string;
  segFirst: number | null;
  segLast: number | null;
  context: string;
}

interface Row {
  kelompok: string;
  item: Item;
  runMuncul: string;
}

const args = process.argv.slice(2);
const valueOf = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const variant = valueOf('--variant');
const against = valueOf('--against') ?? '8000/2';
const reviewFilter = (valueOf('--reviews') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const csvOut = valueOf('--csv');
const nSample = Number(valueOf('--sample') ?? 40);
const nControl = Number(valueOf('--control') ?? 20);
const nLost = Number(valueOf('--lost') ?? 15);
const seed = Number(valueOf('--seed') ?? 42);
const sepArg = valueOf('--sep') ?? ',';
const againstRuns = Number(valueOf('--against-runs') ?? 0);        // 0 = semua run baseline
const againstOffset = Number(valueOf('--against-offset') ?? 0);    // lewati N run baseline tertua
const stratify = args.includes('--stratify');
const sep = sepArg === 'tab' ? '\t' : sepArg;

if (!variant) {
  console.error('Wajib: --variant <chars/overlap>, mis. --variant 4000/2');
  process.exit(1);
}

function rng(s: number): () => number {            // mulberry32
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const trunc = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const pad = (s: string | number, n: number) => String(s).padEnd(n);

function readRuns(): RunRecord[] {
  const file = path.join(RUN_LOG_DIR, 'runs.jsonl');
  if (!fs.existsSync(file)) return [];
  const out: RunRecord[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.run_id && r.srt_sha) out.push(r);
    } catch { /* lewati */ }
  }
  return out;
}

function isValidEvidence(ev: any): boolean {
  return !!ev && typeof ev === 'object' && !Array.isArray(ev) &&
    typeof ev.claim === 'string' && ev.claim.trim().length > 0;
}

// Salinan dari server.ts (lihat CATATAN DRIFT di replay-run.ts).
function reconcile(ev: EvidenceItem): EvidenceItem {
  const has = ev.reviewer_assessment !== null && ev.reviewer_assessment !== undefined &&
    String(ev.reviewer_assessment).trim() !== '';
  if (has && (ev.type || '').toUpperCase() !== 'OPINION') return { ...ev, type: 'OPINION' };
  return ev;
}

function loadItems(run: RunRecord): Item[] {
  const runDir = path.join(RUN_LOG_DIR, run.run_id);
  const srtPath = path.join(RUN_LOG_DIR, '_srt', `${run.srt_sha}.srt`);
  if (!fs.existsSync(runDir) || !fs.existsSync(srtPath)) return [];
  if (run.chunk_chars === undefined || run.chunk_overlap === undefined) return [];

  const all = parseSRT(fs.readFileSync(srtPath, 'utf8'));
  const textByIndex = new Map<number, string>(all.map(s => [s.index, s.text]));
  const chunks = buildEvidenceChunks(all, run.chunk_chars, run.chunk_overlap);
  const items: Item[] = [];
  const variantLabel = `${run.chunk_chars}/${run.chunk_overlap}`;

  chunks.forEach((chunk, ci) => {
    const rawPath = path.join(runDir, `chunk-${ci + 1}.raw.txt`);
    if (!fs.existsSync(rawPath)) return;

    const context: EvidenceContext = { chunkIndex: ci, chunkText: buildChunkText(chunk), chunkSegments: chunk };
    const starts: number[] = [];
    let hay = '';
    for (const s of chunk) {
      starts.push(hay.length);
      const n = normalizeForSearch(s.text);
      if (n) hay += n + ' ';
    }
    const segAt = (pos: number) => {
      let lo = 0, hi = starts.length - 1, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    };

    const parsed = parseEvidenceJSONDetailed(fs.readFileSync(rawPath, 'utf8')).evidence as EvidenceItem[];
    for (const ev of parsed.filter(isValidEvidence)) {
      normalizeNullishFields(ev);
      const reconciled = reconcile(ev);
      const report = EvidenceValidator.validate(reconciled, context);
      if (!report.accepted) continue;

      const excerpt = String(ev.source_excerpt ?? '');
      const key = normalizeForSearch(excerpt);
      if (!key) continue;

      let segFirst: number | null = null;
      let segLast: number | null = null;
      const p = hay.indexOf(key);
      if (p >= 0) {
        segFirst = chunk[segAt(p)].index;
        segLast = chunk[segAt(p + key.length - 1)].index;
      }

      let ctx = '';
      if (segFirst !== null && segLast !== null) {
        const parts: string[] = [];
        for (let s = segFirst - 1; s <= segLast + 1; s++) {
          const t = textByIndex.get(s);
          if (t) parts.push(t.replace(/\s+/g, ' ').trim());
        }
        ctx = trunc(parts.join(' | '), 400);
      }

      items.push({
        review: run.review_id ?? 'noid',
        run_id: run.run_id,
        variant: variantLabel,
        chunk: ci + 1,
        key,
        excerpt,
        claim: String(ev.claim ?? ''),
        type: String(reconciled.type ?? ''),
        subtopic: String(ev.subtopic ?? ''),
        segFirst,
        segLast,
        context: ctx
      });
    }
  });
  return items;
}

function related(a: string, b: string): boolean {
  const [shorter] = a.length <= b.length ? [a] : [b];
  if (shorter.length < MIN_CONTAIN) return false;
  return a.includes(b) || b.includes(a);
}

function hasMatch(key: string, others: Map<string, { keys: string[] }>): boolean {
  for (const v of others.values()) {
    for (const k of v.keys) if (k === key || related(key, k)) return true;
  }
  return false;
}

function csvCell(v: unknown): string {
  const s = String(v ?? '').replace(/\r?\n/g, ' ');
  return s.includes(sep) || s.includes('"') || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function main(): void {
  let runs = readRuns().filter(r => fs.existsSync(path.join(RUN_LOG_DIR, r.run_id)));
  if (reviewFilter.length > 0) runs = runs.filter(r => reviewFilter.some(f => (r.review_id ?? '').startsWith(f)));

  const label = (r: RunRecord) => `${r.chunk_chars}/${r.chunk_overlap}`;
  const reviews = [...new Set(runs.map(r => r.review_id ?? 'noid'))].sort();

  const baru: Row[] = [];
  const kontrol: Row[] = [];
  const hilang: Row[] = [];
  const popTable: { review: string; nT: number; nB: number; baru: number; kontrol: number; hilang: number }[] = [];

  for (const review of reviews) {
    const rT = runs.filter(r => (r.review_id ?? 'noid') === review && label(r) === variant);
    const rBAll = runs
      .filter(r => (r.review_id ?? 'noid') === review && label(r) === against)
      .sort((x, y) => x.run_id.localeCompare(y.run_id));
    // --against-offset tanpa --against-runs: samakan jumlah run baseline dengan jumlah run varian.
    const kB = againstRuns > 0 ? againstRuns : (againstOffset > 0 ? rT.length : 0);
    const rB = kB > 0 ? rBAll.slice(againstOffset, againstOffset + kB) : rBAll;
    if (kB > 0 && rB.length < kB) {
      console.warn(`  ! ${review}: hanya ${rB.length} run baseline setelah offset ${againstOffset} (diminta ${kB})`);
    }
    if (rT.length === 0 || rB.length === 0) {
      console.warn(`  ! ${review}: run varian ${variant}=${rT.length}, baseline ${against}=${rB.length}; dilewati`);
      continue;
    }

    // key -> {item pertama, run yang memuatnya}
    const build = (rs: RunRecord[]) => {
      const m = new Map<string, { item: Item; runs: Set<string>; keys: string[] }>();
      for (const r of rs) {
        for (const it of loadItems(r)) {
          // Gabungkan padanan LINTAS run (identik atau saling memuat) jadi satu item.
          let cur = m.get(it.key);
          if (!cur) {
            for (const v of m.values()) {
              if (!v.runs.has(r.run_id) && v.keys.some(k => k === it.key || related(it.key, k))) { cur = v; break; }
            }
          }
          if (cur) {
            cur.runs.add(r.run_id);
            if (!cur.keys.includes(it.key)) cur.keys.push(it.key);
          } else {
            m.set(it.key, { item: it, runs: new Set([r.run_id]), keys: [it.key] });
          }
        }
      }
      return m;
    };
    const T = build(rT);
    const B = build(rB);

    let cBaru = 0, cKontrol = 0, cHilang = 0;
    for (const [key, v] of T) {
      const row: Row = { kelompok: '', item: v.item, runMuncul: `${v.runs.size}/${rT.length}` };
      if (hasMatch(key, B)) { row.kelompok = 'kontrol'; kontrol.push(row); cKontrol++; }
      else { row.kelompok = 'baru-varian'; baru.push(row); cBaru++; }
    }
    for (const [key, v] of B) {
      if (hasMatch(key, T)) continue;
      hilang.push({ kelompok: 'hilang', item: v.item, runMuncul: `${v.runs.size}/${rB.length}` });
      cHilang++;
    }
    popTable.push({ review, nT: rT.length, nB: rB.length, baru: cBaru, kontrol: cKontrol, hilang: cHilang });
  }

  if (popTable.length === 0) {
    console.error('Tidak ada review dengan run di kedua varian (cek --variant / --against / --reviews).');
    process.exit(1);
  }

  // Populasi (sebelum sampling)
  console.log('='.repeat(90));
  console.log(`POPULASI: varian ${variant} vs baseline ${against} (excerpt unik, hanya item lolos validator)`);
  console.log(pad('review', 13) + pad(`run ${variant}`, 12) + pad(`run ${against}`, 12) + pad('baru-varian', 13) + pad('kontrol', 9) + 'hilang');
  for (const r of popTable) {
    console.log(pad(r.review.slice(0, 11), 13) + pad(r.nT, 12) + pad(r.nB, 12) + pad(r.baru, 13) + pad(r.kontrol, 9) + r.hilang);
  }
  const tot = (f: (r: typeof popTable[number]) => number) => popTable.reduce((s, r) => s + f(r), 0);
  console.log('-'.repeat(90));
  console.log(`TOTAL baru-varian=${tot(r => r.baru)}  kontrol=${tot(r => r.kontrol)}  hilang=${tot(r => r.hilang)}`);
  console.log(`  → selisih kotor informasi = baru − hilang = ${tot(r => r.baru) - tot(r => r.hilang)} excerpt (sebelum dikoreksi presisi)`);
  const unbalanced = popTable.filter(r => r.nT !== r.nB);
  if (unbalanced.length > 0) {
    console.log(
      `  ! JUMLAH RUN TIDAK SEIMBANG di ${unbalanced.length} review (varian vs baseline). Sisi dengan lebih banyak run ` +
      `punya gabungan lebih lebar: "hilang" membengkak dan "baru-varian" mengecil, bias melawan varian. ` +
      `Pakai --against-runs ${popTable[0].nT} (dan cek --against-offset 1).`
    );
  }

  const stableBaru = baru.filter(r => r.runMuncul.split('/')[0] === r.runMuncul.split('/')[1]).length;
  console.log(`  baru-varian yang muncul di SEMUA run varian: ${stableBaru}/${baru.length} (indikator stabilitas; padanan lintas run termasuk saling memuat)`);

  if (!csvOut) {
    console.log('\n(Tambahkan --csv <file> untuk mengekspor lembar audit.)');
    return;
  }

  const rand = rng(seed);
  const pick = <T extends { item: Item }>(arr: T[], n: number): T[] => {
    if (!stratify) return shuffle(arr, rand).slice(0, Math.max(0, n));
    // round-robin antar review supaya satu video tidak mendominasi sampel
    const by = new Map<string, T[]>();
    for (const x of arr) {
      if (!by.has(x.item.review)) by.set(x.item.review, []);
      by.get(x.item.review)!.push(x);
    }
    const lists = [...by.values()].map(l => shuffle(l, rand));
    const out: T[] = [];
    for (let i = 0; out.length < n; i++) {
      let any = false;
      for (const l of lists) {
        if (i < l.length && out.length < n) { out.push(l[i]); any = true; }
      }
      if (!any) break;
    }
    return out;
  };
  const rows = shuffle([...pick(baru, nSample), ...pick(kontrol, nControl), ...pick(hilang, nLost)], rand);

  const header = [
    'no', 'review', 'varian_asal', 'run_id', 'run_muncul', 'chunk', 'seg_awal', 'seg_akhir', 'type', 'subtopic',
    'claim', 'source_excerpt', 'konteks_srt', 'label_benar(1/0)', 'label_informatif(1/0)', 'catatan', 'kelompok'
  ];
  const lines = [header.map(csvCell).join(sep)];
  rows.forEach((r, i) => {
    const it = r.item;
    lines.push([
      i + 1, it.review, it.variant, it.run_id, r.runMuncul, it.chunk, it.segFirst ?? '', it.segLast ?? '',
      it.type, it.subtopic, it.claim, it.excerpt, it.context, '', '', '', r.kelompok
    ].map(csvCell).join(sep));
  });
  fs.writeFileSync(csvOut, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');

  console.log('');
  console.log(
    `CSV: ${rows.length} baris (baru-varian=${Math.min(nSample, baru.length)}, kontrol=${Math.min(nControl, kontrol.length)}, ` +
    `hilang=${Math.min(nLost, hilang.length)}) → ${csvOut}  [diacak, seed ${seed}]`
  );
  console.log('  Sembunyikan kolom "kelompok" (paling kanan) sebelum melabeli.');
  console.log('  label_benar = claim didukung excerpt+konteks, subjek/atribut tepat, tidak menambah info luar.');
  console.log('  label_informatif = bukan hal sepele/redundan bagi pembaca review.');
}

main();