export const referenceTransferLimits = {
  latex: { rows: 500, bytes: 20 * 1024 * 1024 },
  image: { rows: 300, bytes: 25 * 1024 * 1024 },
} as const;

export type ReferenceKind = keyof typeof referenceTransferLimits;
export const referenceImageBytes = 8 * 1024 * 1024;
