/**
 * Konva-доска: слои, объекты, курсоры, выделение и перемещение.
 * Координаты объектов — мировые на логической доске (например 1600×900).
 */

const FONT_FAMILY = 'Inter, "Segoe UI", Roboto, Arial, sans-serif';
export const FONT_STACKS = {
  sans: FONT_FAMILY,
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'Consolas, "Courier New", monospace',
  hand: '"Segoe Script", "Comic Sans MS", cursive',
  narrow: '"Arial Narrow", "Liberation Sans Narrow", sans-serif',
};
export function fontStack(fontFamily) {
  return FONT_STACKS[fontFamily] ?? FONT_STACKS.sans;
}
const MIN_SCALE = 0.1;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const PAN_KEEP_RATIO = 0.25;
const FLOW_SHAPES = new Set(['process', 'decision', 'terminator']);
const LOCK_BADGE = '🔒';
const LOCK_BADGE_SIZE = 14;
const CURSOR_DARK_INK = '#0f172a';
const CURSOR_LIGHT_INK = '#ffffff';
// Relative luminance threshold where black and white have equal WCAG contrast.
const CURSOR_INK_THRESHOLD = 0.179;

export function cursorInk(color) {
  const match = /^#([0-9a-f]{6})$/i.exec(color ?? '');
  if (!match) return CURSOR_LIGHT_INK;
  const channels = [0, 2, 4].map((offset) => {
    const channel = parseInt(match[1].slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > CURSOR_INK_THRESHOLD ? CURSOR_DARK_INK : CURSOR_LIGHT_INK;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function normalizeRotation(value) {
  const normalized = ((((value + 180) % 360) + 360) % 360) - 180;
  return round(normalized);
}

export class Board {
  constructor(container, options = {}) {
    this.container = container;
    this.width = options.width ?? 1600;
    this.height = options.height ?? 900;
    this.onObjectMove = options.onObjectMove ?? (() => {});
    this.onObjectTransform = options.onObjectTransform ?? (() => {});
    this.onEditText = options.onEditText ?? (() => {});
    this.editPredicate = options.canEditObject ?? (() => false);
    this.deletePredicate = options.canDeleteObject ?? this.editPredicate;
    this.onFrameMove = options.onFrameMove ?? (() => {});
    this.onSelectObject = options.onSelectObject ?? (() => {});

    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.selectMode = false;
    this.selectedId = null;
    this.destroyed = false;

    this.stage = new Konva.Stage({
      container,
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight),
    });

    this.backgroundLayer = new Konva.Layer({ listening: false });
    this.contentLayer = new Konva.Layer();
    this.overlayLayer = new Konva.Layer({ listening: false });
    this.stage.add(this.backgroundLayer, this.contentLayer, this.overlayLayer);

    this.paper = new Konva.Rect({
      x: 0,
      y: 0,
      width: this.width,
      height: this.height,
      fill: '#ffffff',
      shadowColor: 'rgba(15, 23, 42, 0.20)',
      shadowBlur: 24,
      shadowOffset: { x: 0, y: 10 },
      listening: false,
    });
    this.grid = new Konva.Shape({
      x: 0,
      y: 0,
      width: this.width,
      height: this.height,
      listening: false,
      perfectDrawEnabled: false,
      sceneFunc: (ctx) => {
        ctx.beginPath();
        const step = 32;
        for (let x = step; x < this.width; x += step) {
          for (let y = step; y < this.height; y += step) {
            ctx.moveTo(x + 1.4, y);
            ctx.arc(x, y, 1.4, 0, Math.PI * 2);
          }
        }
        ctx.fillStyle = '#d3dcea';
        ctx.fill();
      },
    });
    this.backgroundLayer.add(this.paper, this.grid);

    this.transformer = new Konva.Transformer({
      nodes: [],
      resizeEnabled: true,
      rotateEnabled: true,
      borderStroke: '#2563eb',
      borderStrokeWidth: 1.5,
      borderDash: [6, 4],
      padding: 6,
      anchorSize: 10,
      anchorCornerRadius: 3,
      anchorStroke: '#2563eb',
      anchorFill: '#ffffff',
      rotateAnchorOffset: 26,
      ignoreStroke: true,
      boundBoxFunc: (oldBox, newBox) => {
        if (Math.abs(newBox.width) < 6 || Math.abs(newBox.height) < 6) return oldBox;
        return newBox;
      },
    });
    this.contentLayer.add(this.transformer);

    this.objects = new Map();
    this.cursors = new Map();
    this.slideImage = null;
    this.slideToken = 0;
    this.fitScale = 1;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.onViewChange = options.onViewChange ?? (() => {});
    this.onGestureStart = options.onGestureStart ?? (() => {});
    this.pointers = new Map();
    this.gesture = null;

    this._onWindowResize = () => this.layout();
    window.addEventListener('resize', this._onWindowResize);
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(container);

    this._onPointerDown = (event) => this._trackPointerDown(event);
    this._onPointerMove = (event) => this._trackPointerMove(event);
    this._onPointerUp = (event) => this._trackPointerUp(event);
    this._onWheel = (event) => this._handleWheel(event);
    container.addEventListener('pointerdown', this._onPointerDown);
    container.addEventListener('pointermove', this._onPointerMove);
    container.addEventListener('pointerup', this._onPointerUp);
    container.addEventListener('pointercancel', this._onPointerUp);
    container.addEventListener('wheel', this._onWheel, { passive: false });

    this.stage.on('pointerdown', (event) => this._handleStagePointerDown(event));
    this.stage.on('dblclick dbltap', (event) => this._handleStageDoubleClick(event));
    this.fit();
  }

  // ------------------------------------------------------------------ viewport

  fit() {
    this.resetView();
  }

  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.layout();
  }

  layout() {
    if (this.destroyed) return;
    const containerWidth = Math.max(1, this.container.clientWidth);
    const containerHeight = Math.max(1, this.container.clientHeight);
    this.fitScale = Math.max(
      MIN_SCALE,
      Math.min(containerWidth / this.width, containerHeight / this.height),
    );
    this._clampView(containerWidth, containerHeight);
    this._applyView(containerWidth, containerHeight);
  }

  _applyView(containerWidth, containerHeight) {
    const scale = this.fitScale * this.zoom;
    this.scale = scale;
    this.offsetX = (containerWidth - this.width * scale) / 2 + this.panX;
    this.offsetY = (containerHeight - this.height * scale) / 2 + this.panY;
    this.stage.size({ width: containerWidth, height: containerHeight });
    this.stage.scale({ x: scale, y: scale });
    this.stage.position({ x: this.offsetX, y: this.offsetY });
    this.stage.batchDraw();
    this.onViewChange(this.getZoomPercent());
  }

  _clampView(containerWidth, containerHeight) {
    if (this.zoom <= 1) {
      this.panX = 0;
      this.panY = 0;
      return;
    }
    const scale = this.fitScale * this.zoom;
    const boardWidth = this.width * scale;
    const boardHeight = this.height * scale;
    const baseX = (containerWidth - boardWidth) / 2;
    const baseY = (containerHeight - boardHeight) / 2;
    this.panX = clamp(
      this.panX,
      PAN_KEEP_RATIO * containerWidth - baseX - boardWidth,
      (1 - PAN_KEEP_RATIO) * containerWidth - baseX,
    );
    this.panY = clamp(
      this.panY,
      PAN_KEEP_RATIO * containerHeight - baseY - boardHeight,
      (1 - PAN_KEEP_RATIO) * containerHeight - baseY,
    );
  }

  getZoomPercent() {
    return Math.round(this.zoom * 100);
  }

  setZoom(zoom, anchor = null) {
    const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    if (next === this.zoom) return;
    const containerWidth = Math.max(1, this.container.clientWidth);
    const containerHeight = Math.max(1, this.container.clientHeight);
    const world = anchor
      ? {
          x: (anchor.x - this.offsetX) / this.scale,
          y: (anchor.y - this.offsetY) / this.scale,
        }
      : null;
    this.zoom = next;
    if (world) {
      const scale = this.fitScale * next;
      this.panX = anchor.x - world.x * scale - (containerWidth - this.width * scale) / 2;
      this.panY =
        anchor.y - world.y * scale - (containerHeight - this.height * scale) / 2;
    }
    this._clampView(containerWidth, containerHeight);
    this._applyView(containerWidth, containerHeight);
  }

  zoomAt(factor, anchor = null) {
    this.setZoom(this.zoom * factor, anchor);
  }

  panBy(dx, dy) {
    if (this.zoom <= 1) return;
    const containerWidth = Math.max(1, this.container.clientWidth);
    const containerHeight = Math.max(1, this.container.clientHeight);
    this.panX += dx;
    this.panY += dy;
    this._clampView(containerWidth, containerHeight);
    this._applyView(containerWidth, containerHeight);
  }

  _pointerPoint(event) {
    const rect = this.container.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  isGesturing() {
    return Boolean(this.gesture);
  }

  _trackPointerDown(event) {
    if (event.pointerType !== 'touch') return;
    this.pointers.set(event.pointerId, this._pointerPoint(event));
    if (this.pointers.size === 2) this._startGesture();
  }

  _startGesture() {
    const [first, second] = [...this.pointers.values()];
    const mid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    this.gesture = {
      startZoom: this.zoom,
      startDistance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
      world: {
        x: (mid.x - this.offsetX) / this.scale,
        y: (mid.y - this.offsetY) / this.scale,
      },
    };
    this.onGestureStart();
  }

  _trackPointerMove(event) {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, this._pointerPoint(event));
    if (this.pointers.size < 2 || !this.gesture) return;
    const [first, second] = [...this.pointers.values()];
    const mid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    const distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
    const containerWidth = Math.max(1, this.container.clientWidth);
    const containerHeight = Math.max(1, this.container.clientHeight);
    this.zoom = clamp(
      this.gesture.startZoom * (distance / this.gesture.startDistance),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    const scale = this.fitScale * this.zoom;
    this.panX =
      mid.x - this.gesture.world.x * scale - (containerWidth - this.width * scale) / 2;
    this.panY =
      mid.y - this.gesture.world.y * scale - (containerHeight - this.height * scale) / 2;
    this._clampView(containerWidth, containerHeight);
    this._applyView(containerWidth, containerHeight);
  }

  _trackPointerUp(event) {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.gesture = null;
  }

  _handleWheel(event) {
    event.preventDefault();
    const point = this._pointerPoint(event);
    if (event.ctrlKey || event.metaKey) {
      this.zoomAt(Math.exp(-event.deltaY * 0.0015), point);
      return;
    }
    const dx = event.shiftKey ? -event.deltaY : -event.deltaX;
    const dy = event.shiftKey ? 0 : -event.deltaY;
    this.panBy(dx, dy);
  }

  setBoardSize(width, height) {
    if (!width || !height || (width === this.width && height === this.height)) return;
    this.width = width;
    this.height = height;
    this.paper.size({ width, height });
    this.grid.size({ width, height });
    this.fit();
  }

  clearPresentationSlide() {
    this.slideToken += 1;
    this.slideImage?.destroy();
    this.slideImage = null;
    this.grid.visible(true);
    this.backgroundLayer.batchDraw();
  }

  async setPresentationSlide(url) {
    const token = ++this.slideToken;
    this.slideImage?.destroy();
    this.slideImage = null;
    if (!url) {
      this.grid.visible(true);
      this.backgroundLayer.batchDraw();
      return;
    }

    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Не удалось открыть слайд'));
      image.src = url;
    });
    if (token !== this.slideToken || this.destroyed) return;

    const scale = Math.min(
      this.width / Math.max(image.naturalWidth, 1),
      this.height / Math.max(image.naturalHeight, 1),
    );
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    const node = new Konva.Image({
      name: 'slide-bg',
      image,
      x: (this.width - width) / 2,
      y: (this.height - height) / 2,
      width,
      height,
      listening: false,
    });
    this.backgroundLayer.add(node);
    node.moveToTop();
    this.slideImage = node;
    this.grid.visible(false);
    this.backgroundLayer.batchDraw();
  }

  async exportCanvas() {
    const images = [];
    for (const entry of this.objects.values()) {
      const image = entry.node.findOne?.('Image')?.image?.();
      if (image?.decode) images.push(image.decode().catch(() => {}));
    }
    await Promise.all(images);

    const stage = this.stage;
    const saved = {
      width: stage.width(),
      height: stage.height(),
      scaleX: stage.scaleX(),
      scaleY: stage.scaleY(),
      x: stage.x(),
      y: stage.y(),
      overlay: this.overlayLayer.visible(),
      transformer: this.transformer.visible(),
      grid: this.grid.visible(),
      shadow: this.paper.shadowEnabled(),
    };
    const badges = [];
    for (const entry of this.objects.values()) {
      const badge = entry.node.findOne?.('.lock-badge');
      if (badge) {
        badges.push([badge, badge.visible()]);
        badge.visible(false);
      }
    }

    try {
      this.overlayLayer.visible(false);
      this.transformer.visible(false);
      this.grid.visible(false);
      this.paper.shadowEnabled(false);
      stage.size({ width: this.width, height: this.height });
      stage.scale({ x: 1, y: 1 });
      stage.position({ x: 0, y: 0 });
      stage.draw();
      return stage.toCanvas({ pixelRatio: 2 });
    } finally {
      for (const [badge, visible] of badges) badge.visible(visible);
      this.overlayLayer.visible(saved.overlay);
      this.transformer.visible(saved.transformer);
      this.grid.visible(saved.grid);
      this.paper.shadowEnabled(saved.shadow);
      stage.size({ width: saved.width, height: saved.height });
      stage.scale({ x: saved.scaleX, y: saved.scaleY });
      stage.position({ x: saved.x, y: saved.y });
      stage.draw();
    }
  }

  getPointer() {
    const pointer = this.stage.getRelativePointerPosition();
    if (!pointer) return null;
    return {
      x: clamp(pointer.x, 0, this.width),
      y: clamp(pointer.y, 0, this.height),
    };
  }

  toScreen(point) {
    return {
      x: this.offsetX + point.x * this.scale,
      y: this.offsetY + point.y * this.scale,
    };
  }

  // ------------------------------------------------------------------- objects

  addObject(object) {
    if (!object || !object.id || this.objects.has(object.id) || this.destroyed) return null;

    let node;
    switch (object.type) {
      case 'stroke':
        node = this._createStrokeNode(object);
        break;
      case 'shape':
        node = this._createShapeNode(object);
        break;
      case 'text':
        node = this._createTextNode(object);
        break;
      case 'image':
        node = this._createImageNode(object);
        break;
      case 'connector':
        node = this._createConnectorNode(object);
        break;
      case 'frame':
        node = this._createFrameNode(object);
        break;
      default:
        return null;
    }
    if (!node) return null;

    node.id(object.id);
    this.contentLayer.add(node);
    if (object.type === 'frame') node.moveToBottom();
    else node.moveToTop();
    this.transformer.moveToTop();

    const entry = { data: { ...object }, node };
    if (object.type === 'stroke') {
      entry.points = [...(object.points ?? [])];
    }
    this.objects.set(object.id, entry);
    if (object.type === 'frame') {
      this._captureLocally(entry.data);
    } else if (entry.data.frameId === undefined) {
      entry.data.frameId = this._frameFor(entry.data);
    }
    this._applyDraggable(entry);
    this._bindTransform(entry);
    this._applyLockBadge(entry);
    return node;
  }

  _createStrokeNode(object) {
    const points = (object.points ?? []).flat();
    if (points.length < 2) return null;
    const isEraser = object.tool === 'eraser';
    return new Konva.Line({
      points,
      stroke: object.color,
      strokeWidth: object.width,
      lineCap: 'round',
      lineJoin: 'round',
      perfectDrawEnabled: false,
      listening: !isEraser,
      globalCompositeOperation: isEraser ? 'destination-out' : 'source-over',
    });
  }

  _createShapeNode(object) {
    const { shapeType, x, y, width, height, color, strokeWidth } = object;
    const fill = object.fill || undefined;
    const group = new Konva.Group({ x, y, rotation: object.rotation || 0 });
    const absWidth = Math.abs(width);
    const absHeight = Math.abs(height);
    let shape;
    if (shapeType === 'rect' || shapeType === 'process') {
      shape = new Konva.Rect({
        x: 0,
        y: 0,
        width: absWidth,
        height: absHeight,
        stroke: color,
        strokeWidth,
        fill,
        cornerRadius: 2,
      });
    } else if (shapeType === 'circle') {
      shape = new Konva.Ellipse({
        x: width / 2,
        y: height / 2,
        radiusX: Math.abs(width) / 2,
        radiusY: Math.abs(height) / 2,
        stroke: color,
        strokeWidth,
        fill,
      });
    } else if (shapeType === 'arrow') {
      shape = new Konva.Arrow({
        points: [0, 0, width, height],
        stroke: color,
        fill: color,
        strokeWidth,
        pointerLength: Math.max(8, strokeWidth * 3),
        pointerWidth: Math.max(8, strokeWidth * 3),
        lineCap: 'round',
      });
    } else if (shapeType === 'decision') {
      shape = new Konva.Line({
        points: [
          absWidth / 2,
          0,
          absWidth,
          absHeight / 2,
          absWidth / 2,
          absHeight,
          0,
          absHeight / 2,
        ],
        closed: true,
        stroke: color,
        strokeWidth,
        fill,
      });
    } else if (shapeType === 'terminator') {
      shape = new Konva.Rect({
        x: 0,
        y: 0,
        width: absWidth,
        height: absHeight,
        stroke: color,
        strokeWidth,
        fill,
        cornerRadius: Math.min(absWidth, absHeight) / 2,
      });
    } else if (shapeType === 'frame') {
      shape = new Konva.Rect({
        x: 0,
        y: 0,
        width: absWidth,
        height: absHeight,
        stroke: color,
        strokeWidth,
        dash: [6, 4],
        fill: 'rgba(148, 163, 184, 0.08)',
      });
    } else {
      shape = new Konva.Line({
        points: [0, 0, width, height],
        stroke: color,
        strokeWidth,
        lineCap: 'round',
      });
    }
    group.add(shape);
    if (FLOW_SHAPES.has(shapeType)) {
      group.add(this._createBlockLabel(object, width, height));
    }
    return group;
  }

  _createBlockLabel(object, width, height) {
    return new Konva.Text({
      x: 6,
      y: 0,
      width: Math.max(0, Math.abs(width) - 12),
      height: Math.abs(height),
      text: object.content || '',
      fill: '#0f172a',
      fontSize: object.fontSize || 16,
      fontFamily: FONT_FAMILY,
      align: 'center',
      verticalAlign: 'middle',
      wrap: 'word',
      listening: false,
    });
  }

  _createTextNode(object) {
    const group = new Konva.Group({
      x: object.x,
      y: object.y,
      rotation: object.rotation || 0,
    });
    const text = new Konva.Text({
      x: 0,
      y: 0,
      text: object.content,
      fill: object.color,
      fontSize: object.fontSize,
      fontFamily: fontStack(object.fontFamily),
      lineHeight: 1.25,
      listening: true,
    });
    group.add(text);
    return group;
  }

  _createImageNode(object) {
    const group = new Konva.Group({
      x: object.x,
      y: object.y,
      rotation: object.rotation || 0,
    });
    const placeholder = new Konva.Rect({
      x: 0,
      y: 0,
      width: object.width,
      height: object.height,
      fill: '#eef2f7',
      stroke: '#cbd5e1',
      strokeWidth: 1,
      cornerRadius: 4,
    });
    group.add(placeholder);

    const image = new Image();
    image.onload = () => {
      if (this.destroyed || group.getStage() === null) return;
      const current = this.objects.get(object.id)?.data ?? object;
      const node = new Konva.Image({
        x: 0,
        y: 0,
        image,
        width: current.width,
        height: current.height,
        cornerRadius: 4,
      });
      placeholder.destroy();
      group.add(node);
      node.moveToBottom();
      this.contentLayer.batchDraw();
    };
    image.src = object.url;
    return group;
  }

  // Авторитетные данные штриха приходят в stroke_end — заменяем локальные точки.
  _createFrameNode(object) {
    const group = new Konva.Group({
      x: object.x,
      y: object.y,
      rotation: 0,
    });
    const background = new Konva.Rect({
      x: 0,
      y: 0,
      width: Math.abs(object.width),
      height: Math.abs(object.height),
      fill: object.fill || '#ffffff',
      stroke: object.stroke || '#94a3b8',
      strokeWidth: object.strokeWidth || 2,
      cornerRadius: 4,
      name: 'frame-bg',
    });
    group.add(background);

    const pattern = new Konva.Shape({
      x: 0,
      y: 0,
      width: Math.abs(object.width),
      height: Math.abs(object.height),
      listening: false,
      name: 'frame-pattern',
      pattern: object.pattern || 'none',
      sceneFunc: (context, shape) => {
        const width = shape.width();
        const height = shape.height();
        const mode = shape.getAttr('pattern');
        if (mode !== 'lines' && mode !== 'grid') return;
        context.beginPath();
        context.rect(0, 0, width, height);
        context.clip();
        context.strokeStyle = '#cbd5e1';
        context.lineWidth = 1;
        const step = 24;
        for (let y = step; y < height; y += step) {
          context.beginPath();
          context.moveTo(0, y);
          context.lineTo(width, y);
          context.stroke();
        }
        if (mode === 'grid') {
          for (let x = step; x < width; x += step) {
            context.beginPath();
            context.moveTo(x, 0);
            context.lineTo(x, height);
            context.stroke();
          }
        }
      },
    });
    group.add(pattern);
    return group;
  }

  _applyFrameStyle(node, data) {
    const background = node.findOne('.frame-bg');
    const pattern = node.findOne('.frame-pattern');
    if (!background) return;
    const width = Math.abs(data.width ?? 0);
    const height = Math.abs(data.height ?? 0);
    background.width(width);
    background.height(height);
    if (data.fill !== undefined) background.fill(data.fill || '#ffffff');
    if (data.stroke !== undefined) background.stroke(data.stroke || '#94a3b8');
    if (data.strokeWidth !== undefined) {
      background.strokeWidth(data.strokeWidth || 2);
    }
    if (pattern) {
      pattern.width(width);
      pattern.height(height);
      if (data.pattern !== undefined) {
        pattern.setAttr('pattern', data.pattern || 'none');
      }
    }
    this.contentLayer.batchDraw();
  }

  applyFrameMove(message) {
    const frame = this.objects.get(message.frameId);
    if (frame) {
      frame.data.x = message.x;
      frame.data.y = message.y;
      frame.node.position({ x: message.x, y: message.y });
    }
    for (const child of message.children ?? []) {
      const entry = this.objects.get(child.id);
      if (!entry) continue;
      entry.data.x = child.x;
      entry.data.y = child.y;
      entry.node.position({ x: child.x, y: child.y });
      if (entry.data.type === 'shape' && FLOW_SHAPES.has(entry.data.shapeType)) {
        this._updateConnectorsFor(child.id);
      }
    }
    this.contentLayer.batchDraw();
  }

  setFrameChildren(frameId, objectIds) {
    for (const objectId of objectIds) {
      const entry = this.objects.get(objectId);
      if (entry) entry.data.frameId = frameId;
    }
  }

  setFrameStyle(objectId, { fill, pattern }) {
    const entry = this.objects.get(objectId);
    if (!entry || entry.data.type !== 'frame') return;
    entry.data.fill = fill;
    entry.data.pattern = pattern;
    this._applyFrameStyle(entry.node, entry.data);
  }

  _frameFor(data) {
    if (data.type === 'frame' || data.type === 'connector') return null;
    let anchor = null;
    if (data.type === 'text') {
      anchor = { x: data.x, y: data.y };
    } else if (data.type === 'shape' || data.type === 'image') {
      anchor = {
        x: data.x + (data.width ?? 0) / 2,
        y: data.y + (data.height ?? 0) / 2,
      };
    }
    if (!anchor) return null;
    let match = null;
    for (const entry of this.objects.values()) {
      const frame = entry.data;
      if (frame.type !== 'frame') continue;
      const left = Math.min(frame.x, frame.x + frame.width);
      const top = Math.min(frame.y, frame.y + frame.height);
      const right = Math.max(frame.x, frame.x + frame.width);
      const bottom = Math.max(frame.y, frame.y + frame.height);
      if (
        anchor.x >= left &&
        anchor.x <= right &&
        anchor.y >= top &&
        anchor.y <= bottom
      ) {
        match = frame;
      }
    }
    return match ? match.id : null;
  }

  _captureLocally(frame) {
    for (const entry of this.objects.values()) {
      const data = entry.data;
      if (entry.data.type === 'frame' && data.id === frame.id) continue;
      if (data.frameId !== undefined && data.frameId !== null) continue;
      if (this._frameFor(data) === frame.id) data.frameId = frame.id;
    }
  }

  _createConnectorNode(object) {
    const points = this._connectorPoints(object.fromId, object.toId);
    if (!points) return null;
    return new Konva.Arrow({
      points,
      stroke: object.color,
      fill: object.color,
      strokeWidth: object.strokeWidth,
      pointerLength: Math.max(8, object.strokeWidth * 3),
      pointerWidth: Math.max(8, object.strokeWidth * 3),
      lineCap: 'round',
      hitStrokeWidth: Math.max(12, object.strokeWidth * 2),
    });
  }

  _blockBounds(objectId) {
    const data = this.objects.get(objectId)?.data;
    if (!data || data.type !== 'shape' || !FLOW_SHAPES.has(data.shapeType)) {
      return null;
    }
    const width = Math.abs(data.width ?? 0);
    const height = Math.abs(data.height ?? 0);
    return {
      x: data.x,
      y: data.y,
      width,
      height,
      shapeType: data.shapeType,
      center: {
        x: data.x + (data.width ?? 0) / 2,
        y: data.y + (data.height ?? 0) / 2,
      },
    };
  }

  _edgePoint(bounds, toward) {
    const dx = toward.x - bounds.center.x;
    const dy = toward.y - bounds.center.y;
    if (dx === 0 && dy === 0) return bounds.center;
    const halfWidth = bounds.width / 2;
    const halfHeight = bounds.height / 2;
    let t;
    if (bounds.shapeType === 'decision') {
      const denominator =
        (halfWidth === 0 ? Infinity : Math.abs(dx) / halfWidth) +
        (halfHeight === 0 ? Infinity : Math.abs(dy) / halfHeight);
      t = denominator === 0 ? 0 : 1 / denominator;
    } else {
      const tx = dx === 0 ? Infinity : halfWidth / Math.abs(dx);
      const ty = dy === 0 ? Infinity : halfHeight / Math.abs(dy);
      t = Math.min(tx, ty);
    }
    t = Math.min(t, 1);
    return {
      x: bounds.center.x + dx * t,
      y: bounds.center.y + dy * t,
    };
  }

  _connectorPoints(fromId, toId) {
    const from = this._blockBounds(fromId);
    const to = this._blockBounds(toId);
    if (!from || !to) return null;
    const start = this._edgePoint(from, to.center);
    const end = this._edgePoint(to, from.center);
    return [start.x, start.y, end.x, end.y];
  }

  _updateConnectorsFor(blockId) {
    for (const entry of this.objects.values()) {
      const data = entry.data;
      if (data.type !== 'connector') continue;
      if (data.fromId !== blockId && data.toId !== blockId) continue;
      const points = this._connectorPoints(data.fromId, data.toId);
      if (points && entry.node instanceof Konva.Arrow) entry.node.points(points);
    }
    this.contentLayer.batchDraw();
  }

  _updateAllConnectors() {
    for (const entry of this.objects.values()) {
      const data = entry.data;
      if (data.type !== 'connector') continue;
      const points = this._connectorPoints(data.fromId, data.toId);
      if (points && entry.node instanceof Konva.Arrow) entry.node.points(points);
    }
    this.contentLayer.batchDraw();
  }

  endStroke(objectId, object) {
    const entry = this.objects.get(objectId);
    if (!entry) {
      if (object) this.addObject(object);
      return;
    }
    if (object && Array.isArray(object.points)) {
      entry.data = { ...object };
      entry.points = [...object.points];
      if (entry.node instanceof Konva.Line) {
        entry.node.points(object.points.flat());
        this.contentLayer.batchDraw();
      }
    }
  }

  appendStrokePoint(objectId, point) {
    const entry = this.objects.get(objectId);
    if (!entry || !(entry.node instanceof Konva.Line)) return;
    entry.points.push([point[0], point[1]]);
    entry.node.points(entry.points.flat());
    this.contentLayer.batchDraw();
  }

  updateObjectPosition(objectId, x, y, frameId) {
    const entry = this.objects.get(objectId);
    if (!entry) return;
    entry.data.x = x;
    entry.data.y = y;
    if (entry.node instanceof Konva.Group) {
      entry.node.position({ x, y });
      this.contentLayer.batchDraw();
    }
    if (frameId !== undefined) entry.data.frameId = frameId;
    else entry.data.frameId = this._frameFor(entry.data);
    if (
      entry.data.type === 'shape' &&
      FLOW_SHAPES.has(entry.data.shapeType)
    ) {
      this._updateConnectorsFor(objectId);
    }
  }

  applyObjectTransform(object) {
    if (!object || !object.id) return;
    const entry = this.objects.get(object.id);
    if (!entry) {
      this.addObject(object);
      return;
    }
    this._applyTransform(entry, object);
    if (this.selectedId === object.id) this.transformer.forceUpdate();
  }

  setTextFont(objectId, fontFamily) {
    const entry = this.objects.get(objectId);
    if (!entry || entry.data.type !== 'text') return;
    entry.data.fontFamily = fontFamily;
    entry.node.findOne('Text')?.fontFamily(fontStack(fontFamily));
    this.contentLayer.batchDraw();
  }

  applyObjectsRestored({ removedIds = [], objects = [] } = {}) {
    for (const id of removedIds) this.removeObject(id);
    for (const item of objects) {
      const object = item?.object;
      if (!object || !object.id) continue;
      if (this.objects.has(object.id)) {
        this.applyObjectTransform(object);
      } else {
        this.addObject(object);
      }
      const entry = this.objects.get(object.id);
      if (!entry) continue;
      this._applyLockBadge(entry);
      this._applyDraggable(entry);
      if (entry.data.type === 'frame') {
        for (const child of this.objects.values()) {
          if (child.data.frameId === object.id) this._applyDraggable(child);
        }
      }
    }
    if (this.selectedId) this.selectObject(this.selectedId);
    this.contentLayer.batchDraw();
  }

  getObjectData(objectId) {
    return this.objects.get(objectId)?.data ?? null;
  }

  _applyTransform(entry, object) {
    if (!(entry.node instanceof Konva.Group)) return;
    entry.data = { ...entry.data, ...object };
    const node = entry.node;
    node.position({ x: entry.data.x, y: entry.data.y });
    node.rotation(entry.data.rotation || 0);
    node.scale({ x: 1, y: 1 });

    if (entry.data.type === 'text') {
      const text = node.findOne('Text');
      if (text) {
        if (entry.data.content !== undefined) text.text(entry.data.content);
        if (entry.data.fontSize !== undefined) text.fontSize(entry.data.fontSize);
      }
    } else if (entry.data.type === 'shape') {
      this._resizeShapeNode(node, entry.data);
      this._applyBlockLabel(node, entry.data);
      this._updateConnectorsFor(entry.data.id);
    } else if (entry.data.type === 'image') {
      for (const child of node.getChildren()) {
        child.width(entry.data.width);
        child.height(entry.data.height);
      }
    } else if (entry.data.type === 'frame') {
      this._applyFrameStyle(node, entry.data);
    }
    if (entry.data.type !== 'frame' && entry.data.type !== 'connector') {
      entry.data.frameId = this._frameFor(entry.data);
    }
    this._applyLockBadge(entry);
    this.contentLayer.batchDraw();
  }

  _applyLockBadge(entry) {
    if (!(entry.node instanceof Konva.Group)) return;
    let badge = entry.node.findOne('.lock-badge');
    if (!entry.data.locked) {
      badge?.destroy();
      entry.node.getLayer()?.batchDraw();
      return;
    }
    if (!badge) {
      badge = new Konva.Text({
        name: 'lock-badge',
        text: LOCK_BADGE,
        fontSize: LOCK_BADGE_SIZE,
        listening: false,
      });
      entry.node.add(badge);
    }
    const box = (entry.node.getChildren((child) => child.name() !== 'lock-badge')[0] ?? entry.node)
      .getClientRect({ relativeTo: entry.node, skipShadow: true });
    badge.position({ x: box.x + box.width - LOCK_BADGE_SIZE, y: box.y + 2 });
    entry.node.getLayer()?.batchDraw();
  }

  setObjectLocked(objectId, locked) {
    const entry = this.objects.get(objectId);
    if (!entry) return;
    entry.data.locked = Boolean(locked);
    this._applyLockBadge(entry);
    this._applyDraggable(entry);
    if (entry.data.type === 'frame') {
      for (const child of this.objects.values()) {
        if (child.data.frameId === objectId) this._applyDraggable(child);
      }
    }
    if (entry.data.id === this.selectedId) this.selectObject(objectId);
    else if (
      entry.data.type === 'frame' &&
      this.objects.get(this.selectedId)?.data.frameId === objectId
    ) {
      this.selectObject(this.selectedId);
    }
    this.contentLayer.batchDraw();
  }

  _resizeShapeNode(node, data) {
    const shape = node.getChildren()[0];
    if (!shape) return;
    const width = data.width ?? 0;
    const height = data.height ?? 0;

    if (FLOW_SHAPES.has(data.shapeType)) {
      const absWidth = Math.abs(width);
      const absHeight = Math.abs(height);
      if (data.shapeType === 'decision' && shape instanceof Konva.Line) {
        shape.points([
          absWidth / 2,
          0,
          absWidth,
          absHeight / 2,
          absWidth / 2,
          absHeight,
          0,
          absHeight / 2,
        ]);
      } else if (shape instanceof Konva.Rect) {
        shape.width(absWidth);
        shape.height(absHeight);
        if (data.shapeType === 'terminator') {
          shape.cornerRadius(Math.min(absWidth, absHeight) / 2);
        }
      }
      return;
    }

    if (shape instanceof Konva.Rect) {
      shape.width(Math.abs(width));
      shape.height(Math.abs(height));
    } else if (shape instanceof Konva.Ellipse) {
      shape.x(width / 2);
      shape.y(height / 2);
      shape.radiusX(Math.abs(width) / 2);
      shape.radiusY(Math.abs(height) / 2);
    } else if (shape instanceof Konva.Arrow) {
      shape.points([0, 0, width, height]);
      const strokeWidth = shape.strokeWidth();
      shape.pointerLength(Math.max(8, strokeWidth * 3));
      shape.pointerWidth(Math.max(8, strokeWidth * 3));
    } else if (shape instanceof Konva.Line) {
      shape.points([0, 0, width, height]);
    }
  }

  _applyBlockLabel(node, data) {
    if (!FLOW_SHAPES.has(data.shapeType)) return;
    const label = node.findOne('Text');
    if (!label) return;
    const width = Math.abs(data.width ?? 0);
    const height = Math.abs(data.height ?? 0);
    label.position({ x: 6, y: 0 });
    label.width(Math.max(0, width - 12));
    label.height(height);
    if (data.content !== undefined) label.text(data.content);
  }

  _bindTransform(entry) {
    if (entry.transformBound || !(entry.node instanceof Konva.Group)) return;
    entry.transformBound = true;
    entry.node.on('transformend', () => {
      if (!this.editPredicate(entry.data, entry.node)) return;
      const node = entry.node;
      const scaleX = node.scaleX();
      const scaleY = node.scaleY();
      const data = {
        x: round(node.x()),
        y: round(node.y()),
        rotation: normalizeRotation(node.rotation()),
      };

      if (entry.data.type === 'text') {
        data.fontSize = clamp(
          round((entry.data.fontSize ?? 16) * Math.abs(scaleY)),
          8,
          200,
        );
      } else {
        data.width = clamp(round((entry.data.width ?? 0) * scaleX), -10000, 10000);
        data.height = clamp(round((entry.data.height ?? 0) * scaleY), -10000, 10000);
        if (Math.abs(data.width) < 2) data.width = data.width < 0 ? -2 : 2;
        if (Math.abs(data.height) < 2) data.height = data.height < 0 ? -2 : 2;
      }

      this._applyTransform(entry, data);
      this.transformer.forceUpdate();
      this.onObjectTransform(entry.data.id, data);
    });
  }

  removeObject(objectId) {
    const entry = this.objects.get(objectId);
    if (!entry) return;
    if (entry.data.type === 'frame') {
      for (const [id, item] of [...this.objects]) {
        if (item.data.frameId === objectId) this.removeObject(id);
      }
    }
    if (entry.data.type === 'shape' && FLOW_SHAPES.has(entry.data.shapeType)) {
      for (const [id, item] of [...this.objects]) {
        if (
          item.data.type === 'connector' &&
          (item.data.fromId === objectId || item.data.toId === objectId)
        ) {
          this.removeObject(id);
        }
      }
    }
    if (this.selectedId === objectId) this.selectObject(null);
    entry.node.destroy();
    this.objects.delete(objectId);
    this.contentLayer.batchDraw();
  }

  clearObjects() {
    this.selectObject(null);
    for (const entry of this.objects.values()) entry.node.destroy();
    this.objects.clear();
    this.contentLayer.batchDraw();
  }

  setObjects(objects) {
    this.clearObjects();
    for (const object of objects ?? []) this.addObject(object);
    this._updateAllConnectors();
    this.contentLayer.batchDraw();
  }

  // --------------------------------------------------------------- selection

  setSelectMode(enabled) {
    this.selectMode = enabled;
    if (!enabled) this.selectObject(null);
    for (const entry of this.objects.values()) this._applyDraggable(entry);
  }

  selectObject(objectId) {
    this.selectedId = objectId;
    const entry = objectId ? this.objects.get(objectId) : null;
    if (entry) {
      const data = entry.data;
      const isBlock = data.type === 'shape' && FLOW_SHAPES.has(data.shapeType);
      const transformable = data.type !== 'stroke' && data.type !== 'connector';
      const editable = this.editPredicate(data, entry.node);
      this.transformer.resizeEnabled(transformable && editable);
      this.transformer.rotateEnabled(
        transformable && editable && !isBlock && data.type !== 'frame',
      );
      this.transformer.nodes([entry.node]);
      this.transformer.moveToTop();
      this.transformer.forceUpdate();
    } else {
      this.transformer.nodes([]);
    }
    this.onSelectObject?.(objectId);
    this.contentLayer.batchDraw();
  }

  getSelectedId() {
    return this.selectedId;
  }

  objectIdAt(point) {
    const stagePoint = this.toScreen(point);
    const target = this.stage.getIntersection(stagePoint);
    let node = target;
    while (node && node !== this.stage) {
      if (node.id() && this.objects.has(node.id())) return node.id();
      node = node.getParent();
    }
    return null;
  }

  eraseAt(point, radius) {
    const ids = [];
    for (const [id, entry] of [...this.objects.entries()]) {
      if (entry.data.type !== 'stroke') continue;
      if (!this.deletePredicate(entry.data)) continue;
      if (this._isErased(entry, point, radius)) ids.push(id);
    }
    for (const id of ids) this.removeObject(id);
    return ids;
  }

  _isErased(entry, point, radius) {
    const data = entry.data;
    if (entry.points) {
      return (
        this._distanceToSegments(entry.points, point) <=
        radius + (data.width ?? 0) / 2
      );
    }
    if (data.type === 'frame') {
      return this._nearFrameBorder(data, point, radius);
    }
    if (data.type === 'connector') {
      const points = entry.node?.points?.() ?? [];
      if (points.length >= 4) {
        const segments = [];
        for (let index = 0; index + 3 < points.length; index += 2) {
          segments.push([
            [points[index], points[index + 1]],
            [points[index + 2], points[index + 3]],
          ]);
        }
        return this._segmentsDistance(segments, point) <= radius + 2;
      }
      return false;
    }

    const stagePoint = this.toScreen(point);
    const rect = entry.node.getClientRect();
    return this._circleIntersectsRect(stagePoint, radius * this.scale, rect);
  }

  _nearFrameBorder(data, point, radius) {
    const left = Math.min(data.x, data.x + data.width);
    const top = Math.min(data.y, data.y + data.height);
    const right = Math.max(data.x, data.x + data.width);
    const bottom = Math.max(data.y, data.y + data.height);
    const dx = Math.max(left - point.x, 0, point.x - right);
    const dy = Math.max(top - point.y, 0, point.y - bottom);
    const outside = Math.hypot(dx, dy);
    if (outside > radius) return false;
    if (outside > 0) return true;
    const inside = Math.min(
      point.x - left,
      right - point.x,
      point.y - top,
      bottom - point.y,
    );
    return inside <= radius + (data.strokeWidth ?? 2) / 2;
  }

  _circleIntersectsRect(point, radius, rect) {
    const nearestX = Math.max(rect.x, Math.min(point.x, rect.x + rect.width));
    const nearestY = Math.max(rect.y, Math.min(point.y, rect.y + rect.height));
    return Math.hypot(point.x - nearestX, point.y - nearestY) <= radius;
  }

  _distanceToSegments(points, point) {
    const segments = [];
    for (let index = 0; index + 1 < points.length; index += 1) {
      segments.push([points[index], points[index + 1]]);
    }
    return this._segmentsDistance(segments, point);
  }

  _segmentsDistance(segments, point) {
    let best = Infinity;
    for (const [start, end] of segments) {
      const [x1, y1] = start;
      const [x2, y2] = end;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const lengthSquared = dx * dx + dy * dy;
      const t =
        lengthSquared === 0
          ? 0
          : Math.max(
              0,
              Math.min(1, ((point.x - x1) * dx + (point.y - y1) * dy) / lengthSquared),
            );
      const x = x1 + t * dx;
      const y = y1 + t * dy;
      best = Math.min(best, Math.hypot(point.x - x, point.y - y));
    }
    return best;
  }

  _applyDraggable(entry) {
    const isGroup = entry.node instanceof Konva.Group;
    const allowed =
      this.selectMode && isGroup && this.editPredicate(entry.data, entry.node);
    entry.node.draggable(allowed);
    if (allowed && !entry.dragBound) {
      entry.dragBound = true;
      entry.node.on('dragstart', () => {
        if (entry.data.type !== 'frame') return;
        entry.frameStart = { x: entry.node.x(), y: entry.node.y() };
        entry.childStarts = [];
        for (const [id, child] of this.objects) {
          if (child.data.frameId === entry.data.id && child.data.type !== 'connector') {
            entry.childStarts.push({ id, x: child.node.x(), y: child.node.y() });
          }
        }
      });
      entry.node.on('dragmove', () => {
        if (entry.data.type === 'frame') {
          const dx = entry.node.x() - entry.frameStart.x;
          const dy = entry.node.y() - entry.frameStart.y;
          for (const start of entry.childStarts ?? []) {
            const child = this.objects.get(start.id);
            if (!child) continue;
            child.node.position({ x: start.x + dx, y: start.y + dy });
            if (child.data.type === 'shape' && FLOW_SHAPES.has(child.data.shapeType)) {
              this._updateConnectorsFor(start.id);
            }
          }
          this.contentLayer.batchDraw();
          return;
        }
        if (entry.data.type === 'shape' && FLOW_SHAPES.has(entry.data.shapeType)) {
          this._updateConnectorsFor(entry.data.id);
        }
      });
      entry.node.on('dragend', () => {
        if (entry.data.type === 'frame') {
          const position = entry.node.position();
          for (const start of entry.childStarts ?? []) {
            const child = this.objects.get(start.id);
            if (!child) continue;
            child.data.x = child.node.x();
            child.data.y = child.node.y();
          }
          entry.data.x = position.x;
          entry.data.y = position.y;
          this.onFrameMove(entry.data.id, position.x, position.y);
          return;
        }
        const position = entry.node.position();
        entry.data.x = position.x;
        entry.data.y = position.y;
        entry.data.frameId = this._frameFor(entry.data);
        if (entry.data.type === 'shape' && FLOW_SHAPES.has(entry.data.shapeType)) {
          this._updateConnectorsFor(entry.data.id);
        }
        this.onObjectMove(entry.data.id, position.x, position.y);
      });
    }
  }

  _handleStageDoubleClick(event) {
    const target = event.target;
    if (target === this.stage || target === this.paper) return;
    let node = target;
    while (node && node !== this.stage && !node.id()) node = node.getParent();
    if (!node || node === this.stage) return;
    const entry = this.objects.get(node.id());
    if (!entry) return;
    const isText = entry.data.type === 'text';
    const isBlock =
      entry.data.type === 'shape' && FLOW_SHAPES.has(entry.data.shapeType);
    if (!isText && !isBlock) return;
    if (!this.editPredicate(entry.data, entry.node)) return;
    event.evt?.preventDefault?.();
    this.selectObject(entry.data.id);
    this.onEditText({ ...entry.data });
  }

  _handleStagePointerDown(event) {
    if (!this.selectMode) return;
    const target = event.target;
    if (target === this.stage || target === this.paper) {
      this.selectObject(null);
      return;
    }
    let node = target;
    while (node && node !== this.stage) {
      if (node === this.transformer) return;
      if (node.id() && this.objects.has(node.id())) {
        this.selectObject(node.id());
        return;
      }
      node = node.getParent();
    }
    this.selectObject(null);
  }

  // ----------------------------------------------------------------- previews

  showShapePreview(object) {
    this.hideShapePreview();
    this.previewNode = this._createShapeNode(object);
    this.previewNode.opacity(0.7);
    this.previewNode.listening(false);
    this.previewNode.getChildren().forEach((child) => child.dash?.([8, 6]));
    this.contentLayer.add(this.previewNode);
    this.previewNode.moveToTop();
    this.contentLayer.batchDraw();
  }

  updateShapePreview(object) {
    this.hideShapePreview();
    this.showShapePreview(object);
  }

  hideShapePreview() {
    if (this.previewNode) {
      this.previewNode.destroy();
      this.previewNode = null;
      this.contentLayer.batchDraw();
    }
  }

  // ------------------------------------------------------------------ cursors

  upsertCursor(id, { x, y, name, color }) {
    const fill = /^#[0-9a-f]{6}$/i.test(color ?? '') ? color : '#2563eb';
    const ink = cursorInk(fill);
    let cursor = this.cursors.get(id);
    if (!cursor) {
      const group = new Konva.Group({ listening: false });
      const pointer = new Konva.Path({
        data: 'M0 0 L0 18 L5 13.5 L8.5 20 L12 18.5 L8.5 12 L15 12 Z',
        fill,
        stroke: ink,
        strokeWidth: 2,
        shadowColor: 'rgba(15,23,42,0.45)',
        shadowBlur: 5,
      });
      const tag = new Konva.Rect({
        x: 15,
        y: 15,
        height: 20,
        cornerRadius: 6,
        fill,
        stroke: ink,
        strokeWidth: 1,
        opacity: 0.97,
      });
      const text = new Konva.Text({
        x: 21,
        y: 18,
        text: name || '',
        fontSize: 12,
        fontFamily: FONT_FAMILY,
        fill: ink,
      });
      group.add(pointer, tag, text);
      this.overlayLayer.add(group);
      cursor = { group, pointer, tag, text };
      this.cursors.set(id, cursor);
    }
    cursor.pointer.fill(fill);
    cursor.pointer.stroke(ink);
    cursor.tag.fill(fill);
    cursor.tag.stroke(ink);
    cursor.text.fill(ink);
    cursor.text.text(name || '');
    cursor.tag.width(cursor.text.width() + 12);
    cursor.group.position({ x, y });
    this.overlayLayer.batchDraw();
  }

  removeCursor(id) {
    const cursor = this.cursors.get(id);
    if (!cursor) return;
    cursor.group.destroy();
    this.cursors.delete(id);
    this.overlayLayer.batchDraw();
  }

  clearCursors() {
    for (const cursor of this.cursors.values()) cursor.group.destroy();
    this.cursors.clear();
    this.overlayLayer.batchDraw();
  }

  setInteractive(enabled) {
    const interactive = Boolean(enabled);
    this.stage.listening(interactive);
    // Konva still emits stage-level pointer events while listening is off,
    // so block the DOM pointer stream as well.
    this.stage.container().style.pointerEvents = interactive ? '' : 'none';
  }

  destroy() {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this._onWindowResize);
    this.container.removeEventListener('pointerdown', this._onPointerDown);
    this.container.removeEventListener('pointermove', this._onPointerMove);
    this.container.removeEventListener('pointerup', this._onPointerUp);
    this.container.removeEventListener('pointercancel', this._onPointerUp);
    this.container.removeEventListener('wheel', this._onWheel);
    this.stage.destroy();
  }
}
