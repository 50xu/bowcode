import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';

import { api } from '@/shared/api';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import type { Project } from '@/shared/types';

export type MentionableFile = {
  name: string;
  path: string;
  relativePath?: string;
};

type UseFileMentionsOptions = {
  selectedProject: Project | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export function useFileMentions({ selectedProject, input, setInput, textareaRef }: UseFileMentionsOptions) {
  const projectId = selectedProject?.projectId;
  const [fileMentions, setFileMentions] = useState<string[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<MentionableFile[]>([]);
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);
  // The file-list request still in flight. Starting a new one aborts it, so an
  // older response can never overwrite a newer list.
  const fileListRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const before = input.slice(0, cursorPosition);
    const at = before.lastIndexOf('@');
    const query = at >= 0 ? before.slice(at + 1) : '';
    const active = at >= 0 && !query.includes(' ');
    setShowFileDropdown(active);
    setAtSymbolPosition(active ? at : -1);
    setSelectedFileIndex(-1);
    if (!active || !projectId) { setFilteredFiles([]); return; }
    const controller = new AbortController();
    fileListRequestRef.current?.abort();
    fileListRequestRef.current = controller;
    const timer = setTimeout(async () => {
      try {
        const response = await api.searchFiles(projectId, query, { type: 'file', limit: 10, signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json() as { results: Array<{ name: string; relativePath: string; path: string }> };
        if (!controller.signal.aborted) setFilteredFiles(data.results.map((file) => ({ name: file.name, path: file.relativePath, relativePath: file.path })));
      } catch { /* Stale searches are cancelled as the caret moves. */ }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [projectId, input, cursorPosition]);

  const activeFileMentions = useMemo(() => {
    if (!input || fileMentions.length === 0) {
      return [];
    }
    return fileMentions.filter((path) => input.includes(path));
  }, [fileMentions, input]);

  const sortedFileMentions = useMemo(() => {
    if (activeFileMentions.length === 0) {
      return [];
    }
    const uniqueMentions = Array.from(new Set(activeFileMentions));
    return uniqueMentions.sort((mentionA, mentionB) => mentionB.length - mentionA.length);
  }, [activeFileMentions]);

  const fileMentionRegex = useMemo(() => {
    if (sortedFileMentions.length === 0) {
      return null;
    }
    const pattern = sortedFileMentions.map(escapeRegExp).join('|');
    return new RegExp(`(${pattern})`, 'g');
  }, [sortedFileMentions]);

  const fileMentionSet = useMemo(() => new Set(sortedFileMentions), [sortedFileMentions]);

  const renderInputWithMentions = useCallback(
    (text: string) => {
      if (!text) {
        return '';
      }
      if (!fileMentionRegex) {
        return text;
      }

      const parts = text.split(fileMentionRegex);
      return parts.map((part, index) =>
        fileMentionSet.has(part) ? (
          <span
            key={`mention-${index}`}
            className="-ml-0.5 rounded-md bg-blue-200/70 box-decoration-clone px-0.5 text-transparent dark:bg-blue-300/40"
          >
            {part}
          </span>
        ) : (
          <span key={`text-${index}`}>{part}</span>
        ),
      );
    },
    [fileMentionRegex, fileMentionSet],
  );

  const selectFile = useCallback(
    (file: MentionableFile) => {
      const textBeforeAt = input.slice(0, atSymbolPosition);
      const textAfterAtQuery = input.slice(atSymbolPosition);
      const spaceIndex = textAfterAtQuery.indexOf(' ');
      const textAfterQuery = spaceIndex !== -1 ? textAfterAtQuery.slice(spaceIndex) : '';

      const newInput = `${textBeforeAt}${file.path} ${textAfterQuery}`;
      const newCursorPosition = textBeforeAt.length + file.path.length + 1;

      if (textareaRef.current && !textareaRef.current.matches(':focus')) {
        textareaRef.current.focus();
      }

      setInput(newInput);
      setCursorPosition(newCursorPosition);
      setFileMentions((previousMentions) =>
        previousMentions.includes(file.path) ? previousMentions : [...previousMentions, file.path],
      );

      setShowFileDropdown(false);
      setAtSymbolPosition(-1);

      if (!textareaRef.current) {
        return;
      }

      requestAnimationFrame(() => {
        if (!textareaRef.current) {
          return;
        }
        textareaRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
        if (!textareaRef.current.matches(':focus')) {
          textareaRef.current.focus();
        }
      });
    },
    [input, atSymbolPosition, textareaRef, setInput],
  );

  const handleFileMentionsKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showFileDropdown) {
        return false;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        // The caret is still inside the `@` query, so a refetch landing after
        // this would re-open the dropdown (or first show it, when nothing
        // matched yet) and take the next Enter. Drop it; re-opening the
        // dropdown fetches again.
        fileListRequestRef.current?.abort();
        setShowFileDropdown(false);
        return true;
      }

      if (filteredFiles.length === 0) {
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex < filteredFiles.length - 1 ? previousIndex + 1 : 0,
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex > 0 ? previousIndex - 1 : filteredFiles.length - 1,
        );
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        if (selectedFileIndex >= 0) {
          selectFile(filteredFiles[selectedFileIndex]);
        } else if (filteredFiles.length > 0) {
          selectFile(filteredFiles[0]);
        }
        return true;
      }

      return false;
    },
    [showFileDropdown, filteredFiles, selectedFileIndex, selectFile],
  );

  return {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  };
}
