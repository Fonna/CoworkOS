const DEFAULT_LAYOUT = { width: 13.333, height: 7.5 };

export function svgToDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export function containRect(sourceWidth, sourceHeight, x, y, width, height) {
  if (![sourceWidth, sourceHeight, width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("containRect requires positive finite dimensions");
  }
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const w = sourceWidth * scale;
  const h = sourceHeight * scale;
  return { x: x + (width - w) / 2, y: y + (height - h) / 2, w, h };
}

export function coverRect(sourceWidth, sourceHeight, x, y, width, height) {
  if (![sourceWidth, sourceHeight, width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("coverRect requires positive finite dimensions");
  }
  // PptxGenJS derives the source ratio from w/h, then writes the sizing
  // viewport into the final XML. Keep these two dimensions distinct.
  return {
    x,
    y,
    w: (height * sourceWidth) / sourceHeight,
    h: height,
    sizing: { type: "cover", w: width, h: height }
  };
}

export function inspectSlideGeometry(slide, options = {}) {
  const layout = options.layout ?? DEFAULT_LAYOUT;
  const tolerance = options.tolerance ?? 0.02;
  const objects = Array.isArray(slide?._slideObjects) ? slide._slideObjects : [];
  const boxes = objects.flatMap((object, index) => {
    const value = object?.options ?? object?.text?.[0]?.options;
    if (![value?.x, value?.y, value?.w, value?.h].every(Number.isFinite)) return [];
    // Native table geometry is already converted from inches to EMU by PptxGenJS.
    const unit = object._type === "table" ? 914400 : 1;
    const sizing = object._type === "image" ? value.sizing : null;
    return [
      {
        index,
        type: object._type ?? "unknown",
        name: value.objectName ?? `object-${index}`,
        x: value.x / unit,
        y: value.y / unit,
        w: (Number.isFinite(sizing?.w) ? sizing.w : value.w) / unit,
        h: (Number.isFinite(sizing?.h) ? sizing.h : value.h) / unit
      }
    ];
  });
  const outOfBounds = boxes.filter(
    (box) =>
      box.x < -tolerance ||
      box.y < -tolerance ||
      box.x + box.w > layout.width + tolerance ||
      box.y + box.h > layout.height + tolerance
  );
  const overlaps = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapWidth = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapHeight = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (overlapWidth > tolerance && overlapHeight > tolerance) {
        overlaps.push({ a: a.name, b: b.name, area: overlapWidth * overlapHeight });
      }
    }
  }
  return { objects: boxes.length, outOfBounds, overlaps };
}

export function assertSlidesInBounds(presentation, layout = DEFAULT_LAYOUT) {
  const failures = [];
  for (const [index, slide] of (presentation?._slides ?? []).entries()) {
    const result = inspectSlideGeometry(slide, { layout });
    if (result.outOfBounds.length) failures.push({ slide: index + 1, objects: result.outOfBounds });
  }
  if (failures.length) throw new Error(`Slide objects outside canvas: ${JSON.stringify(failures)}`);
}
