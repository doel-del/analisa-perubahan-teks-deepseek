// ============================================================
// LLM PROVIDER — Gemini-only with key rotation
// ============================================================
// Refactored: production promotion A.
//
// Keputusan metodologis:
//   - Gemini-only, tidak ada fallback ke LLM lain.
//   - Beda model = confound. Production harus mirror apparatus
//     Option X (Gemini-only + rotasi key).
//   - Rotasi API key pada quota/429. Non-quota error → fail-fast.
//
// Rotasi diadopsi dari:
//   src/evidence/harness/experiments/lib/provider.ts
//
// Keamanan:
//   - Nilai API key TIDAK PERNAH masuk log.
//   - Hanya key_index (integer) yang di-log.
//   - API key dikirim lewat header `x-goog-api-key`, bukan query string.
//
// Patch (audit):
//   [1] Perbaikan TS2339 pada `retried.error` (narrowing union gagal
//       karena strictNullChecks nonaktif) → pakai operator `in`.
//   [2] Baca `finishReason` dan gabungkan semua `parts` teks.
//   [3] Response kosong yang kemungkinan sementara ditandai transient.
//   [4] API key pindah dari URL ke header.
//   [5] Retry hanya untuk error transient (5xx, network, response kosong).
//
// TIDAK diubah: label input `--- TEKS UNTUK DIKOREKSI ---`
// (mengubahnya = mengubah input model; lakukan sebagai eksperimen terpisah).
// ============================================================

export type LLMProvider = 'gemini';

export interface LLMResponse {
  success: boolean;
  content: string;
  provider: LLMProvider | 'unknown';
  model: string;
  error?: string;
}

// ------------------------------------------------------------
// Config
// ------------------------------------------------------------
const MODEL = 'gemini-3.5-flash-lite';
const TEMPERATURE = 0.0;
const TIMEOUT_MS = 120_000;

// ------------------------------------------------------------
// Key discovery
// ------------------------------------------------------------
// Prioritas:
//   1. GEMINI_API_KEY_1, _2, ..., _N
//   2. GEMINI_API_KEY (legacy, hanya jika tidak ada numbered)
// ------------------------------------------------------------
interface DiscoveredKey {
  index: number;
  value: string;
}

function discoverKeys(): DiscoveredKey[] {
  const numbered: DiscoveredKey[] = [];
  for (let i = 1; i <= 20; i++) {
    const v = process.env[`GEMINI_API_KEY_${i}`];
    if (v && v.trim()) numbered.push({ index: i, value: v.trim() });
  }
  if (numbered.length > 0) return numbered;

  const legacy = process.env.GEMINI_API_KEY;
  if (legacy && legacy.trim()) return [{ index: 0, value: legacy.trim() }];

  return [];
}

// ------------------------------------------------------------
// Quota detection
// ------------------------------------------------------------
function isQuotaError(status: number, body: string): boolean {
  if (status === 429) return true;
  const lower = body.toLowerCase();
  return (
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('rate_limit')
  );
}

// ------------------------------------------------------------
// Transient detection
// ------------------------------------------------------------
// Transient = layak dicoba ulang pada key yang sama:
//   - HTTP 5xx
//   - Network error / timeout (diberi prefix NETWORK_ERROR)
//   - Error yang ditandai `transient: true` (mis. response kosong
//     tanpa alasan jelas)
// Error 4xx (selain quota) BUKAN transient.
// ------------------------------------------------------------
function isTransientError(err: any): boolean {
  const status: number = err?.httpStatus ?? 0;
  return Boolean(
    (status >= 500 && status < 600) ||
    err?.message?.startsWith('NETWORK_ERROR') ||
    err?.transient === true
  );
}

// ------------------------------------------------------------
// Single-key Gemini call (internal)
// ------------------------------------------------------------
async function callGeminiWithKey(
  text: string,
  promptInstruction: string,
  systemInstruction: string,
  apiKey: string
): Promise<string> {
  // API key TIDAK ditaruh di URL; dikirim lewat header x-goog-api-key.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  const payload = {
    contents: [{
      parts: [{
        text: `${promptInstruction}\n\n--- TEKS UNTUK DIKOREKSI ---\n${text}`
      }]
    }],
    system_instruction: { parts: [{ text: systemInstruction }] },
    generationConfig: { temperature: TEMPERATURE }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (err: any) {
    clearTimeout(timeout);
    throw new Error(`NETWORK_ERROR: ${err.message}`);
  }
  clearTimeout(timeout);

  if (!response.ok) {
    const bodyText = await response.text();
    const err: any = new Error(`Gemini API Error (status ${response.status})`);
    err.httpStatus = response.status;
    err.bodySnippet = bodyText.substring(0, 300);
    throw err;
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  const finishReason: string | undefined = candidate?.finishReason;

  // Gabungkan SEMUA part teks (bukan hanya parts[0]); abaikan part "thought".
  const combinedText: string = (candidate?.content?.parts ?? [])
    .filter((p: any) => typeof p?.text === 'string' && !p.thought)
    .map((p: any) => p.text)
    .join('');

  if (!combinedText.trim()) {
    const emptyErr: any = new Error(
      `Gemini mengembalikan response kosong (finishReason=${finishReason ?? 'tidak ada'}).`
    );
    // Kosong tanpa alasan jelas (atau STOP) kemungkinan glitch sementara → boleh retry.
    // Kosong karena SAFETY / MAX_TOKENS dsb. → mengulang percuma.
    emptyErr.transient = !finishReason || finishReason === 'STOP';
    throw emptyErr;
  }

  if (finishReason && finishReason !== 'STOP') {
    console.warn(
      `⚠️ Gemini finishReason=${finishReason} — output mungkin terpotong atau terfilter.`
    );
  }

  return combinedText.trim();
}

// ------------------------------------------------------------
// Retry with exponential backoff
// ------------------------------------------------------------
// Dipakai untuk error transient (5xx, network, response kosong).
// Bukan untuk error client (4xx) atau quota (429 — itu dirotasi key).
// `shouldRetry` menentukan apakah suatu error layak diulang; jika
// false, loop berhenti segera dan mengembalikan kegagalan.
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  initialDelayMs: number,
  shouldRetry: (err: any) => boolean = () => true
): Promise<{ success: true; value: T } | { success: false; error: string }> {
  let delay = initialDelayMs;
  let lastError = '';

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const value = await fn();
      return { success: true, value };
    } catch (err: any) {
      lastError = err.message ?? String(err);
      if (!shouldRetry(err)) break;
      if (i < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
      }
    }
  }

  return { success: false, error: lastError };
}

// ------------------------------------------------------------
// Public API: Gemini with key rotation
// ------------------------------------------------------------
export async function callGemini(
  text: string,
  promptInstruction: string,
  systemInstruction: string
): Promise<LLMResponse> {
  const keys = discoverKeys();

  if (keys.length === 0) {
    return {
      success: false,
      content: '',
      provider: 'gemini',
      model: MODEL,
      error: 'NO_GEMINI_KEYS_DISCOVERED'
    };
  }

  let lastError = '';

  for (const { index, value } of keys) {
    try {
      const content = await callGeminiWithKey(
        text, promptInstruction, systemInstruction, value
      );
      console.log(`✅ Gemini key #${index} success`);
      return {
        success: true,
        content,
        provider: 'gemini',
        model: MODEL
      };
    } catch (err: any) {
      const status = err.httpStatus ?? 0;
      const body = err.bodySnippet ?? '';

      // 1. Quota → rotate
      if (isQuotaError(status, body)) {
        console.warn(`⚠️ Gemini key #${index} quota exceeded, rotating...`);
        lastError = `Key #${index} quota exceeded`;
        continue;
      }

      // 2. 5xx, network error, atau response kosong sementara → retry key yang sama, backoff
      if (isTransientError(err)) {
        console.warn(
          `⚠️ Gemini key #${index} transient error (status ${status}: ${err.message}), retrying with backoff...`
        );
        const retried = await retryWithBackoff(
          () => callGeminiWithKey(text, promptInstruction, systemInstruction, value),
          3,     // 3 percobaan
          2000,  // delay awal 2 detik, lalu 4 detik
          isTransientError
        );

        if (retried.success) {
          console.log(`✅ Gemini key #${index} success (after retry)`);
          return {
            success: true,
            content: retried.value,
            provider: 'gemini',
            model: MODEL
          };
        }
        // `in` dipakai karena strictNullChecks nonaktif: narrowing union
        // lewat `success` tidak bekerja setelah `if (...) return`.
        lastError =
          `Key #${index} transient error after retries: ` +
          ('error' in retried ? retried.error : 'unknown');
        console.warn(`⚠️ Gemini key #${index} exhausted after retries, trying next key...`);
        continue;  // coba key berikutnya (in case key lain di project berbeda)
      }

      // 3. Client error → fail-fast
      console.error(`❌ Gemini key #${index} error: ${err.message}`);
      return {
        success: false,
        content: '',
        provider: 'gemini',
        model: MODEL,
        error: err.message
      };
    }
  }

  return {
    success: false,
    content: '',
    provider: 'gemini',
    model: MODEL,
    error: `ALL_KEYS_EXHAUSTED: ${lastError}`
  };
}

// ------------------------------------------------------------
// Backward compatibility
// ------------------------------------------------------------
// Dipakai oleh /api/correct-text di server.ts.
// Hanya mendukung gemini.
// ------------------------------------------------------------
export async function callLLMAPI(
  text: string,
  promptInstruction: string,
  systemInstruction: string,
  provider: LLMProvider = 'gemini'
): Promise<LLMResponse> {
  if (provider !== 'gemini') {
    return {
      success: false,
      content: '',
      provider,
      model: '',
      error: `Only 'gemini' supported, got: ${provider}`
    };
  }
  return callGemini(text, promptInstruction, systemInstruction);
}

// ------------------------------------------------------------
// Backward compatibility
// ------------------------------------------------------------
// Dipakai oleh generateSummary + extractEvidence di server.ts.
// Parameter primaryProvider dan fallbackProviders diabaikan —
// hanya untuk menjaga signature lama.
// ------------------------------------------------------------
export async function callLLMWithFallback(
  text: string,
  promptInstruction: string,
  systemInstruction: string,
  _primaryProvider: LLMProvider = 'gemini',
  _fallbackProviders: LLMProvider[] = []
): Promise<LLMResponse> {
  return callGemini(text, promptInstruction, systemInstruction);
}

// ------------------------------------------------------------
// Introspection
// ------------------------------------------------------------
export function getActiveProvider(): LLMProvider {
  return 'gemini';
}

export function getConfiguredKeyCount(): number {
  return discoverKeys().length;
}
