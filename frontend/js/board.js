/**
 * Konva-доска: слои, объекты, курсоры, выделение и перемещение.
 * Координаты объектов — мировые на логической доске (например 1600×900).
 */

const FONT_FAMILY = 'Inter, "Segoe UI", Roboto, Arial, sans-serif';
const MIN_SCALE = 0.1;

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

    this._onWindowResize = () => this.fit();
    window.addEventListener('resize', this._onWindowResize);
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(container);

    this.stage.on('pointerdown', (event) => this._handleStagePointerDown(event));
    this.stage.on('dblclick dbltap', (event) => this._handleStageDoubleClick(event));
    this.fit();
  }

  // ------------------------------------------------------------------ viewport

  fit() {
    if (this.destroyed) return;
    const containerWidth = Math.max(1, this.container.clientWidth);
    const containerHeight = Math.max(1, this.container.clientHeight);
    const scale = Math.max(
      MIN_SCALE,
      Math.min(containerWidth / this.width, containerHeight / this.height),
    );
    this.scale = scale;
    this.offsetX = (containerWidth - this.width * scale) / 2;
    this.offsetY = (containerHeight - this.height * scale) / 2;
    this.stage.size({ width: containerWidth, height: containerHeight });
    this.stage.scale({ x: scale, y: scale });
    this.stage.position({ x: this.offsetX, y: this.offsetY });
    this.stage.batchDraw();
  }

  setBoardSize(width, height) {
    if (!width || !height || (width === this.width && height === this.height)) return;
    this.width = width;
    this.height = height;
    this.paper.size({ width, height });
    this.grid.size({ width, height });
    this.fit();
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
      default:
        return null;
    }
    if (!node) return null;

    node.id(object.id);
    this.contentLayer.add(node);
    node.moveToTop();
    this.transformer.moveToTop();

    const entry = { data: { ...object }, node };
    if (object.type === 'stroke') {
      entry.points = [...(object.points ?? [])];
    }
    this.objects.set(object.id, entry);
    this._applyDraggable(entry);
    this._bindTransform(entry);
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
    let shape;
    if (shapeType === 'rect') {
      shape = new Konva.Rect({
        x: 0,
        y: 0,
        width,
        height,
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
    } else {
      shape = new Konva.Line({
        points: [0, 0, width, height],
        stroke: color,
        strokeWidth,
        lineCap: 'round',
      });
    }
    group.add(shape);
    return group;
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
      fontFamily: FONT_FAMILY,
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

  updateObjectPosition(objectId, x, y) {
    const entry = this.objects.get(objectId);
    if (!entry) return;
    entry.data.x = x;
    entry.data.y = y;
    if (entry.node instanceof Konva.Group) {
      entry.node.position({ x, y });
      this.contentLayer.batchDraw();
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
    } else if (entry.data.type === 'image') {
      for (const child of node.getChildren()) {
        child.width(entry.data.width);
        child.height(entry.data.height);
      }
    }
    this.contentLayer.batchDraw();
  }

  _resizeShapeNode(node, data) {
    const shape = node.getChildren()[0];
    if (!shape) return;
    const width = data.width ?? 0;
    const height = data.height ?? 0;

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
      const transformable = entry.data.type !== 'stroke';
      this.transformer.resizeEnabled(transformable);
      this.transformer.rotateEnabled(transformable);
      this.transformer.nodes([entry.node]);
      this.transformer.moveToTop();
      this.transformer.forceUpdate();
    } else {
      this.transformer.nodes([]);
    }
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
      entry.node.on('dragend', () => {
        const position = entry.node.position();
        entry.data.x = position.x;
        entry.data.y = position.y;
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
    if (!entry || entry.data.type !== 'text') return;
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
    let cursor = this.cursors.get(id);
    if (!cursor) {
      const group = new Konva.Group({ listening: false });
      const pointer = new Konva.Path({
        data: 'M0 0 L0 18 L5 13.5 L8.5 20 L12 18.5 L8.5 12 L15 12 Z',
        fill: color,
        stroke: '#ffffff',
        strokeWidth: 1.5,
        shadowColor: 'rgba(15,23,42,0.35)',
        shadowBlur: 4,
      });
      const tag = new Konva.Rect({
        x: 15,
        y: 15,
        height: 20,
        cornerRadius: 6,
        fill: color,
        opacity: 0.95,
      });
      const text = new Konva.Text({
        x: 21,
        y: 18,
        text: name || '',
        fontSize: 12,
        fontFamily: FONT_FAMILY,
        fill: '#ffffff',
      });
      group.add(pointer, tag, text);
      this.overlayLayer.add(group);
      cursor = { group, pointer, tag, text };
      this.cursors.set(id, cursor);
    }
    cursor.pointer.fill(color);
    cursor.tag.fill(color);
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
    this.stage.destroy();
  }
}
