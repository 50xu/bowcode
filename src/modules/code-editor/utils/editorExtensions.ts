import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { Extension } from '@codemirror/state';
import { getChunks } from '@codemirror/merge';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { showMinimap } from '@replit/codemirror-minimap';

import type { CodeEditorFile } from '@/shared/types';

// Lightweight lexer for `.env` files (including `.env.*` variants).
const envLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.match(/^#.*/)) return 'comment';
    if (stream.sol() && stream.match(/^[A-Za-z_][A-Za-z0-9_.]*(?==)/)) return 'variableName.definition';
    if (stream.match(/^=/)) return 'operator';
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string';
    if (stream.match(/^\$\{[^}]*\}?/)) return 'variableName.special';
    if (stream.match(/^\$[A-Za-z_][A-Za-z0-9_]*/)) return 'variableName.special';
    if (stream.match(/^\d+/)) return 'number';

    stream.next();
    return null;
  },
});

// Keep both in-flight and completed loads: reopening a language never fetches its chunk twice.
const languageCache = new Map<string, Promise<LanguageSupport>>();

export const resolveEditorLanguage = (filename: string) => {
  const name = filename.split(/[\\/]/).pop() ?? filename;
  if (name.toLowerCase() === '.env' || name.toLowerCase().startsWith('.env.')) {
    return { name: 'Environment', load: () => Promise.resolve(envLanguage as Extension) };
  }
  if (/^(?:GNUmakefile|Makefile|makefile)$/.test(name)) {
    // Makefile recipes are shell; language-data has no Makefile filename rule.
    return { name: 'Makefile', load: async () => {
      const { shell } = await import('@codemirror/legacy-modes/mode/shell');
      return new LanguageSupport(StreamLanguage.define({
        startState: shell.startState,
        token(stream, state) {
          // The legacy mode ships its own StringStream type; both implementations share this API.
          return shell.token(stream as unknown as Parameters<typeof shell.token>[0], state);
        },
      }));
    } };
  }
  // language-data includes filename rules (Dockerfile) as well as extensions.
  const description = LanguageDescription.matchFilename(languages, name);
  if (!description) return { name: 'Plain Text', load: () => Promise.resolve([] as Extension) };
  return {
    name: description.name,
    load: () => {
      let cached = languageCache.get(description.name);
      if (!cached) {
        cached = description.load().catch((error: unknown) => {
          languageCache.delete(description.name);
          throw error;
        });
        languageCache.set(description.name, cached);
      }
      return cached;
    },
  };
};

export const createMinimapExtension = ({
  file,
  showDiff,
  minimapEnabled,
  isDarkMode,
}: {
  file: CodeEditorFile;
  showDiff: boolean;
  minimapEnabled: boolean;
  isDarkMode: boolean;
}) => {
  if (!file.diffInfo || !showDiff || !minimapEnabled) {
    return [];
  }

  const gutters: Record<number, string> = {};

  return [
    showMinimap.compute(['doc'], (state) => {
      const chunksData = getChunks(state);
      const chunks = chunksData?.chunks || [];

      Object.keys(gutters).forEach((key) => {
        delete gutters[Number(key)];
      });

      chunks.forEach((chunk) => {
        const fromLine = state.doc.lineAt(chunk.fromB).number;
        const toLine = state.doc.lineAt(Math.min(chunk.toB, state.doc.length)).number;

        for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
          gutters[lineNumber] = isDarkMode ? 'rgba(34, 197, 94, 0.8)' : 'rgba(34, 197, 94, 1)';
        }
      });

      return {
        create: () => ({ dom: document.createElement('div') }),
        displayText: 'blocks',
        showOverlay: 'always',
        gutters: [gutters],
      };
    }),
  ];
};

export const createScrollToFirstChunkExtension = ({
  file,
  showDiff,
}: {
  file: CodeEditorFile;
  showDiff: boolean;
}) => {
  if (!file.diffInfo || !showDiff) {
    return [];
  }

  return [
    ViewPlugin.fromClass(class {
      constructor(view: EditorView) {
        // Wait for merge decorations so the first chunk location is stable.
        setTimeout(() => {
          const chunksData = getChunks(view.state);
          const firstChunk = chunksData?.chunks?.[0];

          if (firstChunk) {
            view.dispatch({
              effects: EditorView.scrollIntoView(firstChunk.fromB, { y: 'center' }),
            });
          }
        }, 100);
      }

      update() {}

      destroy() {}
    }),
  ];
};
