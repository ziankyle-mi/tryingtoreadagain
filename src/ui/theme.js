import { FluidSpring } from "./motion.js";

/**
 * Theme & Typography Token Manager
 *
 * Manages day/night reading stocks, the Apple Books-style Appearance popover,
 * spring-animated segmented controls, and dynamic typography tokens.
 */

export const THEME_MODES = {
  ivory:   { label: "Vellum",   mode: "light", color: "#fffdf8" },
  antique: { label: "Sepia",    mode: "light", color: "#efe0c4" },
  sage:    { label: "Celadon",  mode: "light", color: "#cfe0d1" },
  ink:     { label: "Slate",    mode: "dark",  color: "#222732" },
  night:   { label: "Obsidian", mode: "dark",  color: "#0d0f12" }
};

function createSpringThumb(railEl, thumbEl) {
  const xSpring = new FluidSpring({ damping: 0.88, response: 0.28, precision: 0.2 });
  const wSpring = new FluidSpring({ damping: 0.92, response: 0.28, precision: 0.2 });
  let initialized = false;

  const update = () => {
    if (!thumbEl) return;
    thumbEl.style.transform = `translate3d(${xSpring.value}px, 0, 0)`;
    thumbEl.style.width = `${wSpring.value}px`;
  };
  xSpring.onUpdate = update;
  wSpring.onUpdate = update;

  return {
    moveTo(btnEl, immediate = false) {
      if (!btnEl || !railEl || !thumbEl) return;
      const railRect = railEl.getBoundingClientRect();
      const btnRect = btnEl.getBoundingClientRect();
      if (!btnRect.width) return;
      const padLeft = parseFloat(getComputedStyle(railEl).paddingLeft) || 0;
      const x = btnRect.left - railRect.left - padLeft;
      const w = btnRect.width;
      if (!initialized || immediate) {
        xSpring.snap(x);
        wSpring.snap(w);
        initialized = true;
      } else {
        xSpring.to(x);
        wSpring.to(w);
      }
    }
  };
}

export function createThemeManager({ state, savePrefs, $ }) {
  let lastDayTheme = "ivory";
  let lastNightTheme = "ink";
  let modeThumbCtrl = null;
  let popoverOpen = false;

  function ensureModeCtrl() {
    if (!modeThumbCtrl) {
      modeThumbCtrl = createSpringThumb($("appearanceModeRail"), $("appearanceModeThumb"));
    }
    return modeThumbCtrl;
  }

  function setPopoverOpen(open) {
    popoverOpen = Boolean(open);
    const popover = $("appearancePopover");
    const trigger = $("appearanceTrigger");
    if (popover) {
      popover.classList.toggle("open", popoverOpen);
      popover.setAttribute("aria-hidden", String(!popoverOpen));
      popover.inert = !popoverOpen;
    }
    if (trigger) {
      trigger.setAttribute("aria-expanded", String(popoverOpen));
    }
    if (popoverOpen) {
      const activeModeBtn = $("appearanceModeRail")?.querySelector(".spring-seg-btn.active");
      requestAnimationFrame(() => ensureModeCtrl().moveTo(activeModeBtn, true));
    }
  }

  function applyTheme(theme) {
    const validTheme = THEME_MODES[theme] ? theme : "ivory";
    const info = THEME_MODES[validTheme];
    const isDark = info.mode === "dark";
    if (isDark) lastNightTheme = validTheme;
    else lastDayTheme = validTheme;

    state.prefs.theme = validTheme;
    document.documentElement.setAttribute("data-theme", validTheme);

    const dotEl = $("appearanceDot");
    const labelEl = $("appearanceLabel");
    if (dotEl) dotEl.style.background = info.color;
    if (labelEl) labelEl.textContent = info.label;

    const modeRail = $("appearanceModeRail");
    if (modeRail) {
      let activeBtn = null;
      modeRail.querySelectorAll("[data-mode]").forEach((btn) => {
        const active = btn.dataset.mode === info.mode;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
        if (active) activeBtn = btn;
      });
      if (popoverOpen) {
        requestAnimationFrame(() => ensureModeCtrl().moveTo(activeBtn, false));
      }
    }

    const swatchGrid = $("appearanceSwatches");
    if (swatchGrid) {
      if (!swatchGrid.childElementCount) {
        Object.entries(THEME_MODES).forEach(([key, t]) => {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "swatch-item";
          item.dataset.themeKey = key;
          item.innerHTML = `<span class="swatch-disc" style="background:${t.color};"></span><span>${t.label}</span>`;
          item.onclick = () => applyTheme(key);
          swatchGrid.appendChild(item);
        });
      }
      swatchGrid.querySelectorAll(".swatch-item").forEach((item) => {
        const active = item.dataset.themeKey === validTheme;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", String(active));
      });
    }

    savePrefs(state.prefs);
    state.controller?.refreshThemeAndTypography?.();
  }

  function initControls() {
    const trigger = $("appearanceTrigger");
    const modeRail = $("appearanceModeRail");
    if (trigger) {
      trigger.onclick = (e) => {
        e.stopPropagation();
        setPopoverOpen(!popoverOpen);
      };
    }
    if (modeRail) {
      modeRail.querySelectorAll("[data-mode]").forEach((btn) => {
        btn.onclick = () => {
          const mode = btn.dataset.mode;
          applyTheme(mode === "dark" ? lastNightTheme : lastDayTheme);
        };
      });
    }
    setPopoverOpen(false);
  }

  function applyTypographyTokens() {
    document.documentElement.style.setProperty("--font-prose", state.prefs.fontFamily);
    document.documentElement.style.setProperty("--size-prose", `${state.prefs.fontSize}px`);
    document.documentElement.style.setProperty("--lh-prose", String(state.prefs.lineHeight));
  }

  return {
    applyTheme,
    initControls,
    closePopover: () => setPopoverOpen(false),
    isPopoverOpen: () => popoverOpen,
    applyTypographyTokens
  };
}
