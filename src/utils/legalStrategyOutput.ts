export const LEGAL_STRATEGY_START = '[[AMIN_STRATEGY]]';
export const LEGAL_STRATEGY_END = '[[/AMIN_STRATEGY]]';
export const LEGAL_DOCUMENT_START = '[[AMIN_DOCUMENT]]';
export const LEGAL_DOCUMENT_END = '[[/AMIN_DOCUMENT]]';

export interface SplitLegalStrategyOutput {
  strategy: string;
  document: string;
  structured: boolean;
}

/**
 * Separates the lawyer-facing recommendation from the court-ready document.
 * The unstructured fallback preserves compatibility with older model outputs.
 */
export function combineLegalStrategyOutput(strategy: string, document: string): string {
  if (!strategy.trim()) return document;
  return `${LEGAL_STRATEGY_START}
${strategy.trim()}
${LEGAL_STRATEGY_END}
${LEGAL_DOCUMENT_START}
${document}
${LEGAL_DOCUMENT_END}`;
}

export function splitLegalStrategyOutput(raw: string, allowUnstructuredFallback = true): SplitLegalStrategyOutput {
  const source = String(raw || '');
  const strategyStart = source.indexOf(LEGAL_STRATEGY_START);
  const strategyEnd = strategyStart >= 0
    ? source.indexOf(LEGAL_STRATEGY_END, strategyStart + LEGAL_STRATEGY_START.length)
    : -1;
  const documentStart = source.indexOf(LEGAL_DOCUMENT_START);
  const documentEnd = documentStart >= 0
    ? source.indexOf(LEGAL_DOCUMENT_END, documentStart + LEGAL_DOCUMENT_START.length)
    : -1;

  const hasCompleteStrategy = strategyStart >= 0 && strategyEnd >= 0;
  const strategyBoundary = documentStart >= 0
    ? Math.min(strategyEnd >= 0 ? strategyEnd : documentStart, documentStart)
    : strategyEnd;
  const strategy = strategyStart >= 0 && strategyBoundary >= 0
    ? source.slice(strategyStart + LEGAL_STRATEGY_START.length, strategyBoundary).trim()
    : '';

  if (documentStart >= 0) {
    return {
      strategy,
      document: source.slice(
        documentStart + LEGAL_DOCUMENT_START.length,
        documentEnd >= 0 ? documentEnd : source.length,
      ).trim(),
      structured: true,
    };
  }

  // During streaming, do not mistake an unfinished recommendation for a document.
  // If its closing marker did arrive, however, preserve any document text that
  // followed even when the model omitted the document-start marker.
  if (strategyStart >= 0 && strategyEnd < 0) {
    return { strategy: '', document: '', structured: true };
  }
  if (hasCompleteStrategy) {
    const trailingDocument = source.slice(strategyEnd + LEGAL_STRATEGY_END.length).trim();
    return {
      strategy,
      document: allowUnstructuredFallback ? trailingDocument : '',
      structured: false,
    };
  }

  return {
    strategy: '',
    document: allowUnstructuredFallback
      ? source
          .replace(LEGAL_STRATEGY_START, '')
          .replace(LEGAL_STRATEGY_END, '')
          .replace(LEGAL_DOCUMENT_START, '')
          .replace(LEGAL_DOCUMENT_END, '')
          .trim()
      : '',
    structured: false,
  };
}
