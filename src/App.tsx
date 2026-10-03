/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import { Header } from './components/Header';
import { TextInputs } from './components/TextInputs';
import { DiffToolbar } from './components/DiffToolbar';
import { ChangeSummaryCards } from './components/ChangeSummaryCards';
import { ColoredDiffViewer } from './components/ColoredDiffViewer';
import { ChangeList } from './components/ChangeList';
import { INDONESIAN_SAMPLES } from './data/sampleTexts';
import {
  calculateDiffParts,
  generateChangeItems,
  calculateDiffSummary
} from './utils/diffHelper';
import {
  DiffGranularity,
  DiffViewMode,
  TextChangeItem
} from './types';

export default function App() {
  // --- STATE UNTUK TAB CLEANING (KODE ASLI) ---
  const defaultSample = INDONESIAN_SAMPLES[0];

  const savedOriginal = localStorage.getItem('app_original_text');
  const savedModified = localStorage.getItem('app_modified_text');

  const [originalText, setOriginalText] = useState<string>(
    savedOriginal || defaultSample.original
  );
  const [modifiedText, setModifiedText] = useState<string>(
    savedModified || defaultSample.modified
  );

  const [granularity, setGranularity] = useState<DiffGranularity>('words');
  const [viewMode, setViewMode] = useState<DiffViewMode>('unified');
  const [selectedChangeItem, setSelectedChangeItem] = useState<
    TextChangeItem | undefined
  >(undefined);

  useEffect(() => {
    localStorage.setItem('app_original_text', originalText);
  }, [originalText]);

  useEffect(() => {
    localStorage.setItem('app_modified_text', modifiedText);
  }, [modifiedText]);

  const diffParts = useMemo(() => {
    return calculateDiffParts(originalText, modifiedText, granularity);
  }, [originalText, modifiedText, granularity]);

  const { changeItems, annotatedParts } = useMemo(() => {
    return generateChangeItems(diffParts);
  }, [diffParts]);

  const summary = useMemo(() => {
    return calculateDiffSummary(originalText, modifiedText, annotatedParts);
  }, [originalText, modifiedText, annotatedParts]);

  // --- STATE UNTUK TAB ANALISIS & EVIDENCE ---
  const [activeTab, setActiveTab] = useState<'cleaning' | 'analysis'>('cleaning');

  // State baru untuk 2 file
  const [srtContent, setSrtContent] = useState<string>('');
  const [metadata, setMetadata] = useState<Record<string, any>>({});

  const [reviewSummary, setReviewSummary] = useState<string>('');
  const [evidenceList, setEvidenceList] = useState<any[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // State Quarantine
  const [quarantineList, setQuarantineList] = useState<any[]>([]);
  const [stats, setStats] = useState<{
    parsedEvidenceCount: number;
    structurallyInvalidCount: number;
    validatorAcceptedCount: number;
    quarantineCount: number;
    duplicateRemovedCount: number;
    duplicateMergedCount: number;
    finalCount: number;
    eligibleMultiCount?: number;
    resolvedMultiCount?: number;
    quarantineMultiCount?: number;
    multiResolutionRate?: number | null;
    multiQuarantineRate?: number | null;
    promptVersion?: 'A';
  } | null>(null);

  // State Duplicate Removed
  const [duplicateRemovedDetails, setDuplicateRemovedDetails] = useState<any[]>([]);

  // --- STATE MODE ANALISIS ---
  const [analysisMode, setAnalysisMode] = useState<'full' | 'summary' | 'evidence'>('full');

  // --- HANDLERS UNTUK CLEANING ---
  const handleReset = () => {
    setOriginalText('');
    setModifiedText('');
    setSelectedChangeItem(undefined);
    localStorage.removeItem('app_original_text');
    localStorage.removeItem('app_modified_text');
  };

  const handleSwapText = () => {
    setOriginalText(modifiedText);
    setModifiedText(originalText);
    setSelectedChangeItem(undefined);
  };

  const handleOriginalChange = (val: string) => {
    setOriginalText(val);
  };

  const handleModifiedChange = (val: string) => {
    setModifiedText(val);
  };

  // --- HANDLER UNTUK UPLOAD FILE DI ANALISIS ---
  const handleFileUpload = (file: File, isMetadata: boolean) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (isMetadata) {
        try {
          const parsed = JSON.parse(content);
          setMetadata(parsed);
          setAnalysisError(null);
        } catch (err) {
          setAnalysisError('Format metadata.json tidak valid. Pastikan file berupa JSON yang benar.');
        }
      } else {
        setSrtContent(content);
        setAnalysisError(null);
      }
    };
    reader.readAsText(file);
  };

  // --- HANDLER UNTUK ANALISIS (DENGAN MODE) ---
  const handleAnalyze = async () => {
    if (!srtContent.trim()) {
      setAnalysisError('Silakan unggah / tempel konten transcript.srt terlebih dahulu.');
      return;
    }

    setIsAnalyzing(true);
    setAnalysisError(null);
    setReviewSummary('');
    setEvidenceList([]);
    setQuarantineList([]);
    setStats(null);
    setDuplicateRemovedDetails([]);

    // Pilih endpoint berdasarkan mode
    let endpoint = '/api/analyze-review';
    if (analysisMode === 'summary') endpoint = '/api/summary';
    if (analysisMode === 'evidence') endpoint = '/api/evidence';

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metadata,
          srtContent,
          reviewerName: 'Reviewer'
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Gagal memproses analisis.');
      }

      if (analysisMode === 'summary') {
        setReviewSummary(data.summary);
      } else if (analysisMode === 'evidence') {
        setEvidenceList(data.evidence || []);
        setQuarantineList(data.quarantine || []);
        setStats(data.stats || null);
        setDuplicateRemovedDetails(data.duplicateRemoved || []);
      } else { // full
        setReviewSummary(data.summary);
        setEvidenceList(data.evidence || []);
        setQuarantineList(data.quarantine || []);
        setStats(data.stats || null);
        setDuplicateRemovedDetails(data.duplicateRemoved || []);
      }

    } catch (err: any) {
      console.error('Analysis Error:', err);
      setAnalysisError(err.message || 'Terjadi kesalahan pada server.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // --- DOWNLOAD HANDLERS ---
  const downloadFile = (content: string, fileName: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownloadSummary = () => {
    if (reviewSummary) downloadFile(reviewSummary, 'review_summary.md', 'text/markdown');
  };

  const handleDownloadEvidence = () => {
    if (evidenceList.length > 0) {
      const jsonString = JSON.stringify(evidenceList, null, 2);
      downloadFile(jsonString, 'evidence_data.json', 'application/json');
    }
  };

  return (
    <div className="min-h-screen bg-slate-100/70 text-slate-900 flex flex-col font-sans selection:bg-blue-100 selection:text-blue-900">
      <Header onReset={handleReset} />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        
        {/* --- NAVIGASI TAB --- */}
        <div className="flex items-center gap-4 border-b border-slate-300 pb-3">
          <button
            onClick={() => setActiveTab('cleaning')}
            className={`px-4 py-2 text-xs sm:text-sm font-semibold rounded-lg transition-colors ${
              activeTab === 'cleaning'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
            }`}
          >
            🧹 Koreksi STT (Text Cleaning)
          </button>
          <button
            onClick={() => setActiveTab('analysis')}
            className={`px-4 py-2 text-xs sm:text-sm font-semibold rounded-lg transition-colors ${
              activeTab === 'analysis'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
            }`}
          >
            📊 Analisis & Evidence
          </button>
        </div>

        {/* --- KONTEN TAB CLEANING (UTUH) --- */}
        {activeTab === 'cleaning' && (
          <div className="space-y-6">
            <TextInputs
              originalText={originalText}
              modifiedText={modifiedText}
              onOriginalChange={handleOriginalChange}
              onModifiedChange={handleModifiedChange}
              onSwapText={handleSwapText}
            />
            <div className="space-y-3 pt-2">
              <DiffToolbar 
                granularity={granularity} 
                onGranularityChange={setGranularity} 
                viewMode={viewMode} 
                onViewModeChange={setViewMode} 
                totalChanges={summary.totalChanges} 
              />
              <ChangeSummaryCards summary={summary} />
            </div>
            <div className="space-y-6">
              <ColoredDiffViewer 
                parts={annotatedParts} 
                viewMode={viewMode} 
                selectedChangeItem={selectedChangeItem} 
                onSelectChangeItem={setSelectedChangeItem} 
                allChangeItems={changeItems} 
              />
              <ChangeList 
                changeItems={changeItems} 
                selectedItem={selectedChangeItem} 
                onSelectItem={setSelectedChangeItem} 
              />
            </div>
          </div>
        )}

        {/* --- KONTEN TAB ANALISIS & EVIDENCE (DENGAN UPLOAD 2 FILE) --- */}
        {activeTab === 'analysis' && (
          <div className="space-y-4">

            {analysisError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800">
                ⚠️ {analysisError}
              </div>
            )}

            {/* --- PILIHAN MODE ANALISIS --- */}
            <div className="flex flex-wrap items-center gap-4 bg-white p-3 rounded-xl border border-slate-300 shadow-xs">
              <span className="text-sm font-semibold text-slate-700">Mode Analisis:</span>
              <label className="flex items-center gap-1 text-xs cursor-pointer">
                <input
                  type="radio"
                  value="full"
                  checked={analysisMode === 'full'}
                  onChange={() => setAnalysisMode('full')}
                />
                Lengkap (Summary + Evidence)
              </label>
              <label className="flex items-center gap-1 text-xs cursor-pointer">
                <input
                  type="radio"
                  value="summary"
                  checked={analysisMode === 'summary'}
                  onChange={() => setAnalysisMode('summary')}
                />
                Summary saja
              </label>
              <label className="flex items-center gap-1 text-xs cursor-pointer">
                <input
                  type="radio"
                  value="evidence"
                  checked={analysisMode === 'evidence'}
                  onChange={() => setAnalysisMode('evidence')}
                />
                Evidence saja
              </label>
            </div>

            {/* --- TOMBOL DOWNLOAD (disesuaikan dengan mode) --- */}
            {(reviewSummary || evidenceList.length > 0) && (
              <div className="flex flex-wrap gap-3 pb-1">
                {analysisMode !== 'evidence' && (
                  <button 
                    onClick={handleDownloadSummary} 
                    disabled={!reviewSummary} 
                    className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors disabled:opacity-50"
                  >
                    📥 Download Summary (.md)
                  </button>
                )}
                {analysisMode !== 'summary' && (
                  <button 
                    onClick={handleDownloadEvidence} 
                    disabled={evidenceList.length === 0} 
                    className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors disabled:opacity-50"
                  >
                    📥 Download Evidence (.json)
                  </button>
                )}
              </div>
            )}

            {/* --- STATISTIK + DETAIL (DUPLICATE & QUARANTINE) --- */}
            {analysisMode !== 'summary' && stats && (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold text-slate-700">📊 Ringkasan Hasil Evidence</h3>
                  {stats.promptVersion && (
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                      stats.promptVersion === 'A'
                        ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                        : 'bg-slate-200 text-slate-700 border border-slate-300'
                    }`}>
                      Prompt {stats.promptVersion}
                    </span>
                  )}
                </div>
                
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 bg-white p-4 rounded-xl border border-slate-300 shadow-xs">
                  <div>
                    <div className="text-xs text-slate-500 leading-tight">Total Evidence Diekstrak</div>
                    <div className="text-lg font-bold text-slate-800">{stats.parsedEvidenceCount}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 leading-tight">Lolos Validasi</div>
                    <div className="text-lg font-bold text-emerald-600">{stats.validatorAcceptedCount}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 leading-tight">Di-Quarantine</div>
                    <div className="text-lg font-bold text-amber-600">{quarantineList.length}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 leading-tight">Duplicate Dihapus</div>
                    <div className="text-lg font-bold text-red-600">{stats.duplicateRemovedCount}</div>
                  </div>
                  {stats.eligibleMultiCount !== undefined && stats.eligibleMultiCount > 0 && (
                    <>
                      <div>
                        <div className="text-xs text-slate-500 leading-tight">Eligible Multi-occurrence</div>
                        <div className="text-lg font-bold text-slate-800">{stats.eligibleMultiCount}</div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 leading-tight">Resolved by Anchor</div>
                        <div className="text-lg font-bold text-emerald-600">
                          {stats.resolvedMultiCount ?? 0}
                          {typeof stats.multiResolutionRate === 'number' && (
                            <span className="text-xs text-slate-500 font-normal ml-1">
                              ({(stats.multiResolutionRate * 100).toFixed(0)}%)
                            </span>
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 leading-tight">Quarantine Multi</div>
                        <div className="text-lg font-bold text-amber-600">
                          {stats.quarantineMultiCount ?? 0}
                          {typeof stats.multiQuarantineRate === 'number' && (
                            <span className="text-xs text-slate-500 font-normal ml-1">
                              ({(stats.multiQuarantineRate * 100).toFixed(0)}%)
                            </span>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {/* --- DUA DETAIL SIDE-BY-SIDE (jika ada data) --- */}
                {(duplicateRemovedDetails.length > 0 || quarantineList.length > 0) && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* Detail Duplicate Dihapus */}
                    {duplicateRemovedDetails.length > 0 && (
                      <details className="bg-white border border-slate-300 rounded-xl p-3 shadow-xs">
                        <summary className="text-xs font-semibold text-red-700 cursor-pointer hover:text-red-800">
                          🗑️ Detail Duplicate Dihapus ({duplicateRemovedDetails.length})
                        </summary>
                        <div className="mt-2 max-h-48 overflow-y-auto space-y-2">
                          {duplicateRemovedDetails.map((item, idx) => (
                            <div key={idx} className="border-b border-red-100 pb-2 last:border-0">
                              <div className="flex justify-between items-start gap-2">
                                <span className="text-[10px] font-mono bg-red-200/70 px-1.5 py-0.5 rounded text-red-800">
                                  ID: {item.evidence_id}
                                </span>
                                <span className="text-[10px] text-red-600 italic text-right max-w-[60%]">
                                  {item.reason}
                                </span>
                              </div>
                              <p className="text-[10px] text-slate-500 mt-0.5">
                                Tetap mempertahankan: <strong>{item.kept_evidence_id}</strong>
                              </p>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {/* Detail Quarantine */}
                    {quarantineList.length > 0 && (
                      <details className="bg-white border border-slate-300 rounded-xl p-3 shadow-xs">
                        <summary className="text-xs font-semibold text-amber-700 cursor-pointer hover:text-amber-800">
                          ⚠️ Evidence di-Quarantine ({quarantineList.length})
                        </summary>
                        <div className="mt-2 max-h-48 overflow-y-auto space-y-2">
                          {quarantineList.map((item, idx) => {
                            if (typeof item === 'string') {
                              return (
                                <div key={idx} className="border-b border-amber-100 pb-2 last:border-0">
                                  <div className="flex justify-between items-start gap-2">
                                    <span className="text-[10px] font-mono bg-amber-200/70 px-1.5 py-0.5 rounded text-amber-800">
                                      Item #{idx + 1}
                                    </span>
                                    <span className="text-[10px] text-amber-600 italic break-words text-right max-w-[60%]">
                                      {item}
                                    </span>
                                  </div>
                                </div>
                              );
                            }

                            const reason = item.reason || 'Alasan tidak diketahui';
                            const chunkLabel = (item.chunkIndex !== undefined && item.chunkIndex !== null)
                              ? `Chunk #${item.chunkIndex + 1}`
                              : `Item #${idx + 1}`;
                            const evidence = item.evidence || {};

                            return (
                              <div key={idx} className="border-b border-amber-100 pb-2 last:border-0">
                                <div className="flex justify-between items-start gap-2">
                                  <span className="text-[10px] font-mono bg-amber-200/70 px-1.5 py-0.5 rounded text-amber-800">
                                    {chunkLabel}
                                  </span>
                                  <span className="text-[10px] text-amber-600 italic break-words text-right max-w-[60%]">
                                    {reason}
                                  </span>
                                </div>
                                {evidence.claim && (
                                  <p className="text-[11px] text-slate-700 mt-1">
                                    <span className="font-semibold">Claim:</span> {evidence.claim}
                                  </p>
                                )}
                                {evidence.source_excerpt && (
                                  <p className="text-[10px] text-slate-500 italic mt-0.5 truncate">
                                    <span className="font-medium">Excerpt:</span> "{evidence.source_excerpt}"
                                  </p>
                                )}
                                {evidence.evidence_id && (
                                  <p className="text-[10px] text-slate-400 mt-0.5">
                                    ID: {evidence.evidence_id}
                                  </p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* --- 3 KOLOM INPUT, SUMMARY, EVIDENCE --- */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              
              {/* KOLOM 1: Upload File */}
              <div className="bg-white border border-slate-300 rounded-xl shadow-xs p-4 flex flex-col min-h-[300px]">
                <h3 className="text-sm font-bold text-slate-800 mb-2">1. Upload File</h3>
                
                {/* Upload SRT */}
                <div className="mb-3">
                  <label className="block text-[10px] font-semibold text-slate-500 mb-1">📄 Transcript (transcript.srt)</label>
                  <div className="relative border border-dashed border-slate-300 rounded-lg p-2 hover:bg-slate-50 transition-colors">
                    <input
                      type="file"
                      accept=".srt,.txt"
                      onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0], false)}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    />
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span className="bg-slate-200 px-2 py-0.5 rounded">Choose file</span>
                      <span className="truncate max-w-[200px]">{srtContent ? '✅ File SRT dimuat' : 'Belum ada file'}</span>
                    </div>
                  </div>
                </div>

                {/* Upload METADATA JSON */}
                <div className="mb-3">
                  <label className="block text-[10px] font-semibold text-slate-500 mb-1">📦 Metadata (metadata.json)</label>
                  <div className="relative border border-dashed border-slate-300 rounded-lg p-2 hover:bg-slate-50 transition-colors">
                    <input
                      type="file"
                      accept=".json"
                      onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0], true)}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    />
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span className="bg-slate-200 px-2 py-0.5 rounded">Choose file</span>
                      <span className="truncate max-w-[200px]">{metadata.channel ? `✅ ${metadata.channel} dimuat` : 'Belum ada file'}</span>
                    </div>
                  </div>
                  
                  {/* Preview Metadata jika sudah diupload */}
                  {metadata.channel && (
                    <div className="mt-2 p-2 bg-blue-50 rounded border border-blue-100 text-xs space-y-0.5">
                      <p className="font-bold text-blue-700 truncate">{metadata.title || 'No Title'}</p>
                      <p className="text-slate-500">Channel: {metadata.channel}</p>
                      {metadata.uploadDate && <p className="text-slate-500 text-[10px]">📅 {metadata.uploadDate}</p>}
                    </div>
                  )}
                </div>

                {/* Tombol Jalankan dengan teks dinamis */}
                <button
                  onClick={handleAnalyze}
                  disabled={isAnalyzing || !srtContent.trim()}
                  className="mt-auto w-full py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isAnalyzing
                    ? '⏳ Menganalisis...'
                    : analysisMode === 'full'
                      ? '🚀 Jalankan Analisis Lengkap'
                      : analysisMode === 'summary'
                        ? '📝 Buat Summary'
                        : '🔍 Ekstrak Evidence'}
                </button>
              </div>

              {/* KOLOM 2: Review Summary */}
              <div className="bg-white border border-slate-300 rounded-xl shadow-xs p-4 flex flex-col min-h-[300px]">
                <h3 className="text-sm font-bold text-slate-800 mb-2">2. Review Summary</h3>
                <div className="flex-1 bg-slate-50 p-3 rounded-lg border border-slate-200 overflow-y-auto text-xs text-slate-700 whitespace-pre-wrap min-h-[200px]">
                  {isAnalyzing ? (
                    <div className="text-slate-400 italic animate-pulse">Sedang membuat ringkasan...</div>
                  ) : reviewSummary ? (
                    reviewSummary
                  ) : analysisMode === 'evidence' ? (
                    <span className="text-slate-400 italic">Mode Evidence saja, summary tidak diproses.</span>
                  ) : (
                    <span className="text-slate-400 italic">Hasil Summary AI akan muncul di sini.</span>
                  )}
                </div>
              </div>

              {/* KOLOM 3: Evidence Extraction (tanpa quarantine) */}
              <div className="bg-white border border-slate-300 rounded-xl shadow-xs p-4 flex flex-col min-h-[300px]">
                <h3 className="text-sm font-bold text-slate-800 mb-2">3. Evidence (Dengan Timestamp)</h3>
                <div className="flex-1 bg-slate-50 p-3 rounded-lg border border-slate-200 overflow-y-auto text-xs text-slate-700 min-h-[200px]">
                  {isAnalyzing ? (
                    <div className="text-slate-400 italic animate-pulse">Mengekstrak bukti & timestamp...</div>
                  ) : evidenceList.length > 0 ? (
                    <div className="space-y-3">
                      {evidenceList.map((ev, idx) => (
                        <div key={idx} className="bg-white p-2 rounded border border-slate-200 shadow-2xs">
                          <div className="flex justify-between items-start gap-2 mb-1">
                            <span className="font-bold text-blue-700 uppercase text-[10px]">{ev.topic}</span>
                            <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                              {ev.timestamp_start || '00:00:00'}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-800 leading-tight mb-1">"{ev.claim}"</p>
                          <p className="text-[10px] text-slate-400 italic truncate">Source: {ev.source}</p>
                        </div>
                      ))}
                    </div>
                  ) : analysisMode === 'summary' ? (
                    <span className="text-slate-400 italic">Mode Summary saja, evidence tidak diproses.</span>
                  ) : (
                    <span className="text-slate-400 italic">JSON Evidence dengan Timestamp akan muncul di sini.</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="bg-white border-t border-slate-200 py-4 mt-8 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4">
          Analisa Perubahan Teks — Membandingkan Teks Original dan Modifikasi dengan Penandaan Warna Interaktif
        </div>
      </footer>
    </div>
  );
}
