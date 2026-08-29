export const NORMALIZED_MAX = 1000;

export function clampNormalized(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Coordinate must be a finite number");
  }

  return Math.min(NORMALIZED_MAX, Math.max(0, value));
}

export function denormalize(value: number, screenSize: number): number {
  if (!Number.isInteger(screenSize) || screenSize <= 0) {
    throw new Error("Screen size must be a positive integer");
  }

  const pixel = Math.floor((clampNormalized(value) / NORMALIZED_MAX) * screenSize);
  return Math.min(screenSize - 1, Math.max(0, pixel));
}

export function denormalizeX(x: number, screenWidth: number): number {
  return denormalize(x, screenWidth);
}

export function denormalizeY(y: number, screenHeight: number): number {
  return denormalize(y, screenHeight);
}
