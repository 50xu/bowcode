export type Modifier = 'off' | 'armed' | 'locked';
export type Modifiers = { ctrl: Modifier; alt: Modifier };

const sequences: Record<string, string> = {
  Esc: '\x1b', Tab: '\t', '←': '\x1b[D', '↑': '\x1b[A', '↓': '\x1b[B', '→': '\x1b[C',
  Home: '\x1b[H', End: '\x1b[F', PgUp: '\x1b[5~', PgDn: '\x1b[6~',
};

/** Converts accessory keys and typed characters into PTY input, consuming one-shot modifiers. */
export function terminalInput(
  key: string,
  modifiers: Modifiers,
  source: 'accessory' | 'typed' = 'accessory',
): { data: string; modifiers: Modifiers } {
  // Only accessory chips are looked up by name: typed text such as an
  // autocompleted "End" or "Tab" must reach the shell verbatim.
  const raw = source === 'accessory' ? sequences[key] ?? key : key;
  const ctrl = modifiers.ctrl !== 'off';
  const alt = modifiers.alt !== 'off';
  const data = ctrl && raw.length === 1 && /[a-zA-Z]/.test(raw)
    ? String.fromCharCode(raw.toUpperCase().charCodeAt(0) & 0x1f)
    : raw;
  return {
    data: alt ? `\x1b${data}` : data,
    modifiers: {
      ctrl: modifiers.ctrl === 'armed' ? 'off' : modifiers.ctrl,
      alt: modifiers.alt === 'armed' ? 'off' : modifiers.alt,
    },
  };
}

/** A second tap locks an armed modifier; tapping a locked modifier clears it. */
export function toggleModifier(value: Modifier): Modifier {
  return value === 'off' ? 'armed' : value === 'armed' ? 'locked' : 'off';
}
