const KEY_ALIASES: Record<string, string> = {
  return: "Enter",
  enter: "Enter",
  esc: "Escape",
  escape: "Escape",
  ctrl: "Control",
  control: "Control",
  cmd: "Meta",
  command: "Meta",
  super: "Meta",
  meta: "Meta",
  alt: "Alt",
  option: "Alt",
  space: "Space",
  spacebar: "Space",
  backspace: "Backspace",
  tab: "Tab",
  del: "Delete",
  delete: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  shift: "Shift",
};

export function mapGeminiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error("Key must be a non-empty string");
  }

  if (trimmed.length === 1) {
    return trimmed;
  }

  return KEY_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export function mapGeminiKeys(keys: string[]): string[] {
  return keys.map(mapGeminiKey);
}

export function selectAllShortcut(platform = process.platform): string {
  return platform === "darwin" ? "Meta+A" : "Control+A";
}
