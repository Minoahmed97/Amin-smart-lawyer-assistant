# Amin rebuild — functional acceptance matrix

The tests below are release gates. A UI click alone is not proof of success; the persisted state and server outcome must also be checked.

| Area | Scenario | Acceptance condition |
|---|---|---|
| Authentication | Valid lawyer login | Session is saved, current user is loaded, and the lawyer workspace appears. |
| Authentication | Invalid password / suspended account / expired session | A clear error appears; no false logged-in state; unrelated local data is not deleted. |
| Authentication | Refresh while signed in | Session is revalidated and the same account is restored. |
| Credits | Zero balance | Account remains intact; a recharge path is shown; no silent account suspension or deletion. |
| Drafting | Normal case | A complete legal document renders, can be edited/copied, and exports to Word. |
| Drafting | Long case | Evidence is budgeted before generation; output is streamed and completed through bounded continuations; no false success on timeout. |
| Drafting | Refresh mid-generation | The task ID and partial result are recovered; resuming does not charge or submit duplicate work. |
| Drafting | Vault contains unrelated cases | Only the current lawyer's style cues are used; no unrelated names or facts enter the draft. |
| Drafting | Follow-up after refresh | Conversation and case context persist; edits update the main result, not only the chat transcript. |
| Deconstruction | Long opponent pleading | Upload/OCR and analysis finish; result tabs and Word export work. |
| Deconstruction | Transfer to drafting | Current evidence, case nature, document type, and rebuttal context transfer without losing source identity. |
| Qualification | New dispute | Independent legal opinion and conclusion are produced without vault/template injection. |
| Qualification | Transfer to drafting | Facts and prior analysis are attached to the same case without overwriting unrelated fields. |
| Vault | Upload original document | Original file remains downloadable; extracted text/model is separately stored and user-scoped. |
| Vault | Switch accounts | No model, original file, or style context from another lawyer is exposed. |
| Defenses | Search, filter, insert | Search/filter results are correct and inserted defenses appear in the drafting form. |
| Case workspace | Save, select, refresh | Selected case and its structured facts/requests/defenses are restored consistently. |
| OCR | PDF, DOCX, image, batch, cancellation | Supported files extract correctly; cancel removes the right task; partial OCR is not marked complete. |
| Admin | Manage account, credits, packages, keys | Admin session is enforced; writes are audited and user-facing account state is consistent. |
| Community | Load and submit review | Empty/error/loading states are clear; successful submissions appear once. |
| Broadcast | Admin announcement | Message appears and tab navigation works without corrupting current task state. |
| PWA | Install, theme, notifications | Install prompt, theme persistence, and push registration behave correctly on supported browsers. |
| Operations | Production deployment | API health, logs, queue callback, and client route refresh all pass. |

## Initial automated coverage

The tests/httpClient.test.ts file verifies JSON request headers, session-token forwarding, nested error parsing, HTTP status and Retry-After preservation, invalid JSON handling, and timeout behavior. Additional domain and integration tests must be added as each layer is migrated.
