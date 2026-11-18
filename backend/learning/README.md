# Amin Legal Learning Module

This folder is an isolated backend foundation for the personal legal-learning layer.

## Current boundary

- The module is intentionally not registered in `api/index.ts` yet.
- No existing screen, AI prompt, legal workflow, authentication flow, credits, plans, OCR, file extraction, or deployment configuration is changed.
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

Do not use a case number, client name, or other identifying text as `case_ref`. The eventual application integration must supply a stable opaque case identifier and must keep documents and case facts scoped to their own case.

## Manual database setup

Run `learning_memory_migration.sql` manually in the existing Supabase project after the current `platform_users` table exists. The migration is additive and creates only the three learning tables and their indexes/permissions.

## Later integration point

When the module is ready to connect to the existing app, register its handler in the central API router and add a client service that submits corrections only after the lawyer chooses to save/review them. Then connect the case-context adapter to the current file/vault inputs. Do not replace the existing legal prompts or workflows as part of that connection.

## API route now registered

The central router exposes `POST /api/learning/memory`. Every action requires the existing signed bearer session and JSON content type. The endpoint is rate-limited per authenticated account.

Supported actions:

- `record-correction`: stores before/after text and an optional explicit reason as a pending event.
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

No frontend currently calls this route. No existing AI task automatically records or retrieves learning data yet; that integration remains a separate controlled step after the endpoint and storage migration are tested.


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

Limits: 1–8 cases per request, 1–30 documents per case, 120,000 characters per document, and 500,000 characters total. Each case is analyzed independently and its structured analysis is saved in `amin_case_memory`; a source event is retained in `amin_learning_events`; case-specific lesson candidates are created as proposed memories. When at least two independent cases are supplied, a separate comparison pass may create global professional-memory proposals only when the same pattern is supported by at least two cases. No proposed memory is automatically approved.

The model must distinguish document facts from inferences, reconstruct chronology and lawyer decisions, identify what was added/omitted/referred to, assess opponent/court/expert responses, and state uncertainty. A case outcome alone is not treated as proof that every strategy was correct.

This is a backend endpoint only. A user-facing archive picker and adapter to the existing upload/OCR/document extraction flow are still required before the lawyer can select and submit files directly from the app. Keep that adapter separate from existing OCR and legal-task behavior.
