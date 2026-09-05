// Input: keyboard, mouse look under pointer lock, and gamepad.
//
// Actions are named, not keyed, so rebinding is just editing a list of
// KeyboardEvent.code values. Look deltas accumulate between frames and are
// drained by the camera, which keeps mouse input frame-rate independent
// without smearing it across frames.

import { clamp } from './util.js';

/** Human-readable label for a KeyboardEvent.code. */
export function keyLabel(code) {
  if (!code) return '--';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return `${code.slice(5)} Arrow`;
  const named = {
    Space: 'Space', Escape: 'Esc', ShiftLeft: 'L Shift', ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt',
    Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace', CapsLock: 'Caps',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  };
  return named[code] || code;
}

export class Input {
  constructor(settings, canvas) {
    this.settings = settings;
    this.canvas = canvas;

    this.down = new Set();          // codes currently held
    this.pressedThisFrame = new Set();
    this.releasedThisFrame = new Set();

    this.lookX = 0;                 // accumulated, drained each frame
    this.lookY = 0;
    this.wheel = 0;
    this.pointerLocked = false;
    this.enabled = false;           // only true while actually playing

    this.mouseButtons = new Set();
    // Mouse presses as edges rather than state. Voxel mode mines on hold and
    // places on press, and telling those apart needs the frame the button
    // went down, not just that it is down.
    this.mouseButtonsPressed = new Set();
    this.dragLooking = false;       // click-drag fallback when pointer lock fails
    this.gamepadIndex = null;
    this.gamepadState = { lx: 0, ly: 0, rx: 0, ry: 0, buttons: [] };
    this.prevGamepadButtons = [];

    // Toggle latches, for players who prefer toggle sprint/crouch.
    this.sprintLatched = false;
    this.crouchLatched = false;

    this.onPointerLockChange = null;
    this.captureNext = null;        // set while the rebinding UI is listening

    this.bind();
  }

  bind() {
    this._keyDown = (e) => {
      if (this.captureNext) {
        e.preventDefault();
        const fn = this.captureNext;
        this.captureNext = null;
        fn(e.code);
        return;
      }
      // Let the browser have its own shortcuts.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!this.down.has(e.code)) this.pressedThisFrame.add(e.code);
      this.down.add(e.code);
      if (this.enabled && this.consumesKey(e.code)) e.preventDefault();
    };
    this._keyUp = (e) => {
      this.down.delete(e.code);
      this.releasedThisFrame.add(e.code);
    };
    this._blur = () => {
      // Never leave a key stuck down when the window loses focus.
      this.down.clear();
      this.mouseButtons.clear();
      this.mouseButtonsPressed.clear();
      this.dragLooking = false;
      this.lookX = this.lookY = 0;
    };
    this._mouseMove = (e) => {
      if (!this.enabled) return;
      // Pointer lock is the good path, but it can be refused outright - an
      // embedded frame, a browser policy, a user who dismissed the prompt - and
      // without a fallback that leaves the player unable to look at all. So a
      // held left button drags the view instead.
      if (!this.pointerLocked && !this.dragLooking) return;
      const s = this.settings.controls;
      const inv = s.invertY ? -1 : 1;
      // movementX/Y is only meaningful under pointer lock; when dragging we
      // difference the client position ourselves.
      let dx, dy;
      if (this.pointerLocked) {
        dx = e.movementX || 0;
        dy = e.movementY || 0;
      } else {
        dx = e.clientX - this._dragX;
        dy = e.clientY - this._dragY;
        this._dragX = e.clientX;
        this._dragY = e.clientY;
      }
      this.lookX += dx * s.mouseSensitivity;
      this.lookY += dy * s.mouseSensitivity * inv;
    };
    this._mouseDown = (e) => {
      if (!this.mouseButtons.has(e.button)) this.mouseButtonsPressed.add(e.button);
      this.mouseButtons.add(e.button);
      if (e.button === 0 && this.enabled && !this.pointerLocked) {
        this.dragLooking = true;
        this._dragX = e.clientX;
        this._dragY = e.clientY;
      }
    };
    this._mouseUp = (e) => {
      this.mouseButtons.delete(e.button);
      if (e.button === 0) this.dragLooking = false;
    };
    this._wheel = (e) => { if (this.enabled) this.wheel += Math.sign(e.deltaY); };
    this._lockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) { this.lookX = this.lookY = 0; }
      if (this.onPointerLockChange) this.onPointerLockChange(this.pointerLocked);
    };
    this._gamepadConnected = (e) => { this.gamepadIndex = e.gamepad.index; };
    this._gamepadDisconnected = (e) => {
      if (this.gamepadIndex === e.gamepad.index) this.gamepadIndex = null;
    };

    window.addEventListener('keydown', this._keyDown, { passive: false });
    window.addEventListener('keyup', this._keyUp);
    window.addEventListener('blur', this._blur);
    document.addEventListener('mousemove', this._mouseMove);
    document.addEventListener('mousedown', this._mouseDown);
    document.addEventListener('mouseup', this._mouseUp);
    document.addEventListener('wheel', this._wheel, { passive: true });
    document.addEventListener('pointerlockchange', this._lockChange);
    window.addEventListener('gamepadconnected', this._gamepadConnected);
    window.addEventListener('gamepaddisconnected', this._gamepadDisconnected);
  }

  dispose() {
    window.removeEventListener('keydown', this._keyDown);
    window.removeEventListener('keyup', this._keyUp);
    window.removeEventListener('blur', this._blur);
    document.removeEventListener('mousemove', this._mouseMove);
    document.removeEventListener('mousedown', this._mouseDown);
    document.removeEventListener('mouseup', this._mouseUp);
    document.removeEventListener('wheel', this._wheel);
    document.removeEventListener('pointerlockchange', this._lockChange);
    window.removeEventListener('gamepadconnected', this._gamepadConnected);
    window.removeEventListener('gamepaddisconnected', this._gamepadDisconnected);
  }

  /** Is this code bound to anything? Used to decide whether to preventDefault. */
  consumesKey(code) {
    for (const action in this.settings.bindings) {
      if (this.settings.bindings[action].includes(code)) return true;
    }
    return false;
  }

  /**
   * Ask for pointer lock, tolerating every way it can fail.
   *
   * Chrome returns a promise when given options; other engines return
   * undefined. Either can reject or throw outright - an embedded frame, a
   * missing user gesture, a browser that simply refuses - and none of those
   * should surface as an unhandled rejection or stop the game.
   */
  requestPointerLock() {
    if (!this.canvas || document.pointerLockElement === this.canvas) return;
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          try {
            const q = this.canvas.requestPointerLock();
            if (q && typeof q.catch === 'function') q.catch(() => {});
          } catch (e) { /* refused; the player can still use the menus */ }
        });
      }
    } catch (e) { /* refused */ }
  }

  exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Can the player currently turn the camera? */
  get canLook() { return this.pointerLocked || this.dragLooking; }

  /**
   * Enable or disable input, clearing any held keys on the way out so a key
   * held while opening a menu does not resume as a stuck input afterwards.
   */
  setEnabled(on) {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) {
      this.down.clear();
      this.mouseButtons.clear();
      this.dragLooking = false;
      this.lookX = this.lookY = 0;
      this.sprintLatched = false;
      this.crouchLatched = false;
    }
  }

  /** Is any key bound to `action` currently held? */
  isDown(action) {
    const codes = this.settings.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  /** Did `action` go down since the last frame? */
  wasPressed(action) {
    const codes = this.settings.bindings[action];
    if (!codes) return false;
    for (const c of codes) if (this.pressedThisFrame.has(c)) return true;
    return false;
  }

  /**
   * Movement intent as a unit-ish vector: x is strafe (+right), y is forward.
   * Keyboard and left stick are merged so either works at any time.
   */
  moveVector() {
    let x = 0, y = 0;
    if (this.isDown('forward')) y += 1;
    if (this.isDown('back')) y -= 1;
    if (this.isDown('right')) x += 1;
    if (this.isDown('left')) x -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }

    if (this.settings.controls.gamepadEnabled && this.gamepadIndex !== null) {
      const gx = this.gamepadState.lx, gy = -this.gamepadState.ly;
      if (Math.hypot(gx, gy) > Math.hypot(x, y)) { x = gx; y = gy; }
    }
    return { x, y };
  }

  /** Sprint state, honouring the toggle-vs-hold preference. */
  isSprinting() {
    if (this.settings.controls.toggleSprint) {
      if (this.wasPressed('sprint')) this.sprintLatched = !this.sprintLatched;
      return this.sprintLatched;
    }
    return this.isDown('sprint') || this.gamepadButton(10);
  }

  isCrouching() {
    if (this.settings.controls.toggleCrouch) {
      if (this.wasPressed('crouch')) this.crouchLatched = !this.crouchLatched;
      return this.crouchLatched;
    }
    return this.isDown('crouch') || this.gamepadButton(11);
  }

  gamepadButton(index) {
    return !!(this.gamepadState.buttons[index] && this.gamepadState.buttons[index].pressed);
  }

  gamepadPressed(index) {
    const now = this.gamepadButton(index);
    const before = this.prevGamepadButtons[index];
    return now && !before;
  }

  /** Poll the gamepad and fold its look stick into the accumulated look delta. */
  pollGamepad(dt) {
    if (!this.settings.controls.gamepadEnabled) return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = this.gamepadIndex !== null ? pads[this.gamepadIndex] : null;
    if (!pad) {
      for (const p of pads) if (p && p.connected) { pad = p; this.gamepadIndex = p.index; break; }
    }
    if (!pad) { this.gamepadState.buttons = []; return; }

    const dz = this.settings.controls.gamepadDeadzone;
    const apply = (v) => {
      const a = Math.abs(v);
      if (a < dz) return 0;
      // Rescale past the deadzone so the stick still reaches full travel.
      return Math.sign(v) * ((a - dz) / (1 - dz)) ** 1.6;
    };
    this.gamepadState.lx = apply(pad.axes[0] || 0);
    this.gamepadState.ly = apply(pad.axes[1] || 0);
    this.gamepadState.rx = apply(pad.axes[2] || 0);
    this.gamepadState.ry = apply(pad.axes[3] || 0);
    this.prevGamepadButtons = this.gamepadState.buttons.map((b) => b && b.pressed);
    this.gamepadState.buttons = pad.buttons || [];

    if (this.enabled) {
      const s = this.settings.controls;
      const inv = s.invertY ? -1 : 1;
      this.lookX += this.gamepadState.rx * s.gamepadSensitivity * dt;
      this.lookY += this.gamepadState.ry * s.gamepadSensitivity * dt * inv;
    }
  }

  /** Take the accumulated look delta and reset it. */
  drainLook() {
    const out = { x: this.lookX, y: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return out;
  }

  /** Call at the end of every frame. */
  endFrame() {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.mouseButtonsPressed.clear();
    this.wheel = 0;
  }

  /** Is a mouse button held? 0 left, 1 middle, 2 right. */
  mouseDown(button) { return this.mouseButtons.has(button); }

  /** Did a mouse button go down this frame? */
  mouseWasPressed(button) { return this.mouseButtonsPressed.has(button); }

  /** Ask the rebinding UI for the next key pressed. */
  captureKey(callback) { this.captureNext = callback; }
  cancelCapture() { this.captureNext = null; }
}
