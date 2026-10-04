export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Bounds {
  width: number;
  height: number;
}

/** A draggable, aspect-locked crop rectangle rendered over a preview canvas. Coordinates are in the container's CSS pixel space. */
export class CropBox {
  private rect: Rect;
  private bounds: Bounds;
  private readonly aspect: number;
  private dragMode: "move" | "resize" | null = null;
  private dragStart = { x: 0, y: 0 };
  private dragStartRect: Rect;

  constructor(
    private readonly boxEl: HTMLElement,
    private readonly handleEl: HTMLElement,
    bounds: Bounds,
    aspect: number,
    private onChange?: (rect: Rect) => void,
  ) {
    this.bounds = bounds;
    this.aspect = aspect;
    this.rect = this.centeredRect(bounds);
    this.dragStartRect = { ...this.rect };
    this.render();
    this.attachHandlers();
  }

  setBounds(bounds: Bounds): void {
    this.bounds = bounds;
    this.rect = this.centeredRect(bounds);
    this.render();
    this.onChange?.(this.getRect());
  }

  getRect(): Rect {
    return { ...this.rect };
  }

  private centeredRect(bounds: Bounds): Rect {
    let height = Math.min(bounds.height, bounds.width / this.aspect);
    let width = height * this.aspect;
    if (width > bounds.width) {
      width = bounds.width;
      height = width / this.aspect;
    }
    return {
      x: (bounds.width - width) / 2,
      y: (bounds.height - height) / 2,
      width,
      height,
    };
  }

  private clampToBounds(): void {
    const { bounds } = this;
    if (this.rect.width > bounds.width) {
      this.rect.width = bounds.width;
      this.rect.height = this.rect.width / this.aspect;
    }
    if (this.rect.height > bounds.height) {
      this.rect.height = bounds.height;
      this.rect.width = this.rect.height * this.aspect;
    }
    this.rect.x = Math.min(Math.max(this.rect.x, 0), bounds.width - this.rect.width);
    this.rect.y = Math.min(Math.max(this.rect.y, 0), bounds.height - this.rect.height);
  }

  private render(): void {
    this.boxEl.style.left = `${this.rect.x}px`;
    this.boxEl.style.top = `${this.rect.y}px`;
    this.boxEl.style.width = `${this.rect.width}px`;
    this.boxEl.style.height = `${this.rect.height}px`;
  }

  private attachHandlers(): void {
    const startDrag = (mode: "move" | "resize") => (event: PointerEvent) => {
      this.dragMode = mode;
      this.dragStart = { x: event.clientX, y: event.clientY };
      this.dragStartRect = { ...this.rect };
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    };

    this.boxEl.addEventListener("pointerdown", startDrag("move"));
    this.handleEl.addEventListener("pointerdown", startDrag("resize"));

    window.addEventListener("pointermove", (event) => {
      if (!this.dragMode) return;
      const dx = event.clientX - this.dragStart.x;
      const dy = event.clientY - this.dragStart.y;

      if (this.dragMode === "move") {
        this.rect.x = this.dragStartRect.x + dx;
        this.rect.y = this.dragStartRect.y + dy;
      } else {
        const minWidth = 24 * this.aspect;
        const width = Math.max(minWidth, this.dragStartRect.width + dx);
        this.rect.x = this.dragStartRect.x;
        this.rect.y = this.dragStartRect.y;
        this.rect.width = width;
        this.rect.height = width / this.aspect;
      }

      this.clampToBounds();
      this.render();
      this.onChange?.(this.getRect());
    });

    window.addEventListener("pointerup", () => {
      this.dragMode = null;
    });
  }
}
