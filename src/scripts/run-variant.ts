// ============================================================
// RUN VARIANT — jalankan /api/evidence berulang untuk satu varian chunking
// ============================================================
// Letakkan di: scripts/run-variant.ts
//
// Server HARUS sudah berjalan dengan env varian yang diinginkan, mis. (PowerShell):
//   $env:EVIDENCE_CHUNK_CHARS="4000"; $env:EVIDENCE_CHUNK_OVERLAP="2"; npm run dev
// (env proses MENANG atas .env karena dotenv tidak menimpa variabel yang sudah ada)
//
// MODE UTAMA (sama seperti produksi): ambil langsung dari folder hasil scrape.
//   npx tsx scripts/run-variant.ts --root "D:\TubescrapeData\Smartphone\Samsung\Samsung Galaxy A26 5G" --reviews c1qTN1rmO2g,07DQ9c6-KxA --repeat 2 --expect 4000/2
//   Tiap subfolder (mis. "45hfkSE5DvA - Lebih Kencang ...") berisi metadata.json dan transcript.srt.
//   PENGAMAN: hash isi transcript.srt dibandingkan dengan srt_sha di runs.jsonl. Bila beda
//   (SRT diubah sejak run baseline), skrip berhenti: perbandingan tidak apple-to-apple.
//   Lewati dengan --allow-srt-diff HANYA bila Anda memang ingin SRT baru (maka jalankan ulang baseline juga).
//
// MODE ALTERNATIF (tanpa folder scrape): SRT dari runs/_srt, metadata dari --meta-dir.
//   npx tsx scripts/run-variant.ts --meta-dir metadata --reviews c1qTN1rmO2g,07DQ9c6-KxA --repeat 2 --expect 4000/2
//
// SRT diambil dari runs/_srt/<srt_sha>.srt; pemetaan review_id -> srt_sha dibaca dari
// runs/runs.jsonl (isi SRT identik dengan yang dulu dikirim, karena sha dihitung dari isinya).
// Metadata TIDAK disimpan di runs/, jadi harus disediakan di --meta-dir:
//   metadata/<review_id>.json   ATAU   metadata/<review_id>/metadata.json
// Opsi: --srt-dir (default <RUN_LOG_DIR>/_srt), --allow-minimal-meta (pakai {id} saja bila file
// metadata tidak ada; MENGUBAH konteks prompt dibanding baseline, jangan dipakai untuk pilot).
//
// Keamanan: setelah tiap run, skrip membaca baris terakhir runs/runs.jsonl dan
// MEMBATALKAN bila chunk_chars/chunk_overlap tidak sama dengan --expect
// (mencegah run tercatat sebagai varian yang salah).
// ============================================================

import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';

const RUN_LOG_DIR = path.resolve(process.env.EVIDENCE_RUN_LOG_DIR ?? './runs');

const args = process.argv.slice(2);
const valueOf = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const rootDir = valueOf('--root');
const allowSrtDiff = args.includes('--allow-srt-diff');
const metaDir = valueOf('--meta-dir');
const srtDir = valueOf('--srt-dir') ?? path.join(RUN_LOG_DIR, '_srt');
const allowMinimalMeta = args.includes('--allow-minimal-meta');
const reviews = (valueOf('--reviews') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const repeat = Math.max(1, Number(valueOf('--repeat') ?? 1));
const port = Number(valueOf('--port') ?? 3000);
const expect = valueOf('--expect');   // "4000/2"

if ((!rootDir && !metaDir && !allowMinimalMeta) || !expect || !/^\d+\/\d+$/.test(expect)) {
  console.error('Wajib: --root <folder scrape> atau --meta-dir <folder> (atau --allow-minimal-meta) dan --expect <chars/overlap>, mis. --expect 4000/2');
  process.exit(1);
}
const [expChars, expOverlap] = expect.split('/').map(Number);

interface Video { id: string; metadata: any; srt: string; name: string }

function loadVideos(): Video[] {
  // review_id -> srt_sha dari runs.jsonl
  const shas = new Map<string, Set<string>>();
  const file = path.join(RUN_LOG_DIR, 'runs.jsonl');
  if (!fs.existsSync(file)) {
    console.error(`runs.jsonl tidak ditemukan: ${file}`);
    process.exit(1);
  }
  const latest = new Map<string, string>();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.review_id && r.srt_sha) {
        latest.set(r.review_id, r.srt_sha);
        if (!shas.has(r.review_id)) shas.set(r.review_id, new Set());
        shas.get(r.review_id)!.add(r.srt_sha);
      }
    } catch { /* lewati */ }
  }

  const sha8 = (t: string) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 8);
  const stripBom = (t: string) => t.replace(/^\uFEFF/, '');

  // MODE --root: indeks subfolder -> {id, dir} lewat metadata.id
  const rootIndex = new Map<string, string>();
  if (rootDir) {
    if (!fs.existsSync(rootDir)) {
      console.error(`--root tidak ditemukan: ${rootDir}`);
      process.exit(1);
    }
    for (const name of fs.readdirSync(rootDir)) {
      const d = path.join(rootDir, name);
      try {
        if (!fs.statSync(d).isDirectory()) continue;
        const mf = path.join(d, 'metadata.json');
        if (!fs.existsSync(mf)) continue;
        const id = String(JSON.parse(stripBom(fs.readFileSync(mf, 'utf8'))).id ?? '');
        if (id) rootIndex.set(id, d);
      } catch { /* lewati folder bermasalah */ }
    }
  }

  const out: Video[] = [];
  for (const [id, sha] of latest) {
    if (reviews.length > 0 && !reviews.some(r => id.startsWith(r))) continue;
    if (shas.get(id)!.size > 1) {
      console.warn(`  ! ${id}: ada >1 versi SRT di runs.jsonl (${[...shas.get(id)!].join(', ')}); membandingkan dengan yang terakhir (${sha})`);
    }

    let metadata: any = null;
    let srt: string | null = null;

    if (rootDir) {
      const d = rootIndex.get(id);
      if (!d) {
        console.error(`  ! ${id}: tidak ada subfolder di --root dengan metadata.id=${id}`);
        process.exit(1);
      }
      metadata = JSON.parse(stripBom(fs.readFileSync(path.join(d, 'metadata.json'), 'utf8')));
      const srtFile = path.join(d, 'transcript.srt');
      if (!fs.existsSync(srtFile)) {
        console.error(`  ! ${id}: transcript.srt tidak ada di ${d}`);
        process.exit(1);
      }
      srt = stripBom(fs.readFileSync(srtFile, 'utf8'));
      const h = sha8(srt);
      if (h !== sha) {
        const msg = `${id}: hash transcript.srt di folder (${h}) BEDA dari srt_sha baseline (${sha}) -- SRT berubah sejak run baseline`;
        if (!allowSrtDiff) {
          console.error(`  ! ${msg}. Dihentikan (gunakan --allow-srt-diff hanya bila disengaja).`);
          process.exit(1);
        }
        console.warn(`  ! ${msg}. Dilanjutkan karena --allow-srt-diff.`);
      }
    } else {
      const srtPath = path.join(srtDir, `${sha}.srt`);
      if (!fs.existsSync(srtPath)) {
        console.error(`  ! ${id}: SRT tidak ada: ${srtPath}`);
        process.exit(1);
      }
      srt = stripBom(fs.readFileSync(srtPath, 'utf8'));
      if (metaDir) {
        for (const c of [path.join(metaDir, `${id}.json`), path.join(metaDir, id, 'metadata.json')]) {
          if (fs.existsSync(c)) { metadata = JSON.parse(stripBom(fs.readFileSync(c, 'utf8'))); break; }
        }
      }
      if (!metadata) {
        if (!allowMinimalMeta) {
          console.error(`  ! ${id}: metadata tidak ditemukan di ${metaDir} (<id>.json atau <id>/metadata.json)`);
          process.exit(1);
        }
        console.warn(`  ! ${id}: memakai metadata minimal {id}; konteks prompt BERBEDA dari baseline`);
        metadata = { id };
      }
    }

    if (String(metadata.id ?? '') !== id) {
      console.error(`  ! ${id}: metadata.id="${metadata.id}" tidak sama dengan review_id`);
      process.exit(1);
    }
    out.push({ id, metadata, srt: srt!, name: id });
  }
  return out;
}

function post(body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/evidence',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
      },
      res => {
        const parts: Buffer[] = [];
        res.on('data', c => parts.push(c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(parts).toString('utf8')) });
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function lastRunRecord(): any | null {
  const file = path.join(RUN_LOG_DIR, 'runs.jsonl');
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim());
  try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
}

async function main() {
  const videos = loadVideos();
  if (videos.length === 0) {
    console.error('Tidak ada video yang cocok di --reviews.');
    process.exit(1);
  }
  console.log(`Varian ${expect}: ${videos.length} video x ${repeat} run = ${videos.length * repeat} panggilan`);
  console.log(`Video: ${videos.map(v => v.id).join(', ')}\n`);

  for (let rep = 1; rep <= repeat; rep++) {
    for (const v of videos) {
      const t0 = Date.now();
      console.log(`[rep ${rep}/${repeat}] ${v.id} ...`);
      let res;
      try {
        res = await post({ metadata: v.metadata, srtContent: v.srt, reviewerName: 'Reviewer' });
      } catch (e) {
        console.error(`  GAGAL koneksi/parse: ${(e as Error).message}. Server berjalan di port ${port}?`);
        process.exit(1);
      }
      if (res.status !== 200 || !res.json?.success) {
        console.error(`  GAGAL HTTP ${res.status}: ${res.json?.error ?? 'tanpa pesan'}`);
        process.exit(1);
      }

      const rec = lastRunRecord();
      if (!rec || rec.review_id !== (v.metadata.id ?? null) ||
          rec.chunk_chars !== expChars || rec.chunk_overlap !== expOverlap) {
        console.error(
          `  BATAL: runs.jsonl terakhir = review=${rec?.review_id} chars=${rec?.chunk_chars} overlap=${rec?.chunk_overlap}, ` +
          `diharapkan ${v.metadata.id} ${expChars}/${expOverlap}. Server dijalankan dengan env yang salah?`
        );
        process.exit(1);
      }

      const s = res.json.stats ?? {};
      console.log(
        `  OK ${((Date.now() - t0) / 1000).toFixed(0)}s | chunk=${rec.chunks?.length} parsed=${s.parsedEvidenceCount} ` +
        `accepted=${s.validatorAcceptedCount} quar=${s.quarantineCount} dupRemoved=${s.duplicateRemovedCount} ` +
        `merged=${s.duplicateMergedCount} final=${s.finalCount} | ${rec.run_id}`
      );
    }
  }
  console.log('\nSelesai.');
}

main();