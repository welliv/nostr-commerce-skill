# Fibonacci Update — Push Instructions

This file documents the deployment of the Fibonacci backoff, trust scoring, and prerequisite map (v2.0.1). Kept for historical reference.

## Quick Apply

```bash
git clone https://github.com/welliv/nostr-commerce-skill.git
cd nostr-commerce-skill
git am FIBONACCI_PUSH.patch
npm install && npm run typecheck && npm test
git push origin main
```

Expected: **23 test files · 253 tests · 0 failures**

## Files Added

| File | Lines | What |
|------|-------|------|
| `src/fibonacci.ts` | 327 | `fibonacciSleep`, `computeTrustScore`, `checkPrerequisites`, `buildPath`, `SCENARIO_PREREQUISITES` |
| `tests/fibonacci.test.ts` | 244 | 33 tests covering all fibonacci utilities |
| `references/nip-recipes.md` | 185 | NIP recipe reference |
| `references/framework-patterns.md` | 82 | Framework implementation patterns |
| `.github/workflows/ci.yml` | — | CI/CD pipeline |
| `LICENSE` | — | MIT licence |

## Files Modified

- `src/escrow.ts` — imports `fibonacciSleep`, replaces exponential backoff
- `src/index.ts` — exports fibonacci utilities
- `SKILL.md` — prerequisite checking section
- `README.md` — trust score + prereq examples + limitations rows
- Various `src/*.ts` and `tests/*.test.ts` — expanded coverage
- `SYSTEM_ANALYSIS.md` — deleted (moved to `docs/`, gitignored)
