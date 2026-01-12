# Technical Debt

This document tracks known technical debt and issues that should be addressed.

## High Priority

### React Hooks Violations in Frontend (`frontend/src/App.tsx`)

**Issue**: ~50+ violations of React's rules-of-hooks - hooks are being called conditionally after early returns.

**Why it matters**: Calling hooks conditionally is a footgun. React hooks must be called in the exact same order on every render. While the code may work at runtime (React is somewhat forgiving), this can cause subtle bugs:
- State can get "out of sync" between renders
- Effects may run unexpectedly or not at all
- Hard-to-debug issues in edge cases

**Fix required**: Refactor `App.tsx` to move all hooks before any conditional returns. This likely requires extracting conditional logic into child components or using early-exit patterns differently.

**CI Status**: Lint check disabled until fixed (see `.github/workflows/ci.yml`)

---

### TypeScript Project References Not Configured (Backend)

**Issue**: Backend workspace packages (`@cast/core`, `@cast/storage`, etc.) don't have TypeScript project references set up. Running `pnpm typecheck` fails because packages can't resolve each other's types without building first.

**Why it matters**:
- Can't catch type errors across package boundaries during development
- Must run full build to verify types
- IDE may show false errors

**Fix required**: Set up TypeScript project references in `backend/tsconfig.json` with `references` array pointing to each package, and add `composite: true` to each package's tsconfig.

**CI Status**: Typecheck disabled until fixed (see `.github/workflows/ci.yml`)

---

## Medium Priority

### ESLint Configuration

**Issue**: Frontend had no eslint configuration. We added one (`frontend/eslint.config.js`) but it's not enforced in CI due to the hooks violations above.

**Fix required**: Once hooks violations are fixed, re-enable lint in CI.

---

## Notes

- Deploy workflows (`deploy-staging.yml`, `deploy-prod.yml`) run `pnpm build` which catches compilation errors, so deployments are still validated.
- These issues are pre-existing in the codebase, not introduced by recent changes.
