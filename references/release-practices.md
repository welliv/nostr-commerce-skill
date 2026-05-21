# Releases for Skills: Do You Need Them?

## Quick Answer

No. Releases are **not necessary** for skills to work. Hermes Agent loads skills directly from GitHub raw file URLs (`raw.githubusercontent.com/<user>/<repo>/main/SKILL.md`). It never downloads release artifacts — it reads the default branch.

## Evidence from the Ecosystem

| Repo Type | Example | Releases | Tags | Notes |
|-----------|---------|----------|------|-------|
| **Hermes Agent itself** | nousresearch/hermes-agent | 13 | 13 | Weekly releases (product users install it) |
| **CLI tool** | 3rdIteration/btcrecover | 9 | 9 | Tool people `pip install` |
| **npm library** | getalby/lightning-tools | 24 | 30 | Published to npm |
| **npm library** | paulmillr/noble-curves | 30 | 30 | Published to npm |
| **npm library** | bitcoinjs/bitcoinjs-lib | 0 | 30 | Tags only, no GitHub Releases |
| **Skill repo** | welliv/btcrecover-skill | 2 | 2 | Some releases, some not |
| **Workflow templates** | actions/starter-workflows | 0 | 0 | No releases, no tags — pure reference |
| **Framework** | langchain-ai/langchain | 30 | 30 | Major framework, pip-installable |

The only repos that consistently use releases are those with **installable packages** (npm, pip). Pure reference/template repos (starter-workflows) have none.

## Hermes Skill Authoring Guide Says

> "Release pipelines are user-dependent — some prefer signed commits only, without cosign, tags, or release workflows. Ask before building a release pipeline. Agent skills load from GitHub raw URLs regardless."

This confirms: skill loading is **branch-based**, not release-based.

## What Actually Matters for a Skill Repo

1. **Clean commit history** with descriptive messages — lets agents and humans understand what changed
2. **Tags on significant versions** — lets users pin to a known-good snapshot (`raw.githubusercontent.com/user/repo/v2.0.1/SKILL.md`)
3. **SKILL.md at the root** — this is what agents actually load
4. **README** — this is what humans see on GitHub
5. **Consistent structure** — `src/`, `tests/`, `references/` so agents know where things live

Tags are more useful than releases for skills because Hermes can reference a tag directly in its raw URL. A GitHub Release is a tag + notes — nice to have, not essential.

## Recommendation

- **Keep tags** for version pinning (you already have v1.0.0, v2.0.0, v2.0.1)
- **Releases are optional** — you can add them when you want changelog visibility or npm publishing
- If you want releases, keep them simple: tag + title + bullet changelog (what you already have is fine)
- Don't add a release pipeline to CI unless you're also publishing to npm — it's unnecessary complexity
