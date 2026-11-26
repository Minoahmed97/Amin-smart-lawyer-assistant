# Amin rebuild — architecture boundary

## Purpose

This branch is a controlled rebuild of Amin Smart Lawyer Assistant. Existing application screens remain the visual and workflow reference while the application core is reorganized behind stable service contracts. The original feature branch and the default branch are not modified.

## Product scope to preserve

1. Lawyer sign-in, session validation, logout, device binding, account status, credits, and recharge.
2. Legal drafting, including current-case facts, lawyer-specific style from the vault, document-type selection, streamed output, continuation, recovery after refresh, refinement, follow-up editing, copy, and Word export.
3. Opponent-document deconstruction and rebuttal, with file upload/OCR, analysis tabs, case-context handoff, and generated Word output.
4. Legal dispute qualification as an independent analysis. It must not silently read or inject lawyer-vault templates.
5. Egyptian legal-defenses codex and transfer of selected defenses into drafting.
6. Lawyer vault: original files, extracted model text, style templates, classification, edit/delete, and user-scoped isolation.
7. Case workspace: saved cases, active-case selection, cross-screen transfer, cloud/local fallback, and restore after refresh.
8. Community wall, reviews, announcements, broadcasts, and analytics.
9. Admin console: accounts, credits, packages, Gemini/OCR key administration, health, usage, and security controls.
10. PWA install, responsive layouts, theme selection, notifications, and local Word export.

## Target boundaries

- Presentation: existing React views and design system. No redesign is allowed as part of the core rebuild.
- Application: explicit use cases for sign-in, case selection, drafting, deconstruction, qualification, vault operations, OCR, and admin actions. Views should call use cases rather than reconstruct business rules.
- Domain: typed entities and pure rules for case context, task lifecycle, context selection, token/character budgets, output completion, and user-scoped ownership.
- Infrastructure: HTTP client, session storage, Supabase persistence, Gemini provider adapter, durable queue, OCR storage, analytics, push, and document export.
- API boundary: one route registry with validated inputs, consistent errors, authentication, authorization, and safe diagnostics.

## AI task invariants

- Every AI task receives a unique task ID and explicit owner ID.
- Task states are queued, processing, streaming, completed, failed, or cancelled; only completed is success.
- Partial text is persisted and recoverable, but must never be presented as a completed legal document.
- A retry must reuse an idempotency/task ID only when it is explicitly resuming that same task.
- Continuations send a compact continuation anchor, not the entire original evidence bundle again.
- Drafting context is task-specific and budgeted before calling Gemini. The budget includes system instructions, user evidence, vault style, previous analysis, and the required output reserve.
- Preserve names, roles, dates, case numbers, amounts, article/judgment references, facts, defenses, and exact requests. Never silently discard a critical field to meet a budget.
- The vault may influence structure, heading order, and writing style only. It must not leak facts, parties, dates, defenses, or requests from another case.
- Qualification is independent of the lawyer vault.
- Gemini credentials remain server-side. This branch does not alter key rotation as a shortcut for prompt-size or timeout problems.

## Reliability gates

A feature is not considered complete because it compiles or returns HTTP 200. Each use case must pass:
1. type checking;
2. unit tests for pure rules and HTTP contracts;
3. API integration checks for authentication, authorization, validation, and error paths;
4. a production-like end-to-end browser test with representative small and long documents;
5. refresh/recovery and duplicate-submit checks;
6. a deployment smoke test and inspection of server logs for provider status, finish reason, task state, and partial-output counts.

No production branch is to be merged until the full feature matrix in ACCEPTANCE_MATRIX.md has been exercised.
