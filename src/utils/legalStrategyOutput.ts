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
  return `${LEGAL_STRATEGY_START}\n${strategy.trim()}\n${LEGAL_STRATEGY_END}\n${LEGAL_DOCUMENT_START}\n${document}\n${LEGAL_DOCUMENT_END}`;
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

  const strategy = strategyStart >= 0
    ? source.slice(
        strategyStart + LEGAL_STRATEGY_START.length,
        strategyEnd >= 0 ? strategyEnd : documentStart >= 0 ? documentStart : source.length,
      ).replace(LEGAL_STRATEGY_END, '').trim()
    : '';
  if (documentStart < 0 && strategyStart >= 0) {
    return { strategy, document: '', structured: true };
  }

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

  return {
    strategy,
    document: allowUnstructuredFallback
      ? source
          .replace(LEGAL_STRATEGY_START, '')
          .replace(LEGAL_STRATEGY_END, '')
          .replace(LEGAL_DOCUMENT_END, '')
          .trim()
      : '',
    structured: false,
  };
}
