// src/evidence/harness/extraction-harness.ts
// (update untuk membaca manifest.json)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { ANALYSIS_PROMPT_EVIDENCE } from '../../../prompts';

dotenv.config();

interface HarnessCase {
  case_id: string;
  failure_type: string;
  prompt_version: string;
  model: string;
  temperature: number;
  fixture: string;
  expected_invariant: Record<string, any>;
}

interface Manifest {
  cases: HarnessCase[];
}

interface HarnessArtifact {
  case_id: string;
  failure_type: string;
  fixture: string;
  model: string;
  prompt_version: string;
  temperature: number;
  timestamp: string;
  chunkText: string;
  rawOutput: string;
  parsedEvidence: any[];
  errors: string[];
}

const MODEL = 'gemini-3.5-flash-lite';
const PROMPT_VERSION = 'v4.3';
const TEMPERATURE = 0.1;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const OUTPUT_DIR = path.join(__dirname, 'output');
const MANIFEST_PATH = path.join(__dirname, 'corpus', 'manifest.json');

async function callLLM(
  chunkText: string,
  promptInstruction: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY tidak ditemukan.');
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [
      {
        parts: [
          {
            text: `${promptInstruction}\n\n--- TEKS UNTUK DIKOREKSI ---\n${chunkText}`
          }
        ]
      }
    ],
    system_instruction: {
      parts: [
        {
          text: 'Anda adalah ekstraktor evidence produk. Hanya output JSON yang valid.'
        }
      ]
    },
    generationConfig: {
      temperature: TEMPERATURE
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Gemini API Error (Status ${response.status}): ${errorText.substring(0, 200)}`
    );
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error('Gemini mengembalikan respons kosong.');
  }

  return text.trim();
}

function parseJSON(rawOutput: string): any[] {
  const raw = rawOutput.replace(/^\uFEFF/, '').trim();

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.evidence)) return parsed.evidence;
  } catch (_) {}

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.evidence)) return parsed.evidence;
    } catch (_) {}
  }

  return [];
}

async function runCase(caseDef: HarnessCase): Promise<HarnessArtifact> {
  const fixturePath = path.join(FIXTURE_DIR, caseDef.fixture);
  const chunkText = fs.readFileSync(fixturePath, 'utf8');

  const promptInstruction = ANALYSIS_PROMPT_EVIDENCE
    .replace(/\{batch\}/g, '1')
    .replace(/\{total_batches\}/g, '1');

  const rawOutput = await callLLM(chunkText, promptInstruction);
  const parsedEvidence = parseJSON(rawOutput);

  return {
    case_id: caseDef.case_id,
    failure_type: caseDef.failure_type,
    fixture: caseDef.fixture,
    model: MODEL,
    prompt_version: PROMPT_VERSION,
    temperature: TEMPERATURE,
    timestamp: new Date().toISOString(),
    chunkText,
    rawOutput,
    parsedEvidence,
    errors: []
  };
}

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const manifestRaw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const manifest: Manifest = JSON.parse(manifestRaw);

  console.log(`\n📦 Total cases dari manifest: ${manifest.cases.length}\n`);

  for (let i = 0; i < manifest.cases.length; i++) {
    const caseDef = manifest.cases[i];

    console.log(`\n📦 Menjalankan case: ${caseDef.case_id}`);
    console.log(`   Failure type: ${caseDef.failure_type}`);
    console.log(`   Fixture: ${caseDef.fixture}\n`);

    // Jalankan 3x replay
    for (let replay = 1; replay <= 3; replay++) {
      console.log(`   Replay #${replay}`);

      try {
        const result = await runCase(caseDef);

        console.log(`   ✅ Raw output diterima.`);
        console.log(`   Parsed evidence: ${result.parsedEvidence.length}`);

        const outputPath = path.join(
          OUTPUT_DIR,
          `${caseDef.case_id}_replay_${replay}.json`
        );

        fs.writeFileSync(
          outputPath,
          JSON.stringify(result, null, 2),
          'utf8'
        );

        console.log(`   💾 Artifact disimpan: ${outputPath}\n`);
      } catch (err: any) {
        console.error(`   ❌ Replay #${replay} gagal:`, err?.message || err);
      }
    }
  }

  console.log('============================================');
  console.log('📊 E.2 Replay selesai');
  console.log('============================================');
}

main();