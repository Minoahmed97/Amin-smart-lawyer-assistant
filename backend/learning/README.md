# Amin Legal Learning Module

This folder is an isolated backend foundation for the personal legal-learning layer.

## Current boundary

- The module is registered through the existing central `api/index.ts` route; it does not add a separate Vercel function.
- The existing legal vault receives one isolated archive-learning section; its existing models, upload workflow, and other screens are otherwise unchanged. Existing AI prompts, legal workflows, authentication, credits, plans, OCR, and document extraction are not replaced.
- `handler.ts` uses the application's existing signed session through `requireActiveSession`. The user ID must always come from that verified session, never from the request body.
- The Supabase service credential stays on the server. The new tables deny direct access to `anon` and `authenticated` roles.

## Learning lifecycle

1. A later integration may record a lawyer-reviewed before/after correction as a pending learning event.
2. A learning extractor may turn that event into a proposed memory. `policy.ts` contains the extraction instruction; it does not call a model or update model weights.
3. A proposed memory is unusable until the lawyer explicitly approves it.
4. Retrieval returns only approved memories. Global memories may apply across cases; case-scoped memories require an exact matching internal `case_ref`.
5. Retrieved memories are professional preferences and working rules, not legal authorities or facts. They never override the current case file, verified law, or explicit task instructions.

## Data separation

- `amin_learning_events`: source corrections and review status.
- `amin_professional_memories`: reusable or case-scoped professional experience and approval state.
- `amin_case_memory`: structured case context keyed by an opaque internal reference.

Do not use a case number, client name, or other identifying text as `case_ref`. The archive endpoint requires a stable opaque case identifier and keeps each case analysis and its case-scoped memories isolated.

## Manual database setup

Run `learning_memory_migration.sql` manually in the existing Supabase project after the current `platform_users` table exists. The migration is additive and creates only the three learning tables and their indexes/permissions.

## Remaining application integration

The authenticated archive-analysis API and correction-learning API are available on the backend. The vault now includes a case-archive workspace. It reuses the existing PDF/Word/image text-extraction component and lets the lawyer associate previously saved vault models with a case. The archive workspace sends extracted text to the authenticated learning endpoint. Live deconstruction, qualification, drafting, refinement, and legal follow-up-chat replies now retrieve approved global professional memories and, only when explicitly selected, approved memories for that exact archive case. Retrieval is additive and fails open: if the learning store is unavailable, the existing legal task continues without the extra context. Each deconstruction, qualification, drafting, and follow-up-chat screen now offers an optional active archive-case selector. The selected opaque `caseRef` is passed through the existing authenticated request to the server. Retrieval is restricted to that account's approved global memories plus approved case memories whose `case_ref` exactly matches the selected UUID; without a selection, only global memories are retrieved. The selector stores only the selected archive ID in user-scoped localStorage. Case-specific memories never cross into another selected case. When the lawyer edits a generated deconstruction, qualification, or draft directly in the built-in editor and exits edit mode, the before/after texts are recorded as a pending correction event. When the vault review queue is opened, it extracts pending events serially (up to five per load) to avoid duplicate concurrent proposals. When a follow-up-chat instruction actually changes the underlying document, the prior text, revised text, and the lawyer's instruction are recorded as pending correction events and processed by the same serialized vault review queue. Extraction creates only a proposed memory; the lawyer must still approve it in the vault review queue. If extraction fails after the event is stored, the legal task and the edit remain successful, and the event stays available for a later queue refresh.



Correction extraction policy: a correction linked to an archive case defaults to a case-scoped proposal. A single case correction must not become a global rule unless the lawyer explicitly states that it is a lasting general preference. An unlinked single correction must not become a global rule unless its stated reason explicitly establishes that general preference. Repeated strategy lessons should be supported by independent cases or an explicit lawyer instruction.

## API route now registered

The central router exposes `POST /api/learning/memory`. Every action requires the existing signed bearer session and JSON content type. The endpoint is rate-limited per authenticated account.

Supported actions:

- `analyze-case-archive`: analyzes extracted text from one or more prior cases, stores each case analysis, and creates case-specific proposals. With two or more cases, a separate cross-case pass may propose general professional memories supported by at least two identified cases.
- `record-correction`: stores before/after text and an optional explicit reason as a pending correction event.
- `record-decision`: stores the lawyer's explicit post-analysis decision and mandatory reason as a pending `manual_note` event; it does not treat the AI's recommendation as the lawyer's choice.
- `extract-event`: runs the existing Gemini key-rotation path and converts one pending event into either no candidate or one proposed memory. It never approves a memory.
- `list-review-queue`: returns pending correction events and proposed memories for the authenticated account.
- `review-memory`: approves or rejects one proposed memory.
- `review-event`: marks a pending event processed or ignored.
- `get-learning-context`: returns the case memory and only approved memories applicable to the exact case/task.
- `save-case-context`: upserts structured context using the opaque case reference.
- `create-memory-candidate`: allows a proposed memory to be recorded from a reviewed source event; source event ownership is checked.

Example correction payload:

```json
{
  "action": "record-correction",
  "taskType": "deconstruct",
  "caseRef": "opaque-internal-case-id",
  "beforeText": "AI draft text",
  "afterText": "Lawyer corrected text",
  "reason": "The reply must address only the incidental claim; refer to the earlier memorandum for the original claim."
}
```

Then call `extract-event` with the returned event ID. The result is a proposed memory and remains excluded from retrieval until an explicit `review-memory` action approves it.

The deconstruction screen can separately record the lawyer's explicit decision and reason after reviewing the analysis. The pending decision event is processed through the same extractor/review queue; case-linked decisions default to case-scoped proposals, and no proposal is automatically approved. The AI's suggested strategy is never recorded as the lawyer's decision unless the lawyer explicitly submits it.


## Learning from a prior-case archive

The authenticated endpoint also accepts `action: "analyze-case-archive"`. It expects extracted plain text from the existing document/OCR pipeline; it does not accept raw PDF, DOCX, image, or ZIP bytes and does not replace the application's existing file extraction.

Example:

```json
{
  "action": "analyze-case-archive",
  "cases": [
    {
      "caseRef": "opaque-stable-case-id-1",
      "title": "عنوان داخلي اختياري",
      "documents": [
        { "name": "مذكرة المحامي", "type": "lawyer_memorandum", "text": "النص المستخرج..." },
        { "name": "تقرير الخبير", "type": "expert_report", "text": "النص المستخرج..." }
      ]
    }
  ]
}
```

Limits: 1–8 cases per request, 1–30 documents per case, 120,000 characters per document, and 500,000 characters total. All model calls in a batch share a 240-second deadline, leaving time for database persistence within the existing 300-second API function limit. Each case is analyzed independently and its structured analysis is saved in `amin_case_memory`; a source event is retained in `amin_learning_events`; case-specific lesson candidates are created as proposed memories. When at least two independent cases are supplied, a separate comparison pass may create global professional-memory proposals only when the same pattern is supported by at least two cases. No proposed memory is automatically approved.

The model must distinguish document facts from inferences, reconstruct chronology and lawyer decisions, identify what was added/omitted/referred to, assess opponent/court/expert responses, and state uncertainty. A case outcome alone is not treated as proof that every strategy was correct.

The user-facing archive workspace is embedded in the legal vault. It reuses the existing upload/OCR/document extraction flow. Original file bytes remain in local IndexedDB; extracted document text, structured analysis, and learning events are retained in the user's Supabase learning tables. Text is sent to Gemini for analysis. Keep this adapter separate from existing legal-task behavior.

## ربط تاريخ القضية بالمهام الحية

عند اختيار قضية من محدد القضايا في التفنيد أو التكييف أو الصياغة أو تدقيق المسودة أو المحادثة اللاحقة، تسترجع الخدمة سجل `amin_case_memory` الخاص بالمستخدم والقضية المحددة، وتقرأ `case_state.archiveAnalysis` فقط. يُنسّق السياق بحد أقصى يقارب 6,500 حرف، ويقتصر على ملخص القضية ومواقف الأطراف وطلباتهم والتسلسل الزمني وقرارات المحامي وردود الخصم/الخبير/المحكمة والنتيجة والفجوات.

هذا الملخص سياق تاريخي مساعد وليس مستنداً أصلياً أو دليلاً أو مصدراً قانونياً. يتعين على النموذج مطابقته مع مدخلات ومستندات المهمة الحالية، وتحديد ما استجد وما تغير، وعدم نقل طلبات أو دفوع قديمة باعتبارها ما زالت قائمة. لا توجد قاعدة ثابتة تلزم بالرد الشامل أو الرد المحدود أو الإحالة إلى مذكرة سابقة؛ يحدد نطاق الرد بحسب القضية والمرحلة والطلبات الحالية. عند عدم اختيار قضية أو تعذر استرجاع سجلها، تستمر المهمة دون هذا السياق ودون تعطيل الخدمة.
