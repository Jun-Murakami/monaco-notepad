declare module 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js' {
  export const javascriptDefaults: {
    setDiagnosticsOptions: (options: unknown) => void;
  };

  export const typescriptDefaults: {
    setDiagnosticsOptions: (options: unknown) => void;
    setCompilerOptions: (options: unknown) => void;
    setEagerModelSync: (value: boolean) => void;
  };

  export const ScriptTarget: {
    Latest: number;
  };

  export const ModuleResolutionKind: {
    NodeJs: number;
  };

  export const ModuleKind: {
    CommonJS: number;
  };

  export const JsxEmit: {
    React: number;
  };
}
