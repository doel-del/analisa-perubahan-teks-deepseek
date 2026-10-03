export type DiffGranularity = 'words' | 'lines' | 'chars';

export type DiffViewMode = 'unified' | 'split';

export type ChangeType = 'added' | 'removed' | 'modified';

export interface DiffPart {
  id: string;
  value: string;
  added?: boolean;
  removed?: boolean;
  count?: number;
  changeIndex?: number; // Index of the change in the discrete change list
}

export interface TextChangeItem {
  id: string;
  index: number;         // 1-based index (#1, #2, ...)
  type: ChangeType;
  oldText?: string;      // What was deleted or replaced
  newText?: string;      // What was added or replacement
  description: string;   // Human-readable Indonesian description
  partIds: string[];     // IDs of the DiffPart(s) associated with this change
  wordCount: number;
  charCount: number;
}

export interface DiffSummary {
  similarityPercent: number;
  totalChanges: number;
  addedWords: number;
  removedWords: number;
  addedChars: number;
  removedChars: number;
  originalWordCount: number;
  modifiedWordCount: number;
  originalCharCount: number;
  modifiedCharCount: number;
}

export interface SampleText {
  id: string;
  title: string;
  category: string;
  description: string;
  original: string;
  modified: string;
}