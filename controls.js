// =====================================================================
// 입력 처리: PC(키보드/마우스, 포인터 잠금) + 모바일(가상 조이스틱, 드래그 시점, 버튼)
// =====================================================================

export class Controls {
  /**
   * @param {HTMLElement} surface 게임 화면 전체 레이어 (터치/마우스를 받는 영역)
   * @param {HTMLCanvasElement} canvas 포인터 잠금 대상
   * @param {object} ui { joyBase, joyKnob }
   */
  constructor(surface, canvas, ui) {
    this.surface = surface;
    this.canvas = canvas;
    this.ui = ui;
    this.enabled = false;
    this.keys = new Set();
    this.joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
    this.look = { id: null, lx: 0, ly: 0 };
    this.lookDX = 0;
    this.lookDY = 0;
    this.sensitivity = 1;
    this.isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.handlers = { capture: null, interact: null, number: null, escape: null };
    this.dragMouse = null;
    this.listeners = [];

    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this.listeners.push(() => target.removeEventListener(type, fn, opts));
    };

    // --- 키보드 ---
    on(window, 'keydown', (e) => {
      if (!this.enabled) return;
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      const k = e.code;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) {
        this.keys.add(k);
        e.preventDefault();
      }
      if (e.repeat) return; // 키를 누르고 있어도 연속 실행하지 않음
      if (k === 'KeyF') this.fire('capture');
      else if (k === 'KeyE') this.fire('interact');
      else if (k === 'Escape') this.fire('escape');
      else if (/^Digit[1-9]$/.test(k)) this.fire('number', Number(k.slice(5)));
    });
    on(window, 'keyup', (e) => this.keys.delete(e.code));
    on(window, 'blur', () => this.reset());

    // --- 마우스 (PC) ---
    // 마우스는 게임 레이어(캔버스 위 HUD 레이어)에서 받습니다.
    on(surface, 'mousedown', (e) => {
      if (!this.enabled || this.isTouch || this.isUiTarget(e.target)) return;
      if (document.pointerLockElement === canvas) {
        if (e.button === 0) this.fire('capture');
        return;
      }
      if (e.button === 0) {
        this.dragMouse = { x: e.clientX, y: e.clientY, moved: 0 };
      }
    });
    on(window, 'mousemove', (e) => {
      if (!this.enabled) return;
      if (document.pointerLockElement === canvas) {
        this.lookDX += e.movementX;
        this.lookDY += e.movementY;
      } else if (this.dragMouse) {
        const dx = e.clientX - this.dragMouse.x;
        const dy = e.clientY - this.dragMouse.y;
        this.dragMouse.x = e.clientX;
        this.dragMouse.y = e.clientY;
        this.dragMouse.moved += Math.abs(dx) + Math.abs(dy);
        this.lookDX += dx;
        this.lookDY += dy;
      }
    });
    on(window, 'mouseup', () => {
      if (this.dragMouse && this.dragMouse.moved < 4 && this.enabled && !this.isTouch) {
        // 짧은 클릭: 포인터 잠금 요청 (마우스로 시점 조작)
        this.requestLock();
      }
      this.dragMouse = null;
    });
    on(surface, 'contextmenu', (e) => e.preventDefault());

    // --- 터치 (모바일) ---
    const opts = { passive: false };
    on(surface, 'touchstart', (e) => this.onTouchStart(e), opts);
    on(surface, 'touchmove', (e) => this.onTouchMove(e), opts);
    on(surface, 'touchend', (e) => this.onTouchEnd(e), opts);
    on(surface, 'touchcancel', (e) => this.onTouchEnd(e), opts);
    // iOS 확대 제스처 방지
    on(document, 'gesturestart', (e) => e.preventDefault(), opts);
    on(document, 'dblclick', (e) => {
      if (this.enabled) e.preventDefault();
    }, opts);
  }

  on(name, fn) {
    this.handlers[name] = fn;
  }

  fire(name, arg) {
    const fn = this.handlers[name];
    if (fn) fn(arg);
  }

  requestLock() {
    if (this.isTouch || !this.canvas.requestPointerLock) return;
    try {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch {
      /* 일부 브라우저는 사용자 제스처 없이 거부 */
    }
  }

  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  setEnabled(v) {
    this.enabled = v;
    if (!v) {
      this.reset();
      this.releaseLock();
    }
  }

  reset() {
    this.keys.clear();
    this.joy.id = null;
    this.joy.x = 0;
    this.joy.y = 0;
    this.look.id = null;
    this.ui.joyBase.classList.remove('active');
  }

  isUiTarget(t) {
    return t && t.closest && t.closest('button, .panel, .modal, input, select, a, .no-game-touch');
  }

  onTouchStart(e) {
    if (!this.enabled) return;
    for (const t of e.changedTouches) {
      if (this.isUiTarget(t.target)) continue;
      e.preventDefault();
      const leftSide = t.clientX < window.innerWidth * 0.45;
      if (leftSide && this.joy.id === null) {
        this.joy.id = t.identifier;
        this.joy.ox = t.clientX;
        this.joy.oy = t.clientY;
        this.joy.x = 0;
        this.joy.y = 0;
        const b = this.ui.joyBase;
        b.style.left = `${t.clientX}px`;
        b.style.top = `${t.clientY}px`;
        b.classList.add('active');
        this.ui.joyKnob.style.transform = 'translate(-50%, -50%)';
      } else if (!leftSide && this.look.id === null) {
        this.look.id = t.identifier;
        this.look.lx = t.clientX;
        this.look.ly = t.clientY;
      }
    }
  }

  onTouchMove(e) {
    if (!this.enabled) return;
    for (const t of e.changedTouches) {
      if (t.identifier === this.joy.id) {
        e.preventDefault();
        const max = 56;
        let dx = t.clientX - this.joy.ox;
        let dy = t.clientY - this.joy.oy;
        const len = Math.hypot(dx, dy);
        if (len > max) {
          dx = (dx / len) * max;
          dy = (dy / len) * max;
        }
        this.joy.x = dx / max;
        this.joy.y = -dy / max;
        this.ui.joyKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      } else if (t.identifier === this.look.id) {
        e.preventDefault();
        this.lookDX += (t.clientX - this.look.lx) * 1.6;
        this.lookDY += (t.clientY - this.look.ly) * 1.6;
        this.look.lx = t.clientX;
        this.look.ly = t.clientY;
      }
    }
  }

  onTouchEnd(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === this.joy.id) {
        this.joy.id = null;
        this.joy.x = 0;
        this.joy.y = 0;
        this.ui.joyBase.classList.remove('active');
      } else if (t.identifier === this.look.id) {
        this.look.id = null;
      }
    }
  }

  /** 이동 입력: { x: 오른쪽(+), y: 앞(+) }, 길이 0~1 */
  getMove() {
    let x = 0;
    let y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    x += this.joy.x;
    y += this.joy.y;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    if (len < 0.12) return { x: 0, y: 0 };
    return { x, y };
  }

  /** 누적된 시점 회전량을 꺼내고 초기화 (라디안) */
  consumeLook() {
    const k = 0.0032 * this.sensitivity;
    const out = { dx: this.lookDX * k, dy: this.lookDY * k };
    this.lookDX = 0;
    this.lookDY = 0;
    return out;
  }

  dispose() {
    this.listeners.forEach((off) => off());
    this.listeners = [];
  }
}
