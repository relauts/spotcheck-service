import fs from "node:fs/promises";
import { getLatestWebpPath } from "../playwright/processed.js";

export async function readWebpAsBase64(filePath: string): Promise<string> {
  return fs.readFile(filePath, { encoding: "base64" });
}

export async function loadLatestWebpBase64(
  directory?: string,
): Promise<{ path: string; data: string }> {
  const filePath = await getLatestWebpPath(directory);
  if (!filePath) {
    throw new Error("No processed webp screenshot found");
  }

  return {
    path: filePath,
    data: await readWebpAsBase64(filePath),
  };
}
