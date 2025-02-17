import { useCallback, useRef, useState, useEffect } from 'react';
import { useMonaco, type Monaco } from '@monaco-editor/react';
import type { Note, FileNote } from '../types';

interface ModelInfo {
  model: ReturnType<Monaco['editor']['createModel']>;
  language: string;
}

export const useEditorModels = () => {
  // モデルをメモリ上で管理するためのMap
  const modelMapRef = useRef(new Map<string, ModelInfo>());
  const [monaco, setMonaco] = useState<Monaco | null>(null);

  const m = useMonaco();

  useEffect(() => {
    if (m) {
      setMonaco(m);
    }
  }, [m]);

  // 新しいモデルを作成または既存のモデルを取得
  const getOrCreateModel = useCallback((note: Note | FileNote): ModelInfo => {
    if (!monaco) {
      throw new Error('Monaco is not initialized');
    }

    const modelMap = modelMapRef.current;
    if (modelMap.has(note.id)) {
      return modelMap.get(note.id) as ModelInfo;
    }

    const model = monaco.editor.createModel(
      note.content || '',
      note.language || 'plaintext'
    );

    const modelInfo: ModelInfo = {
      model,
      language: note.language || 'plaintext',
    };

    modelMap.set(note.id, modelInfo);

    const editor = monaco.editor.getEditors()[0];
    if (!editor) {
      throw new Error('Editor is not initialized');
    }

    editor.setModel(model);

    return modelInfo;
  }, [monaco]);

  // モデルの言語を更新
  const updateModelLanguage = useCallback((noteId: string, language: string) => {
    if (!monaco) {
      throw new Error('Monaco is not initialized');
    }

    const modelInfo = modelMapRef.current.get(noteId);
    if (modelInfo) {
      monaco.editor.setModelLanguage(modelInfo.model, language);
      modelInfo.language = language;
    }
  }, [monaco]);

  // モデルの内容を更新
  const updateModelContent = useCallback((noteId: string, content: string) => {
    const modelInfo = modelMapRef.current.get(noteId);
    if (modelInfo) {
      modelInfo.model.setValue(content);
    }
  }, []);

  // モデルを破棄
  const disposeModel = useCallback((noteId: string) => {
    const modelMap = modelMapRef.current;
    const modelInfo = modelMap.get(noteId);
    if (modelInfo) {
      // モデルが既に破棄されていないことを確認
      if (!modelInfo.model.isDisposed()) {
        modelInfo.model.dispose();
      }
      modelMap.delete(noteId);
    }
  }, []);

  // すべてのモデルを破棄
  const disposeAllModels = useCallback(() => {
    const modelMap = modelMapRef.current;
    for (const [noteId, modelInfo] of modelMap) {
      if (!modelInfo.model.isDisposed()) {
        modelInfo.model.dispose();
      }
    }
    modelMap.clear();
  }, []);

  return {
    getOrCreateModel,
    updateModelLanguage,
    updateModelContent,
    disposeModel,
    disposeAllModels,
  };
}; 