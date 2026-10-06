// ============================================================
// ATOMICITY VALIDATOR — v2 (severity bertingkat)
// ============================================================
// Perubahan dari v1:
//   - Severity dibedakan berdasarkan BUKTI compound:
//     * SUSPECT HIGH  → compound genuine (multi-value beda unit, atau
//                        comma-list + angka/unit, atau " dan " + angka)
//     * SUSPECT MEDIUM → indikasi compound ringan (comma-list tanpa angka,
//                        " dan " tanpa angka)
//     * PASS          → komparatif tunggal ("lebih tebal dibanding A, B, C")
//                        atau alternatif penulisan ("1080p atau Full HD")
//   - Alasan: 5 false positive di production run karena ' dan ' saja
//     langsung di-quarantine.
// ============================================================

import type { ValidationResult } from '../types';

// Rentang non-dash ("30 hingga 45 fps", "40 sampai ke 50 cm", "3 hingga 4 juta").
// Rentang non-dash ("30 hingga 45 fps", "40 sampai ke 50 cm", "3 hingga 4 juta").
// Rentang gb/mb SENGAJA tidak dibuang (selaras value.ts N17): "8 hingga 256 GB"
// lebih mungkin dua spek berbeda daripada rentang sungguhan.
// Hardening: satuan boleh muncul setelah angka PERTAMA juga ("30 fps hingga 45 fps",
// "30 fps - 45 fps"); versi awal hanya mengenali satuan setelah angka kedua.
const RANGE_UNITS =
  'fps|mp|hz|nits|watt|mah|cm|mm|juta|ribu|derajat(?:\\s+celsius)?|jam|menit|detik|kali|tahun|%';
const RANGE_RE = new RegExp(
  `\\b\\d+(?:[.,]\\d+)?(?:\\s*(?:${RANGE_UNITS}))?\\s*(?:[–-]|hingga|sampai(?:\\s+ke)?|s\\/d)\\s*` +
  `\\d+(?:[.,]\\d+)?\\b(?!\\s*(?:gb|mb)\\b)(?:\\s*(?:${RANGE_UNITS}))?`,
  'gi'
);

export const AtomicityValidator = {
  validate(claim: string | undefined): ValidationResult {
    const normalizedClaim = (claim || '').toLowerCase();

    // ------------------------------------------------------------
    // 1. WHITELIST — klaim atomic yang sah memakai konjungsi
    // ------------------------------------------------------------

    // Komparatif tunggal: "X lebih [sifat] dibanding A, B, dan C"
    // atau "X lebih [sifat] dari A dan B"
    const comparativePattern =
      /\blebih\s+\w+\s+(dibanding|dari|daripada)\b/i;

    // Alternatif penulisan: "1080p atau Full HD", "60Hz atau 120Hz"
    // Hanya dianggap alternatif bila tidak ada 'dan' (yang menandakan
    // listing). Pemicu ' atau ' tanpa ' dan ' biasanya cuma sinonim
    // atau nilai yang sama dengan penulisan berbeda.
    const hasAlternativeAtau = /\s+atau\s+/i.test(normalizedClaim);
    const hasConjunctionDan = /\s+dan\s+/i.test(normalizedClaim);

    // ------------------------------------------------------------
    // 2b. WHITELIST PATTERN — klaim atomic yang sering salah ditandai
    //     compound. Dikonfirmasi dari audit 4-run transkrip lab-style.
    // ------------------------------------------------------------

    // N1: Range value — "30-45 fps", "30–40 fps", "28–35 fps"
    // Range adalah SATU nilai (interval), bukan dua nilai.
    const rangeValuePattern =
      /\b\d+\s*[–-]\s*\d+\s*(fps|mp|hz|nits|watt|mah|gb|mb)\b/i;
    if (rangeValuePattern.test(normalizedClaim)) {
      return {
        pass: true,
        status: 'PASS',
        rule: 'ATOMICITY',
        severity: 'LOW'
      };
    }

    // N2: Durasi format jam-menit — "17 jam 42 menit", "1 jam 28 menit",
    // "25 jam lebih 2 menit". Durasi panjang adalah SATU nilai komposit.
    const durationPattern =
      /\b\d+\s*jam(\s+lebih)?\s+\d+\s*menit\b/i;
    if (durationPattern.test(normalizedClaim)) {
      return {
        pass: true,
        status: 'PASS',
        rule: 'ATOMICITY',
        severity: 'LOW'
      };
    }

    // N3: Setup protocol pengujian — "60 fps selama 30 menit",
    // "60 fps dan dimainkan selama 30 menit". Spec + durasi adalah
    // SATU protokol pengujian, bukan dua properti.
    const setupProtocolPattern =
      /\b\d+\s*fps\b[^.!?]*?\b(selama|durasi|dimainkan)\b[^.!?]*?\b\d+\s*(menit|jam)\b/i;
    if (setupProtocolPattern.test(normalizedClaim)) {
      return {
        pass: true,
        status: 'PASS',
        rule: 'ATOMICITY',
        severity: 'LOW'
      };
    }

    // N4: Shutter speed Pro mode — "1/30 detik untuk video 30 fps",
    // "1/60 detik untuk video 60 fps". Shutter speed + fps adalah
    // SATU spesifikasi mode Pro.
    const shutterSpeedPattern =
      /\b1\/\d+\s*detik\b[^.!?]*?\b(video|fps)\b/i;
    if (shutterSpeedPattern.test(normalizedClaim)) {
      return {
        pass: true,
        status: 'PASS',
        rule: 'ATOMICITY',
        severity: 'LOW'
      };
    }

    // N5: Battery test measurement.
    // Order-independent: cek 3 sinyal secara independen.
    //   - ada persentase   : "\d+%"
    //   - ada mode/rate    : "mode 120Hz", "refresh rate", "120Hz", "60Hz"
    //   - ada durasi uji   : "selama 30 menit", "setengah jam", "25 jam"
    // Mencakup klaim dengan urutan apapun:
    //   - "berkurang 4% baik di mode 120Hz maupun 60Hz"
    //   - "Di mode 120Hz baterai berkurang 5% selama setengah jam"
    //   - "TikTok selama 30 menit pada mode 120Hz mengurangi baterai 5%"
    const hasPercent = /\b\d+\s*%/.test(normalizedClaim);
    const hasModeOrRefresh =
      /\b(mode|refresh rate)\b/.test(normalizedClaim) ||
      /\b(60|90|120)\s*hz\b/.test(normalizedClaim);
    const hasTestDuration =
      /\b\d+\s*(menit|jam)\b/.test(normalizedClaim) ||
      /\bsetengah jam\b/.test(normalizedClaim) ||
      /\bselama\b/.test(normalizedClaim);

    if (hasPercent && hasModeOrRefresh && hasTestDuration) {
      return {
        pass: true,
        status: 'PASS',
        rule: 'ATOMICITY',
        severity: 'LOW'
      };
    }

    // N12: Spec teknis (resolusi + fps) + evaluasi kualitatif yang
    // dipisah "dan".
    // Kasus: "di 4K 30 fps, videonya masih terlihat stabil dan minim jitter"
    //
    // PERBAIKAN: regex lama hanya mengenali "1080p" (\d{3,4}p), TIDAK
    // mengenali "4K"/"8K"/"2K". Dikonfirmasi dari 7 run produksi
    // berturut-turut (Test1-Test8): klaim "Video 4K 30 fps ... stabil
    // dan minim jitter" SELALU jatuh ke aturan umum "dan + 2 angka ->
    // HIGH" karena "4K" tidak match \d{3,4}p, padahal N15 di value.ts
    // sudah lebih dulu benar menyertakan 4k|8k|2k untuk pola yang
    // sama persis. Ini juga kontradiksi langsung dengan prompt sendiri
    // (baris 76-78 prompts.ts), yang memberi CONTOH EKSPLISIT bahwa
    // "videonya stabil dan minim jitter" adalah SATU evidence yang
    // benar -- validator menghukum pola yang justru diajarkan sebagai
    // benar oleh prompt.
    const specPlusEvaluationPattern =
      // /\b\d{3,4}p\b[^.!?]*?\b\d+\s*fps\b[^.!?]*?\b(stabil|minim|terjaga|konsisten|mulus|halus|jernih|tajam)\b/i;
      /\b(?:4k|8k|2k|\d{3,4}p)\b[^.!?]*?\b\d+\s*fps\b[^.!?]*?\b(stabil|minim|terjaga|konsisten|mulus|halus|jernih|tajam)\b/i;
    if (specPlusEvaluationPattern.test(normalizedClaim)) {
      return {
        pass: true,
        status: 'PASS',
        rule: 'ATOMICITY',
        severity: 'LOW'
      };
    }

    // N13: Kapasitas baterai + durasi daya tahan dalam satu klaim.
    // Kasus: "Baterai 5000 mAh tahannya bisa sampai 25 jam"
    const capacityPlusDurationPattern =
      /\b\d{4}\s*mah\b[^.!?]*?\b\d+\s*(jam|menit)\b/i;
    if (capacityPlusDurationPattern.test(normalizedClaim)) {
      return {
        pass: true,
        status: 'PASS',
        rule: 'ATOMICITY',
        severity: 'LOW'
      };
    }

    // N14: Pilihan kategorik, bukan compound nilai.
    // Kasus: "kita masih harus pilih 120 atau 60"
    //         "opsi antara 60Hz atau 120Hz"
    const categoricalChoicePattern =
      /\b(pilih|pilihan|opsi|memilih|pilihlah)\b[^.!?]*?\b\d+\s*(atau|\/)\s*\d+\b/i;
    if (categoricalChoicePattern.test(normalizedClaim)) {
      return {
        pass: true,
        status: 'PASS',
        rule: 'ATOMICITY',
        severity: 'LOW'
      };
    }

    // N3b: "setting/mode X dan frame rate <apa pun> ..." = kondisi uji, bukan nilai kedua.
    // PASS hanya bila, setelah fragmen konfigurasi dibuang, tidak ada " dan " maupun
    // comma-list tersisa (supaya compound lain di klaim yang sama, mis. "... dan suhu
    // 38 derajat" atau ", baterai 5000 mAh, layar 6,7 inci", tetap tertangkap).
    // Hardening: bagian tengah fragmen TIDAK boleh memuat " dan " lain; versi awal
    // (lazy [^.!?]*?) bisa menelan "dan suhu 38 derajat" ke dalam fragmen konfigurasi.
    const configThenMeasurePattern =
      /\b(?:setting|settingan|pengaturan|mode|preset)\b(?:(?!\bdan\b)[^.!?])*?\bdan\b\s+(?:frame rate|fps|refresh rate)\s+\w+\b/i;
    const claimMinusConfig = normalizedClaim.replace(configThenMeasurePattern, ' ');
    if (
      configThenMeasurePattern.test(normalizedClaim) &&
      !/\s+dan\s+/i.test(claimMinusConfig) &&
      !/,[^,]{1,80},/.test(claimMinusConfig)
    ) {
      return { pass: true, status: 'PASS', rule: 'ATOMICITY', severity: 'LOW' };
    }

    // Rentang dihitung SATU nilai: buang sebelum mendeteksi multi-value / hitung angka.
    const claimNoRange = normalizedClaim.replace(RANGE_RE, ' rentang ');
    const rangeCount = (normalizedClaim.match(RANGE_RE) ?? []).length;

    // ------------------------------------------------------------
    // 2. BUKTI COMPOUND KUAT
    // ------------------------------------------------------------

    // Multi-value dengan unit (bisa unit sama atau beda):
    // "8 GB dan 256 GB", "1 meter selama 30 menit"
    const multiValuePattern =
      /\b\d+(?:[.,]\d+)?\s*(meter|menit|jam|detik|mm|nm|gb|mb|kali|tahun|fps|mp|watt|mah|hz)\b[^.!?]*?\b\d+(?:[.,]\d+)?\s*(meter|menit|jam|detik|mm|nm|gb|mb|kali|tahun|fps|mp|watt|mah|hz)\b/i;

    // Comma-list 3+ item (indikasi: ada koma DAN ada 'dan')
    // Contoh: "dual mic, speaker, dan USB Type-C"
    const commaList3PlusPattern = /,[^,]{1,80},\s*(dan|serta)\b/i;

    // Comma-list 3+ item sederhana (>= 2 koma)
    // Contoh: "X, Y, Z"
    const commaListSimplePattern = /,[^,]{1,80},/;

    const hasMultiValue = multiValuePattern.test(claimNoRange);
    const hasCommaList3Plus = commaList3PlusPattern.test(claimNoRange);
    const hasCommaListSimple = commaListSimplePattern.test(claimNoRange);

    // ------------------------------------------------------------
    // 3. WHITELIST RETURN — klaim atomic yang sah
    // ------------------------------------------------------------

    // Komparatif tunggal, asal tidak ada multi-value tersembunyi
    if (comparativePattern.test(normalizedClaim) && !hasMultiValue) {
      return {
        pass: true,
        status: 'PASS',
        rule: 'ATOMICITY',
        severity: 'LOW'
      };
    }

    // Alternatif " atau " tanpa ' dan ' dan tanpa multi-value
    if (
      hasAlternativeAtau &&
      !hasConjunctionDan &&
      !hasMultiValue &&
      !hasCommaListSimple
    ) {
      return {
        pass: true,
        status: 'PASS',
        rule: 'ATOMICITY',
        severity: 'LOW'
      };
    }

    // BARU: multi-value + " atau " tanpa " dan " → kemungkinan alternatif penulisan
    if (hasMultiValue && hasAlternativeAtau && !hasConjunctionDan) {
      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'ATOMICITY',
        reason: 'Multi-value dihubungkan dengan "atau" — kemungkinan alternatif penulisan nilai yang sama',
        severity: 'MEDIUM'
      };
    }

    // ------------------------------------------------------------
    // 4. COMPOUND KUAT → SUSPECT HIGH (quarantine)
    // ------------------------------------------------------------

    // Multi-value dengan unit → compound genuine
    if (hasMultiValue) {
      return {
        pass: false,
        status: 'SUSPECT',
        rule: 'ATOMICITY',
        reason:
          'Multi-value dengan satuan terdeteksi — dua nilai berbeda dalam satu klaim',
        severity: 'HIGH'
      };
    }

    // Comma-list 3+ item DAN ada angka/unit → compound genuine
    const hasNumberOrUnit =
      /\b\d+(?:[.,]\d+)?\s*(meter|menit|jam|detik|mm|nm|gb|mb|kali|tahun|fps|mp|watt|mah|hz|ribu|juta|%)\b/i.test(
        claimNoRange
      ) || /\b\d+\b/.test(claimNoRange) || rangeCount > 0;

    if (hasCommaList3Plus && hasNumberOrUnit) {
      return {
        pass: false,
        status: 'SUSPECT',
        rule: 'ATOMICITY',
        reason:
          'Comma-list 3+ item dengan nilai numerik — kemungkinan compound spesifikasi',
        severity: 'HIGH'
      };
    }

    // ' dan ' + minimal 2 nilai numerik dengan satuan → compound kuat
    //
    // PERTAHANAN UMUM: sebelum menghitung "berapa nilai numerik genuine
    // berbeda", buang dulu angka yang sudah menyatu dalam SATU deskriptor
    // resolusi+fps yang dikenal (mis. "4K 30 fps", "1080p 60 fps"). Tanpa
    // ini, setiap kata sifat baru yang belum sempat masuk whitelist N12
    // (mis. sinonim "renyah", "mulus banget", dll di masa depan) akan
    // jatuh ke bug yang sama seperti N12 lama: dua angka dari SATU
    // spesifikasi dihitung sebagai "dua nilai berbeda". N12 di atas tetap
    // dipertahankan sebagai jalur PASS bersih untuk pola yang sudah
    // teruji -- ini cuma jaring pengaman kedua untuk pola serupa yang
    // belum masuk whitelist eksplisit, supaya hasilnya jatuh ke MEDIUM
    // ("perlu review manual", tetap diterima) alih-alih salah HIGH
    // (quarantine).
    const compoundDescriptorPattern = /\b(?:4k|8k|2k|\d{3,4}p)\s+\d+\s*fps\b/gi;
    const claimWithoutCompoundDescriptors = claimNoRange.replace(
      compoundDescriptorPattern,
      ''
    );

    if (hasConjunctionDan && hasNumberOrUnit) {
      const numberMatches =
        // normalizedClaim.match(/\b\d+(?:[.,]\d+)?/g) || [];
        claimWithoutCompoundDescriptors.match(/\b\d+(?:[.,]\d+)?/g) || [];
      if (numberMatches.length + rangeCount >= 2) {
        return {
          pass: false,
          status: 'SUSPECT',
          rule: 'ATOMICITY',
          reason:
            'Dua nilai numerik atau lebih dihubungkan dengan "dan" — compound spesifikasi',
          severity: 'HIGH'
        };
      }
    }

    // ------------------------------------------------------------
    // 5. COMPOUND RINGAN → SUSPECT MEDIUM (tidak quarantine)
    // ------------------------------------------------------------

    if (hasCommaList3Plus || hasCommaListSimple) {
      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'ATOMICITY',
        reason: 'Indikasi comma-list, perlu review manual',
        severity: 'MEDIUM'
      };
    }

    if (hasConjunctionDan) {
      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'ATOMICITY',
        reason: 'Indikasi compound ringan, perlu review manual',
        severity: 'MEDIUM'
      };
    }

    return {
      pass: true,
      status: 'PASS',
      rule: 'ATOMICITY',
      severity: 'LOW'
    };
  }
};
