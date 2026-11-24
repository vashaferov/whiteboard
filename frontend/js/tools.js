/**
 * Инструменты: кисть, ластик, фигуры, текст и выбор.
 * Локальный оптимистичный рендеринг + отправка событий через onEvent.
 */

const STROKE_TOOLS = new Set(['brush']);
const SHAPE_TOOLS = new Set([
  'rect',
  'circle',
  'line',
  'arrow',
  'process',
  'decision',
  'terminator',
  'frame',
]);
const FLOW_SHAPES = new Set(['process', 'decision', 'terminator']);
const ERASER_RADIUS_MIN = 10;
const POINT_THROTTLE_MS = 16;

function newId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `o_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function normalizeShape(tool, start, end) {
  if (tool === 'rect' || tool === 'circle' || tool === 'frame' || FLOW_SHAPES.has(tool)) {
    return {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
  }
  return {
    x: start.x,
    y: start.y,
    width: end.x - start.x,
    height: end.y - start.y,
  };
}

export class ToolManager {
  constructor({ board, onEvent, onCreateText, getAuthor, onErase }) {
    this.board = board;
    this.stage = board.stage;
    this.onEvent = onEvent;
    this.onCreateText = onCreateText;
    this.getAuthor = getAuthor ?? (() => null);
    this.onErase = onErase ?? (() => {});
    this.erasing = false;

    this.tool = 'brush';
    this.color = '#2563eb';
    this.width = 4;
    this.fontFamily = 'sans';
    this.fontSize = 24;
    this.bold = false;
    this.italic = false;
    this.underline = false;
    this.stroke = null;
    this.shape = null;
    this.pendingTouch = null;
    this.lastSentAt = 0;

    this._onPointerDown = (event) => this._handleDown(event);
    this._onPointerMove = () => this._handleMove();
    this._onPointerUp = () => this._handleUp();

    this.stage.on('pointerdown', this._onPointerDown);
    this.stage.on('pointermove', this._onPointerMove);
    this.stage.on('pointerup', this._onPointerUp);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('blur', this._onPointerUp);
  }

  setTool(tool) {
    if (this.tool === tool) return;
    this._finishStroke();
    this._cancelShape();
    this.pendingTouch = null;
    this.tool = tool;
    this.board.setSelectMode(tool === 'select');
    this.board.setLassoMode(tool === 'lasso');
  }

  setStyle({ color, width }) {
    if (color) this.color = color;
    if (width) this.width = width;
  }

  setFontFamily(fontFamily) {
    this.fontFamily = fontFamily;
  }

  setFontSize(fontSize) {
    this.fontSize = fontSize;
  }

  setTextFormat(patch) {
    for (const name of ['bold', 'italic', 'underline']) {
      if (patch[name] !== undefined) this[name] = Boolean(patch[name]);
    }
  }

  getTextStyle() {
    return {
      color: this.color,
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      bold: this.bold,
      italic: this.italic,
      underline: this.underline,
    };
  }

  isDrawing() {
    return Boolean(this.stroke || this.shape || this.erasing);
  }

  _handleDown(event) {
    if (this.board.isGesturing?.()) return;
    const nativeEvent = event.evt;
    if (nativeEvent && typeof nativeEvent.button === 'number' && nativeEvent.button !== 0) {
      return;
    }
    if (this.tool === 'select' || this.tool === 'lasso') return;

    const point = this.board.getPointer();
    if (!point) return;

    if (this.tool === 'eraser') {
      this.erasing = true;
      this._erase(point);
    } else if (STROKE_TOOLS.has(this.tool)) {
      // На касании не начинаем штрих сразу: второй палец означает pinch.
      if (nativeEvent?.pointerType === 'touch') {
        this.pendingTouch = point;
        return;
      }
      this._startStroke(point);
    } else if (SHAPE_TOOLS.has(this.tool)) {
      this._connectorStart = null;
      if (this.tool === 'arrow') {
        const id = this.board.objectIdAt(point);
        const data = id ? this.board.getObjectData(id) : null;
        if (data && data.type === 'shape' && FLOW_SHAPES.has(data.shapeType)) {
          this._connectorStart = id;
        }
      }
      this.shape = { start: point, end: point };
      this._drawShapePreview();
    } else if (this.tool === 'text') {
      this.onCreateText(point);
    }
  }

  _handleMove() {
    if (this.board.isGesturing?.()) return;
    if (this.erasing) {
      const point = this.board.getPointer();
      if (point) this._erase(point);
      return;
    }

    if (this.pendingTouch && !this.stroke) {
      const point = this.board.getPointer();
      if (!point) return;
      const moved = Math.hypot(point.x - this.pendingTouch.x, point.y - this.pendingTouch.y);
      if (moved > 2) {
        const start = this.pendingTouch;
        this.pendingTouch = null;
        this._startStroke(start);
      }
      return;
    }

    if (this.stroke) {
      const point = this.board.getPointer();
      if (!point) return;
      this.stroke.points.push([point.x, point.y]);
      this.board.appendStrokePoint(this.stroke.id, [point.x, point.y]);

      const now = performance.now();
      if (now - this.lastSentAt >= POINT_THROTTLE_MS) {
        this.lastSentAt = now;
        this._sendStrokePoint(point);
        this.stroke.sentCount = this.stroke.points.length;
      }
      return;
    }

    if (this.shape) {
      const point = this.board.getPointer();
      if (!point) return;
      this.shape.end = point;
      this._drawShapePreview();
    }
  }

  _handleUp() {
    this.erasing = false;
    this.pendingTouch = null;
    if (this.stroke) {
      this._finishStroke();
    }
    if (this.shape) {
      this._finishShape();
    }
  }

  _erase(point) {
    const radius = Math.max(ERASER_RADIUS_MIN, this.width * 1.5);
    const ids = this.board.eraseAt(point, radius);
    if (ids.length) this.onErase(ids);
  }

  // Commit whatever is in progress before the student's page changes.
  finishActiveStroke() {
    this.pendingTouch = null;
    this._finishStroke();
    this._cancelShape();
  }

  // Завершаем начатое, когда начинается жест двумя пальцами; одиночная точка отменяется.
  cancelOrFinishStroke() {
    this.pendingTouch = null;
    this._cancelShape();
    if (!this.stroke) return;
    const stroke = this.stroke;
    if (stroke.points.length > 1) {
      this._finishStroke();
      return;
    }
    this.stroke = null;
    this.board.removeObject(stroke.id);
    this.onEvent({ type: 'object_delete', objectId: stroke.id });
  }

  // ------------------------------------------------------------------ strokes

  _startStroke(point) {
    const id = newId();
    this.stroke = {
      id,
      points: [[point.x, point.y]],
      sentCount: 0,
      tool: this.tool,
      color: this.color,
      width: this.width,
    };
    this.lastSentAt = performance.now();

    this.board.addObject({
      id,
      type: 'stroke',
      tool: this.tool,
      color: this.color,
      width: this.width,
      points: [[point.x, point.y]],
      author: this.getAuthor(),
    });
    this.onEvent({
      type: 'stroke_start',
      objectId: id,
      tool: this.tool,
      color: this.color,
      width: this.width,
      point: { x: point.x, y: point.y },
    });
    this.stroke.sentCount = 1;
  }

  _sendStrokePoint(point) {
    if (!this.stroke) return;
    this.onEvent({
      type: 'stroke_point',
      objectId: this.stroke.id,
      point: { x: point.x, y: point.y },
    });
  }

  _finishStroke() {
    const stroke = this.stroke;
    if (!stroke) return;
    this.stroke = null;

    // Досылаем точки, которые не попали в троттлинг, чтобы у остальных линия не обрывалась.
    for (let index = stroke.sentCount; index < stroke.points.length; index += 1) {
      const [x, y] = stroke.points[index];
      this.onEvent({
        type: 'stroke_point',
        objectId: stroke.id,
        point: { x, y },
      });
    }
    this.onEvent({ type: 'stroke_end', objectId: stroke.id });
  }

  // ------------------------------------------------------------------- shapes

  _drawShapePreview() {
    if (!this.shape) return;
    const geometry = normalizeShape(this.tool, this.shape.start, this.shape.end);
    const object = {
      type: 'shape',
      shapeType: this.tool,
      ...geometry,
      color: this.color,
      strokeWidth: this.width,
      fill: null,
    };
    if (!this.previewStarted) {
      this.board.showShapePreview(object);
      this.previewStarted = true;
    } else {
      this.board.updateShapePreview(object);
    }
  }

  _finishShape() {
    const shape = this.shape;
    this.shape = null;
    this.previewStarted = false;
    this.board.hideShapePreview();
    if (!shape) return;

    const geometry = normalizeShape(this.tool, shape.start, shape.end);
    if (Math.abs(geometry.width) < 3 && Math.abs(geometry.height) < 3) return;

    if (this.tool === 'frame') {
      const objectId = newId();
      const fill = null;
      const pattern = 'none';
      const stroke = '#94a3b8';
      const strokeWidth = 2;
      this.board.addObject({
        id: objectId,
        type: 'frame',
        ...geometry,
        fill,
        pattern,
        stroke,
        strokeWidth,
        rotation: 0,
        author: this.getAuthor(),
      });
      this.onEvent({
        type: 'frame_add',
        objectId,
        ...geometry,
        fill,
        pattern,
        stroke,
        strokeWidth,
      });
      return;
    }

    if (this.tool === 'arrow' && this._connectorStart) {
      const targetId = this.board.objectIdAt(shape.end);
      const target = targetId ? this.board.getObjectData(targetId) : null;
      if (
        targetId &&
        targetId !== this._connectorStart &&
        target &&
        target.type === 'shape' &&
        FLOW_SHAPES.has(target.shapeType)
      ) {
        this.onEvent({
          type: 'connector_add',
          objectId: newId(),
          fromId: this._connectorStart,
          toId: targetId,
          color: this.color,
          strokeWidth: this.width,
        });
        this._connectorStart = null;
        return;
      }
    }
    this._connectorStart = null;

    const id = newId();
    const object = {
      id,
      type: 'shape',
      shapeType: this.tool,
      ...geometry,
      color: this.color,
      strokeWidth: this.width,
      fill: null,
      author: this.getAuthor(),
    };
    this.board.addObject(object);
    this.onEvent({
      type: 'shape_add',
      objectId: id,
      shapeType: this.tool,
      ...geometry,
      color: this.color,
      strokeWidth: this.width,
      fill: null,
    });
  }

  _cancelShape() {
    this.shape = null;
    this.previewStarted = false;
    this.board.hideShapePreview();
  }

  destroy() {
    this.stage.off('pointerdown', this._onPointerDown);
    this.stage.off('pointermove', this._onPointerMove);
    this.stage.off('pointerup', this._onPointerUp);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('blur', this._onPointerUp);
  }
}
