import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

export interface CompiledCodegenEntry {
  key: string;
  typeName: string;
  methodName: string;
  scopeKeys: string[];
  source: string;
}

const require = createRequire(import.meta.url);

function normalizeSource(source: string): string {
  return source.replace(/\r\n/g, '\n');
}

/**
 * Deterministic double-32-bit FNV-1a hash used to key AOT-compiled protobufjs functions
 * by their exact generated source and scope keys without shipping duplicate source strings
 * or invoking `Function()` at runtime.
 */
export function hashCodegenKey(source: string, scopeKeys: readonly string[]): string {
  const payload = `${scopeKeys.join(',')}\0${normalizeSource(source)}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    const c = payload.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c ^ ((i & 0xff) + 1);
    h2 = Math.imul(h2, 0x01000193);
  }
  return `${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}`;
}

/**
 * Walks all protobuf `Type` nodes in the `or-tools-wasm` CP-SAT schemas (`cp_model` and
 * `sat_parameters`) and ahead-of-time extracts every `protobufjs` generated constructor,
 * encoder, decoder, verifier, fromObject, and toObject function.
 */
export async function compileProtobufAotEntries(): Promise<CompiledCodegenEntry[]> {
  const { CpSat, setCloudNoticeEnabled, setSingleThreadWarningEnabled } = await import(
    'or-tools-wasm/cp-sat'
  );
  setCloudNoticeEnabled(false);
  setSingleThreadWarningEnabled(false);

  const schemas = await CpSat.getSchemas();
  const pb = require('protobufjs') as typeof import('protobufjs');
  const encoder = require('protobufjs/src/encoder') as (mtype: unknown) => { toString(): string };
  const decoder = require('protobufjs/src/decoder') as (mtype: unknown) => { toString(): string };
  const verifier = require('protobufjs/src/verifier') as (mtype: unknown) => { toString(): string };
  const converter = require('protobufjs/src/converter') as {
    fromObject(mtype: unknown): { toString(): string };
    toObject(mtype: unknown): { toString(): string };
  };

  interface WalkableNamespace {
    nestedArray?: WalkableNamespace[];
    fullName?: string;
    _edition?: string;
    _needsRecursiveFeatureResolution?: boolean;
    _resolveFeaturesRecursive?(edition: string): void;
    fieldsArray?: Array<{ resolve(): unknown }>;
    ctor?: unknown;
    root?: WalkableNamespace;
  }

  const roots = [pb.parse(schemas.cp_model).root, pb.parse(schemas.sat_parameters).root];
  const types: WalkableNamespace[] = [];

  const collectTypes = (ns: WalkableNamespace) => {
    if (ns instanceof pb.Type) {
      types.push(ns);
    }
    if (Array.isArray(ns.nestedArray)) {
      for (const child of ns.nestedArray) {
        collectTypes(child);
      }
    }
  };

  for (const root of roots) {
    collectTypes(root as unknown as WalkableNamespace);
  }

  const byKey = new Map<string, CompiledCodegenEntry>();

  const register = (
    typeName: string,
    methodName: string,
    scopeKeys: string[],
    rawSource: string
  ) => {
    const source = normalizeSource(rawSource);
    const key = hashCodegenKey(source, scopeKeys);
    const existing = byKey.get(key);
    if (existing) {
      if (
        existing.source !== source ||
        existing.scopeKeys.join(',') !== scopeKeys.join(',')
      ) {
        throw new Error(
          `AMISync AOT protobufjs hash collision detected for ${typeName}.${methodName}`
        );
      }
      return;
    }
    byKey.set(key, { key, typeName, methodName, scopeKeys, source });
  };

  for (const type of types) {
    const root = type.root;
    if (root && root._needsRecursiveFeatureResolution && root._resolveFeaturesRecursive) {
      const edition = root._edition || type._edition;
      if (edition) {
        root._resolveFeaturesRecursive(edition);
      }
    }
    if (Array.isArray(type.fieldsArray)) {
      for (const field of type.fieldsArray) {
        field.resolve();
      }
    }
    // Trigger ctor/oneof resolution identically to Type.prototype.setup()
    void type.ctor;

    const typeName = type.fullName ?? 'UnknownType';
    register(
      typeName,
      'ctor',
      [],
      (pb.Type as unknown as { generateConstructor(t: unknown): { toString(): string } })
        .generateConstructor(type)
        .toString()
    );
    register(typeName, 'encode', ['Writer', 'types', 'util'], encoder(type).toString());
    register(typeName, 'decode', ['Reader', 'types', 'util', 'C'], decoder(type).toString());
    register(typeName, 'verify', ['types', 'util'], verifier(type).toString());
    register(typeName, 'fromObject', ['types', 'util', 'C'], converter.fromObject(type).toString());
    register(typeName, 'toObject', ['types', 'util'], converter.toObject(type).toString());
  }

  return Array.from(byKey.values());
}

function renderAotPreamble(entries: readonly CompiledCodegenEntry[]): string {
  const hashFn = [
    'function __amisyncHashCodegen(source, scopeKeys) {',
    '  var payload = scopeKeys.join(",") + "\\0" + String(source).replace(/\\r\\n/g, "\\n");',
    '  var h1 = 0x811c9dc5;',
    '  var h2 = 0x811c9dc5;',
    '  for (var i = 0; i < payload.length; i++) {',
    '    var c = payload.charCodeAt(i);',
    '    h1 ^= c;',
    '    h1 = Math.imul(h1, 0x01000193);',
    '    h2 ^= c ^ ((i & 255) + 1);',
    '    h2 = Math.imul(h2, 0x01000193);',
    '  }',
    '  return (h1 >>> 0).toString(36) + "_" + (h2 >>> 0).toString(36);',
    '}',
  ].join('\n');

  const tableEntries = entries.map((entry) => {
    if (entry.scopeKeys.length === 0) {
      return `  ${JSON.stringify(entry.key)}: function() {\n    return (${entry.source});\n  }`;
    }
    const bindings = entry.scopeKeys.map((k) => `${k} = __s.${k}`).join(', ');
    return `  ${JSON.stringify(entry.key)}: function(__s) {\n    var ${bindings};\n    return (${entry.source});\n  }`;
  });

  return `${hashFn}\nvar __AMISYNC_AOT_CODEGEN = {\n${tableEntries.join(',\n')}\n};\n`;
}

const TARGET_FILE_RE = /or-tools-wasm[\\/]build[\\/]javascript[\\/]browser[\\/]cp-sat\.js$/;
const CODEGEN_EXEC_RE =
  /if \(typeof formatStringOrScope != "string"\) \{\s*var source = toString\(\);\s*if \(codegen\.verbose && console\.log\("codegen: " \+ source\), source = "return " \+ source, formatStringOrScope\) \{\s*for \(var scopeKeys = Object\.keys\(formatStringOrScope\), scopeParams = new Array\(scopeKeys\.length \+ 1\), scopeValues = new Array\(scopeKeys\.length\), scopeOffset = 0; scopeOffset < scopeKeys\.length; \)\s*scopeParams\[scopeOffset\] = scopeKeys\[scopeOffset\], scopeValues\[scopeOffset\] = formatStringOrScope\[scopeKeys\[scopeOffset\+\+\]\];\s*return scopeParams\[scopeOffset\] = source, Function\.apply\(null, scopeParams\)\.apply\(null, scopeValues\);\s*\}\s*return Function\(source\)\(\);\s*\}/;

/**
 * Vite/Rollup plugin that replaces `protobufjs`'s runtime `Function(...)` codegen inside
 * `or-tools-wasm/build/javascript/browser/cp-sat.js` with AOT-compiled static functions so the
 * production Chrome Extension Web Worker runs cleanly under strict MV3 CSP (no `unsafe-eval`).
 */
export function protobufCspAotPlugin(): Plugin {
  let cachedPreamblePromise: Promise<string> | null = null;

  const getPreamble = () => {
    if (!cachedPreamblePromise) {
      cachedPreamblePromise = compileProtobufAotEntries().then(renderAotPreamble);
    }
    return cachedPreamblePromise;
  };

  return {
    name: 'amisync-protobuf-csp-aot',
    enforce: 'pre',
    async transform(code, id) {
      const cleanId = id.split('?')[0];
      if (!TARGET_FILE_RE.test(cleanId)) {
        return null;
      }

      if (!CODEGEN_EXEC_RE.test(code)) {
        throw new Error(
          'AMISync MV3 CSP plugin could not locate protobufjs runtime codegen block in or-tools-wasm cp-sat.js.'
        );
      }

      const preamble = await getPreamble();
      const replacement = [
        'if (typeof formatStringOrScope != "string") {',
        '          var source = toString();',
        '          if (codegen.verbose) console.log("codegen: " + source);',
        '          var scopeKeys = formatStringOrScope ? Object.keys(formatStringOrScope) : [];',
        '          var aotKey = __amisyncHashCodegen(source, scopeKeys);',
        '          var aotFactory = __AMISYNC_AOT_CODEGEN[aotKey];',
        '          if (!aotFactory) throw new Error("AMISync AOT protobufjs cache miss: " + aotKey + " (" + scopeKeys.join(",") + ")");',
        '          return aotFactory(formatStringOrScope);',
        '        }',
      ].join('\n');

      const transformed = `${preamble}\n${code.replace(CODEGEN_EXEC_RE, replacement)}`;
      if (/\bFunction\.apply\b|\bFunction\(source\)/.test(transformed)) {
        throw new Error(
          'AMISync MV3 CSP plugin failed to eliminate all Function() calls from cp-sat.js.'
        );
      }

      return {
        code: transformed,
        map: null,
      };
    },
  };
}
