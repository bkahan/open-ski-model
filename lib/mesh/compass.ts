// North arrow for the name plate, as a 2D outline. The arrow points +y
// in its own frame; the caller rotates it so it points at true north
// once the model's rotation and the plate's position are accounted for.
//
//      ▲    ← tip
//     ▲▲
//    ▲  ▲
//   ▲────▲  ← barbs, with a stem below

export function compassContour(size: number): Array<[number, number]> {
  const r = size / 2;
  return [
    [0, r],
    [0.55 * r, -0.25 * r],
    [0.2 * r, -0.1 * r],
    [0.2 * r, -0.85 * r],
    [-0.2 * r, -0.85 * r],
    [-0.2 * r, -0.1 * r],
    [-0.55 * r, -0.25 * r],
  ];
}

/** Rotate a contour by `degrees` counter-clockwise about the origin. */
export function rotateContour(
  contour: Array<[number, number]>,
  degrees: number,
): Array<[number, number]> {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return contour.map(([x, y]) => [x * c - y * s, x * s + y * c]);
}
