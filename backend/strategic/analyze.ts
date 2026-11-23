import crypto from 'node:crypto';
import { requireActiveSession, enforceAiCooldown, consumeOperation } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';
import { loadOwnedCaseFile, persistOwnedCaseFile } from './cases.ts';
import { runStrategicAnalysis } from './analysisEngine.ts';
import type { CaseMemoryEntry, StrategicAnalysisInput } from '../../src/strategic/types.ts';

function parseBody(req: any): any {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch {}
  }
  return {};
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'طريقة الطلب غير مسموح بها.' });
  }

  try {
    const body = parseBody(req);
    const caseId = String(body.caseId || '').trim();
    if (!caseId) return res.status(400).json({ error: 'معرّف ملف القضية مطلوب للتحليل.' });

    rateLimit(req, 'gemini-strategic-analysis', 5, 10 * 60 * 1000);
    const { session } = await requireActiveSession(req);
    await enforceAiCooldown(req, session);
    limitBodyString(body.additionalInstructions, 12000, 'التعليمات الإضافية');
    const loaded = await loadOwnedCaseFile(session.userId, caseId);
    const caseFile = loaded.caseFile;

    let requestedStages = body.requestedStages;
    if (typeof requestedStages === 'string') {
      try { requestedStages = JSON.parse(requestedStages); } catch { requestedStages = undefined; }
    }
    const input: StrategicAnalysisInput = {
      caseFile,
      requestedStages: Array.isArray(requestedStages) ? requestedStages : undefined,
      additionalInstructions: typeof body.additionalInstructions === 'string' ? body.additionalInstructions : '',
      priorAnalysis: caseFile.analysisSnapshots,
    };

    const result = await runStrategicAnalysis(input);
    const usage = await consumeOperation(req, 'gemini-operation');

    const createdAt = new Date().toISOString();
    const memoryEntries: CaseMemoryEntry[] = result.completedStages.map((stage) => {
      const snapshot = result.stageResults[stage]!;
      return {
        id: crypto.randomUUID(),
        caseId,
        category: 'model_finding',
        content: [snapshot.summary, ...snapshot.findings].filter(Boolean).join('\n'),
        origin: 'ai_analysis',
        verification: 'unverified',
        sourceDocumentIds: [],
        relatedFactIds: [],
        relatedAnalysisId: snapshot.id,
        createdAt,
        createdBy: session.userId,
      };
    }).filter((entry) => entry.content.trim());

    const updatedCaseFile = {
      ...caseFile,
      analysisSnapshots: [...caseFile.analysisSnapshots, ...result.completedStages.map((stage) => result.stageResults[stage]!)].slice(-100),
      memory: [...caseFile.memory, ...memoryEntries].slice(-1000),
      contextChanges: caseFile.contextChanges.map((change) =>
        change.reevaluationStatus === 'pending'
          ? { ...change, reevaluationStatus: 'completed' as const }
          : change,
      ),
      lastAnalyzedAt: createdAt,
      ...(result.strategy ? { strategy: result.strategy } : {}),
    };

    let persisted = false;
    let persistenceWarning = '';
    try {
      await persistOwnedCaseFile(session.userId, updatedCaseFile, loaded.updatedAt);
      persisted = true;
    } catch (error: any) {
      persistenceWarning = String(error?.message || 'تعذر حفظ التحليل في ملف القضية.');
    }

    return res.status(200).json({
      result: {
        ...result,
        warnings: [...result.warnings, ...(persistenceWarning ? [persistenceWarning] : [])],
      },
      persisted,
      remainingCredits: usage.remainingCredits,
      trialRemaining: usage.trialRemaining,
    });
  } catch (error: any) {
    const statusCode = Number(error?.statusCode || error?.status);
    const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    console.error('Strategic analysis request failed:', status);
    return res.status(status).json({ error: error?.message || 'تعذر تنفيذ التحليل الاستراتيجي.' });
  }
}
