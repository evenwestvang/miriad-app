# Tech Debt

Tracked cleanup items. Each entry should explain what, where, and why.

---

## Remove legacy Letta integration code

Letta integration was never functional. The settings UI has been removed, but backend support code remains:

- `backend/packages/server/src/agents/invoker-adapter.ts` — `getSpaceSecretValue("letta_api_key")` injection (~line 626)
- `backend/packages/server/src/agents/invoker-adapter.test.ts` — mock comment referencing letta_api_key (line 270)
- `backend/packages/core/src/types.ts` — JSDoc comment referencing "Letta agent IDs" (line 365)
- Any stored `letta_api_key` space secrets in production DB

Cleanup: remove the code references, consider a migration to delete orphaned secrets.
