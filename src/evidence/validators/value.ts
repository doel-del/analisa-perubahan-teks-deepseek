// ============================================================
// VALUE VALIDATOR
// ============================================================

import type { ValidationResult } from '../types';

export const ValueValidator = {
  validate(
    value: string | number | null | undefined,
    unit: string | null | undefined,
    _attribute?: string | null,
    _attribute_value?: string | number | null
  ): ValidationResult {
    const valueStr = String(value ?? '').trim();
    const unitStr = String(unit ?? '').trim();

    // ------------------------------------------------------------
    // N9: Compound resolution value — "2340 x 1080" dengan unit
    // "p", "pixel", atau "px".
    // ------------------------------------------------------------
    if (
      /^\d+\s*[x×]\s*\d+$/i.test(valueStr) &&
      /^(p|pixels?|px)$/i.test(unitStr)
    ) {
      return { pass: true, status: 'PASS', rule: 'VALUE', severity: 'LOW' };
    }

    // ------------------------------------------------------------
    // N15: Compound video-mode value — "1080p 30 fps", "4K 30 fps",
    // "720p 240 fps" dengan unit "fps". Sama seperti N9 (resolusi
    // "2340 x 1080" + unit px), ini deskriptor MODE VIDEO majemuk
    // yang sah -- bukan error kompatibilitas value/unit.
    //
    // Dikonfirmasi dari data produksi 45hfkSE5DvA: pola ini menyumbang
    // 5 dari 21 quarantine (24%) dalam satu run (Test 5), SEMUANYA
    // dengan root cause identik. Ini bukan kasus tepi -- model secara
    // konsisten menaruh seluruh string mode ("1080p 60 fps") ke value
    // alih-alih angka fps saja, setiap kali mendeskripsikan resolusi
    // rekam video sebagai satu unit.
    //
    // CATATAN DESAIN: whitelist ini PASS, bukan reroute otomatis ke
    // attribute/attribute_value. Idealnya field ini memang milik
    // attribute_value (mode kategorik), bukan value/unit (skalar),
    // tapi ValueValidator tidak berwenang menulis ulang field lain.
    // Perbaikan struktural itu ranahnya prompt (instruksi eksplisit:
    // "mode video resolusi+fps → attribute_value, value/unit = null"),
    // bukan validator ini.
    if (
      /^(4k|8k|2k|\d{3,4}p)\s+\d+\s*fps$/i.test(valueStr) &&
      /^fps$/i.test(unitStr)
    ) {
      return { pass: true, status: 'PASS', rule: 'VALUE', severity: 'LOW' };
    }

    // ------------------------------------------------------------
    // N16: Durasi format jam:menit — "17:42", "25:02" dengan unit
    // "jam"/"hour"/"hours"/"h". Sama seperti N9/N15: ini deskriptor
    // durasi majemuk yang sah (jam+menit sebagai satu nilai), bukan
    // error kompatibilitas. atomicity.ts N2 SUDAH mengenali bentuk
    // "17 jam 42 menit" sebagai satu nilai komposit di level klaim --
    // ValueValidator belum mengenali representasi numeriknya.
    //
    // Dikonfirmasi dari data produksi 45hfkSE5DvA (Test 6): dua
    // kejadian dalam SATU run ("17:42" dari "17 jam 42 menit", "25:02"
    // dari "25 jam lebih 2 menit"), pola durasi baterai yang sama
    // persis dengan yang sudah diketahui menyebabkan quarantine
    // berulang di run-run sebelumnya (E178/E180 di audit sesi jauh
    // sebelumnya). \d{1,2} sengaja tidak dibatasi ke rentang 0-23,
    // karena ini DURASI KUMULATIF (bisa >24 jam), bukan jam dinding.
    // ------------------------------------------------------------
    if (
      /^\d{1,3}:\d{2}$/.test(valueStr) &&
      /^(jam|hour|hours|h)$/i.test(unitStr)
    ) {
      return { pass: true, status: 'PASS', rule: 'VALUE', severity: 'LOW' };
    }

    // ------------------------------------------------------------
    // N17: Range value langsung di field value — "40-55", "40–55",
    // "30–45" dengan unit fps/mp/hz/dst. Padanan N1 di atomicity.ts
    // (yang sudah lebih dulu mengenali range sebagai SATU nilai di
    // level klaim), tapi ValueValidator belum punya versinya.
    //
    // Dikonfirmasi dari data produksi 45hfkSE5DvA (Test10/Test11):
    // 5-6 kejadian per run (~25% dari total quarantine), SEMUA game
    // frame-rate range (Wuthering Waves, Genshin Impact). Karakter
    // dash bervariasi antar-run (ascii "-" vs en-dash "–") -- regex
    // menerima keduanya via [–-].
    //
    // CATATAN (audit ronde berikutnya): "gb"/"mb" SENGAJA TIDAK
    // dimasukkan ke whitelist unit di bawah. Beda dengan fps/hz/mp/
    // nits/watt/mah yang secara natural memang bisa berupa rentang
    // (frame rate naik-turun, refresh rate dinamis), kapasitas
    // storage/RAM HAMPIR TIDAK PERNAH benar-benar rentang. Value
    // seperti "8-256" + unit "gb" jauh lebih mungkin representasi
    // keliru dari DUA SPEK BERBEDA (RAM 8GB + storage 256GB) yang
    // seharusnya ditolak sama seperti varian slash-nya ("8/256" +
    // unit "gb" -- lihat blok compound value FAIL di bawah), bukan
    // rentang asli. Meloloskannya di sini akan membuka celah data
    // korup lolos tanpa terdeteksi sama sekali. Kalau ditemukan
    // genuine range storage di produksi, tangani lewat whitelist
    // literal terpisah, bukan dengan melebarkan pattern unit ini.
    // ------------------------------------------------------------
    //
    // PERLUASAN (replay 15 video): daftar unit putih (fps|mp|hz|nits|watt|mah)
    // melewatkan rentang berunit lain yang sama sahnya -- "40-50 cm" (jarak),
    // "30-35 %" (volume). Dibalik menjadi daftar HITAM: rentang diterima untuk
    // satuan apa pun KECUALI kapasitas penyimpanan (gb/mb/tb), alasannya sama
    // dengan catatan di atas. Selaras dengan RANGE_RE di atomicity.ts.
    // Desimal koma ("1,5-2") ikut diterima.
    if (
      /^\d+(?:[.,]\d+)?\s*[–-]\s*\d+(?:[.,]\d+)?$/.test(valueStr) &&
      unitStr !== '' &&
      !/^(gb|mb|tb)$/i.test(unitStr)
    ) {
      return { pass: true, status: 'PASS', rule: 'VALUE', severity: 'LOW' };
    }

    // ------------------------------------------------------------
    // N18: Durasi format "N jam M" (unit di luar: "menit"). Varian
    // KETIGA dari bug durasi majemuk (setelah N16 "17:42"+jam).
    // Dikonfirmasi run11 Q016: "1 jam 28" + unit "menit" dari klaim
    // "1 jam 28 menit". CATATAN: ini tambalan REAKTIF, bukan solusi
    // akar. Lihat komentar di atas N17 -- pola compound-descriptor
    // di value/unit terus bermutasi notasi (N9→N12→N15→N16→N17→N18).
    // Perbaikan struktural (redirect ke attribute_value, value/unit
    // null) di level prompt akan menghentikan whack-a-mole ini.
    // ------------------------------------------------------------
    if (
      /^\d{1,2}\s*jam\s*\d{1,2}$/i.test(valueStr) &&
      /^(menit|minute|minutes|m)$/i.test(unitStr)
    ) {
      return { pass: true, status: 'PASS', rule: 'VALUE', severity: 'LOW' };
    }


    // ------------------------------------------------------------
    // Rule 1: value non-numerik + unit terisi → SUSPECT HIGH
    // ------------------------------------------------------------
    if (unitStr && !isNumeric(valueStr) && !valueStr.includes('/')) {
      return {
        pass: false,
        status: 'SUSPECT',
        rule: 'VALUE',
        reason: `Value non-numerik "${valueStr}" tidak kompatibel dengan unit "${unitStr}"`,
        severity: 'HIGH'
      };
    }

    // ------------------------------------------------------------
    // Compound value: "8/256" (blok lama)
    // ------------------------------------------------------------
    if (valueStr.includes('/')) {
      const parts = valueStr.split('/');
      if (parts.length === 2) {
        const isNumericCompound =
          isNumeric(parts[0].trim()) && isNumeric(parts[1].trim());

        if (isNumericCompound) {
          const knownValidFractions = [
            { value: '1/30', units: ['detik', 's', 'second'] },
            { value: '1/60', units: ['detik', 's', 'second'] }
          ];

          const isKnownValid = knownValidFractions.some(f =>
            f.value === valueStr &&
            f.units.some(u => unitStr.toLowerCase() === u)
          );

          if (isKnownValid) {
            return { pass: true, status: 'PASS', rule: 'VALUE', severity: 'LOW' };
          }

          if (unitStr && unitStr.toLowerCase() === 'gb') {
            return {
              pass: false,
              status: 'FAIL',
              rule: 'VALUE',
              reason: `Compound value terdeteksi: ${valueStr} ${unitStr}`,
              severity: 'HIGH'
            };
          }

          return {
            pass: true,
            status: 'SUSPECT',
            rule: 'VALUE',
            reason: `Numeric ratio yang belum dikenal: ${valueStr}`,
            severity: 'MEDIUM'
          };
        }
      }
    }

    return { pass: true, status: 'PASS', rule: 'VALUE', severity: 'LOW' };
  }
};

// Desimal Indonesia memakai koma ("1,5 jam"); format titik juga diterima.
// Sebelumnya hanya titik, sehingga "1,5" + "jam" dikarantina sebagai non-numerik.
function isNumeric(str: string): boolean {
  return /^-?\d+([.,]\d+)?$/.test(str);
}
