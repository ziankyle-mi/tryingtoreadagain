/**
 * Apple-style Fluid Motion & Gesture Primitives
 *
 * Implements designer-friendly spring physics (damping ratio + response),
 * interruptible velocity handoff, exponential momentum projection,
 * progressive rubber-banding, and 1:1 Pointer Events gesture tracking.
 */

export function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Apple's exponential-decay momentum projection (WWDC "Designing Fluid Interfaces").
 * Projects where a flick will land based on release velocity (px/s).
 */
export function projectMomentum(initialVelocityPxPerSec, decelerationRate = 0.998) {
  return ((initialVelocityPxPerSec / 1000) * decelerationRate) / (1 - decelerationRate);
}

/**
 * Progressive rubber-band resistance past a boundary.
 */
export function rubberband(overshoot, dimension, constant = 0.55) {
  if (!dimension) return 0;
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * Convert Apple's (dampingRatio, responseSeconds) into physical spring (stiffness, damping).
 * - dampingRatio = 1.0: critically damped (no overshoot, default UI)
 * - dampingRatio ~ 0.8: slight bounce for momentum/flick interactions
 */
function springParamsFromApple(damping = 1.0, response = 0.35) {
  const safeResponse = Math.max(0.05, response);
  const stiffness = Math.pow((2 * Math.PI) / safeResponse, 2);
  const dampingCoeff = (4 * Math.PI * damping) / safeResponse;
  return { stiffness, damping: dampingCoeff };
}

/**
 * Interruptible, velocity-preserving 1D spring.
 * Can be retargeted at any instant from its current on-screen value and velocity.
 */
export class FluidSpring {
  constructor({ value = 0, damping = 1.0, response = 0.35, precision = 0.001, onUpdate, onRest } = {}) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.damping = damping;
    this.response = response;
    this.precision = precision;
    this.onUpdate = onUpdate;
    this.onRest = onRest;
    this._raf = null;
    this._lastTime = 0;
  }

  setConfig({ damping, response } = {}) {
    if (typeof damping === "number") this.damping = damping;
    if (typeof response === "number") this.response = response;
  }

  /**
   * Immediately snap to a value (e.g. during 1:1 pointer drag) and cancel active flight.
   */
  snap(value) {
    this.stop();
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.onUpdate?.(this.value);
  }

  /**
   * Animate toward `target`, optionally inheriting/blending `initialVelocity` (units/s).
   * If already in flight, preserves current position and velocity unless overridden.
   */
  to(target, { velocity, damping, response } = {}) {
    if (typeof damping === "number") this.damping = damping;
    if (typeof response === "number") this.response = response;
    this.target = target;

    if (prefersReducedMotion()) {
      this.snap(target);
      this.onRest?.(this.value);
      return;
    }

    if (typeof velocity === "number") {
      this.velocity = velocity;
    }

    if (Math.abs(this.target - this.value) <= this.precision && Math.abs(this.velocity) <= this.precision) {
      this.snap(target);
      this.onRest?.(this.value);
      return;
    }

    if (!this._raf) {
      this._lastTime = performance.now();
      this._raf = requestAnimationFrame(this._tick);
    }
  }

  stop() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  _tick = (now) => {
    const rawDt = (now - this._lastTime) / 1000;
    this._lastTime = now;
    // Clamp dt to avoid large jumps on tab switch
    const dt = Math.min(Math.max(rawDt, 0.001), 0.032);

    const { stiffness, damping } = springParamsFromApple(this.damping, this.response);

    // Sub-step integration for numerical stability at any refresh rate
    const subSteps = 2;
    const h = dt / subSteps;
    for (let i = 0; i < subSteps; i++) {
      const displacement = this.value - this.target;
      const springForce = -stiffness * displacement;
      const dampingForce = -damping * this.velocity;
      const accel = springForce + dampingForce;
      this.velocity += accel * h;
      this.value += this.velocity * h;
    }

    this.onUpdate?.(this.value);

    const atRest =
      Math.abs(this.target - this.value) <= this.precision &&
      Math.abs(this.velocity) <= this.precision * 10;

    if (atRest) {
      this._raf = null;
      this.value = this.target;
      this.velocity = 0;
      this.onUpdate?.(this.value);
      this.onRest?.(this.value);
      return;
    }

    this._raf = requestAnimationFrame(this._tick);
  };
}

/**
 * Track recent pointer positions/timestamps to compute accurate release velocity (px/s).
 */
export class VelocityTracker {
  constructor(windowMs = 100) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  reset() {
    this.samples.length = 0;
  }

  add(x, y, time = performance.now()) {
    this.samples.push({ x, y, time });
    const cutoff = time - this.windowMs;
    while (this.samples.length > 2 && this.samples[0].time < cutoff) {
      this.samples.shift();
    }
  }

  getVelocity() {
    if (this.samples.length < 2) return { vx: 0, vy: 0 };
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.time - first.time) / 1000;
    if (dt <= 0.004) return { vx: 0, vy: 0 };
    return {
      vx: (last.x - first.x) / dt,
      vy: (last.y - first.y) / dt
    };
  }
}

/**
 * Attach a 1:1 horizontal swipe/drag gesture to an element (e.g. a slide-over drawer).
 * Supports grab-offset tracking, hysteresis, rubber-banding, momentum projection,
 * and interruptible spring velocity handoff.
 */
export function attachDrawerSwipe({
  element,
  side = "left", // "left" | "right"
  isOpen,
  onOpenChange,
  getWidth = () => element.getBoundingClientRect().width || 270
}) {
  if (!element) return () => {};

  const tracker = new VelocityTracker();
  let dragging = false;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startOffset = 0;
  let committed = false;
  let currentOffset = isOpen() ? 0 : side === "left" ? -getWidth() : getWidth();

  const spring = new FluidSpring({
    value: currentOffset,
    damping: 1.0,
    response: 0.32,
    precision: 0.5,
    onUpdate: (val) => {
      currentOffset = val;
      element.style.transform = `translate3d(${val}px, 0, 0)`;
    },
    onRest: (val) => {
      if (Math.abs(val) < 0.5) {
        element.style.transform = "";
      }
    }
  });

  const onPointerDown = (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (e.target.closest("button, a, input, select, textarea")) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startOffset = currentOffset;
    committed = false;
    dragging = true;
    tracker.reset();
    tracker.add(e.clientX, e.clientY);
    // Interrupt any active spring immediately on grab
    spring.stop();
  };

  const onPointerMove = (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!committed) {
      // ~10px hysteresis before locking horizontal drag
      if (Math.hypot(dx, dy) < 10) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.15) {
        dragging = false;
        return;
      }
      committed = true;
      element.setPointerCapture?.(e.pointerId);
    }

    tracker.add(e.clientX, e.clientY);
    const width = getWidth();
    const raw = startOffset + dx;

    let next = raw;
    if (side === "left") {
      if (raw > 0) next = rubberband(raw, width * 0.35);
      else if (raw < -width) next = -width + rubberband(raw + width, width * 0.35);
    } else {
      if (raw < 0) next = rubberband(raw, width * 0.35);
      else if (raw > width) next = width + rubberband(raw - width, width * 0.35);
    }

    currentOffset = next;
    element.style.transform = `translate3d(${next}px, 0, 0)`;
  };

  const finishDrag = (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    if (!committed) return;

    const { vx } = tracker.getVelocity();
    const width = getWidth();
    const projected = currentOffset + projectMomentum(vx, 0.996);

    const shouldOpen = side === "left" ? projected > -width * 0.5 : projected < width * 0.5;
    const target = shouldOpen ? 0 : side === "left" ? -width : width;

    // Slight bounce only when user flicked with real momentum
    const hasMomentum = Math.abs(vx) > 350;
    spring.to(target, {
      velocity: vx,
      damping: hasMomentum ? 0.86 : 1.0,
      response: 0.32
    });

    if (shouldOpen !== isOpen()) {
      onOpenChange?.(shouldOpen);
    }
  };

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", finishDrag);
  element.addEventListener("pointercancel", finishDrag);

  return {
    spring,
    syncOpen(open) {
      const width = getWidth();
      const target = open ? 0 : side === "left" ? -width : width;
      spring.to(target, { damping: 1.0, response: 0.32 });
    },
    destroy() {
      spring.stop();
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", finishDrag);
      element.removeEventListener("pointercancel", finishDrag);
    }
  };
}
