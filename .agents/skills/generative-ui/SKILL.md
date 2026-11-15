---
name: generative-ui
description: >-
  Generate a self-contained, single-file interactive HTML/CSS/JS UI prototype
  from a system plan so the user can test layout, themes, interactions, and
  plan-to-UI alignment in a browser before full implementation. Use when the
  user asks for a generative UI, interactive mockup, visual plan check, or
  /generative-ui style preview.
---

# Generative UI Prototype Skill

Build a zero-dependency, single-file interactive HTML prototype (`preview/<project>-generative-ui.html`) that proves the system plan and UI work together.

## Workflow

1. **Extract Plan Contracts**
   - Identify core views, primary user flows, state transitions, external APIs, and critical failure/edge cases (e.g. theme contrast traps, text selection boundaries, storage persistence).
   - Map each architectural module to visible UI controls.

2. **Generate Self-Contained Prototype**
   - Write one standalone `.html` file (inline `<style>` + `<script>`, no build step or external JS/CSS dependencies).
   - Use semantic CSS custom properties (`--bg-app`, `--bg-surface`, `--bg-reader`, `--text-main`, `--text-muted`, `--accent`, `--border`) so every theme updates all chrome, overlays, and content safely.
   - Implement real DOM interactions (not static screenshots): view switching, drawers/popovers with viewport edge clamping, live API calls with offline fallbacks, and edge-case stress toggles.
   - Include a lightweight **Plan Fit** inspector panel inside the prototype mapping each UI control to its target implementation module.

3. **Verify Output**
   - Check that HTML, CSS, and JS have no syntax errors or broken selectors.
   - Confirm popovers clamp within viewport bounds and all themes maintain readable contrast across UI chrome, content, and overlays.
   - Provide a clickable `file://` link so the user can open and test immediately, and ask what adjustments they want before full build.
