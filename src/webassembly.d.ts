// The parts of the WebAssembly JS API this project uses. Node has all of it,
// but its type definitions come only with the DOM library, which is left out.

declare namespace WebAssembly {
  type ImportExportKind = "function" | "table" | "memory" | "global" | "tag";
  interface ModuleImportDescriptor {
    module: string;
    name: string;
    kind: ImportExportKind;
  }
  interface ModuleExportDescriptor {
    name: string;
    kind: ImportExportKind;
  }
  class Module {
    constructor(bytes: BufferSource);
    static imports(module: Module): ModuleImportDescriptor[];
    static exports(module: Module): ModuleExportDescriptor[];
  }
  class Instance {
    constructor(module: Module, imports?: Imports);
    readonly exports: Record<string, unknown>;
  }
  class Memory {
    readonly buffer: ArrayBuffer;
  }
  class RuntimeError extends Error {}
  type ImportValue = ((...args: any[]) => unknown) | Memory | number;
  type Imports = Record<string, Record<string, ImportValue>>;
  type BufferSource = ArrayBufferView | ArrayBuffer;
  function compile(bytes: BufferSource): Promise<Module>;
}
