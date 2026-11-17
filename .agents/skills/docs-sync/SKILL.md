---
name: docs-sync
description: Lean documentation specialist skill. Keeps project documentation (README.md) clean, simple, and synchronized with actual codebase architecture, contracts, and features whenever structural code changes happen.
---

# `docs-sync` — Lean Documentation Specialist

Write documentation that a developer or AI agent can understand in 30 seconds: **accurate, scannable, simple, zero fluff.**

## 1. When to Update Docs (Trigger Rules)

**Update `README.md` in the same task when you:**
- Add, rename, or delete a source file or module (`src/**`).
- Change a shared interface or contract (e.g., reader controller methods, storage schema, or service return shapes).
- Add, remove, or change user-facing features, themes, shortcuts, or external APIs.
- Change build, dev, or test commands in `package.json`.

**Do NOT update docs for:**
- Pure CSS/styling tweaks, minor bug fixes, or internal refactors that keep behavior and contracts identical.

## 2. Writing Style (Clean, Lean, Simple)

- **Short sentences, plain words:** Explain *what* a module does and *why* it exists without marketing filler.
- **Structure over prose:** Use compact bullet lists and Markdown tables for module maps, contracts, and shortcuts.
- **Verify every fact:** Read the actual files before writing. Every file path, symbol name, store name, and command must exist in the current codebase.
- **Clean up dead links:** Remove references to deleted files, screenshots, or removed features.

## 3. Standard Sections to Maintain

1. **Overview:** 1-line summary of the app and stack.
2. **Features:** Concise bullet list of real user-facing capabilities.
3. **Architecture:** Table mapping each directory/file to its single responsibility.
4. **Key Contracts:** Brief signature/lifecycle summary for shared interfaces (e.g., reader controllers, IndexedDB stores).
5. **Commands:** Exact `npm` commands to run and build.
