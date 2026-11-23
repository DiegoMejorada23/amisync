import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { compileProtobufAotEntries } from '../build/protobufCspAotPlugin.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(EXT_ROOT, 'dist');
const SRC_AMIS_DIR = path.join(EXT_ROOT, 'src', 'amis');

function collectFilesRecursive(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFilesRecursive(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

describe('Milestone 6: Chrome Manifest V3 & Production Bundle Audit', () => {
  it('audits dist/manifest.json for strict MV3 compliance, minimal permissions, and valid resources', () => {
    const manifestPath = path.join(DIST_DIR, 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'dist/manifest.json must exist after build');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      manifest_version: number;
      name: string;
      permissions: string[];
      host_permissions?: string[];
      icons: Record<string, string>;
      background?: { service_worker: string; type?: string };
      action?: { default_popup?: string };
      side_panel?: { default_path?: string };
      content_scripts?: Array<{ matches: string[]; js: string[] }>;
      web_accessible_resources?: Array<{ resources: string[]; matches: string[] }>;
      content_security_policy?: { extension_pages?: string };
    };

    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual([...manifest.permissions].sort(), [
      'activeTab',
      'scripting',
      'sidePanel',
      'storage',
    ]);
    assert.deepEqual(manifest.host_permissions, ['https://amis.uplb.edu.ph/*']);

    const csp = manifest.content_security_policy?.extension_pages ?? '';
    assert.ok(csp.includes("script-src 'self' 'wasm-unsafe-eval'"));
    assert.ok(csp.includes("object-src 'self'"));
    assert.equal(csp.includes('unsafe-eval'), true); // specifically wasm-unsafe-eval only
    assert.equal(/(?<!wasm-)unsafe-eval/.test(csp), false);
    assert.equal(csp.includes('unsafe-inline'), false);

    // Verify web_accessible_resources includes index.html and assets/* for CP-SAT wasm + worker
    const war = manifest.web_accessible_resources ?? [];
    assert.ok(
      war.some(
        (entry) =>
          entry.resources.includes('index.html') &&
          entry.resources.includes('assets/*') &&
          entry.matches.includes('https://amis.uplb.edu.ph/*')
      )
    );

    // Verify all declared entrypoints and icons exist in dist/
    const referencedFiles = [
      ...Object.values(manifest.icons),
      manifest.background?.service_worker,
      manifest.action?.default_popup,
      manifest.side_panel?.default_path,
      ...(manifest.content_scripts?.flatMap((cs) => cs.js) ?? []),
    ].filter((f): f is string => typeof f === 'string' && f.length > 0);

    for (const relPath of referencedFiles) {
      const absPath = path.join(DIST_DIR, relPath);
      assert.ok(fs.existsSync(absPath), `Referenced manifest file missing in dist/: ${relPath}`);
      assert.ok(fs.statSync(absPath).size > 0, `Referenced manifest file is empty: ${relPath}`);
    }
  });

  it('audits dist/index.html and all bundled JS/CSS assets for zero inline scripts, zero eval/Function(), zero external CDNs, and valid .wasm binaries', () => {
    const htmlPath = path.join(DIST_DIR, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    // Every <script> tag must have a relative src attribute and no inline JS body
    const scriptTags = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
    assert.ok(scriptTags.length >= 1);
    for (const tag of scriptTags) {
      assert.ok(/src=["']\.\/assets\/[^"']+["']/.test(tag), `Unexpected script tag: ${tag}`);
      const inner = tag.replace(/<script\b[^>]*>|<\/script>/gi, '').trim();
      assert.equal(inner, '', 'Inline script content is forbidden by MV3 CSP');
    }

    assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'Inline event handlers forbidden in HTML');
    assert.equal(/https?:\/\//i.test(html), false, 'External HTTP(S) references forbidden in HTML');

    const distFiles = collectFilesRecursive(DIST_DIR);
    const wasmFiles = distFiles.filter((f) => f.endsWith('.wasm'));
    assert.ok(wasmFiles.length >= 1, 'Expected at least one compiled CP-SAT .wasm binary in dist/');
    for (const wasmPath of wasmFiles) {
      assert.ok(fs.statSync(wasmPath).size > 100_000, `WASM binary unexpectedly small: ${wasmPath}`);
    }

    const codeFiles = distFiles.filter((f) => f.endsWith('.js') || f.endsWith('.css'));
    assert.ok(codeFiles.length >= 4);

    for (const filePath of codeFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const rel = path.relative(DIST_DIR, filePath);

      assert.equal(
        /(?:rsms\.me|fonts\.googleapis|fonts\.gstatic|unpkg\.com|cdn\.jsdelivr|cdnjs\.cloudflare)/i.test(
          content
        ),
        false,
        `External CDN reference found in ${rel}`
      );

      if (filePath.endsWith('.js')) {
        assert.equal(
          /\beval\s*\(/.test(content),
          false,
          `eval() call found in ${rel}`
        );
        assert.equal(
          /\bnew\s+Function\b/.test(content),
          false,
          `new Function found in ${rel}`
        );
        assert.equal(
          /\bFunction\s*\(/.test(content),
          false,
          `Function(...) call found in ${rel}`
        );
        assert.equal(
          /\bFunction\.apply\b/.test(content),
          false,
          `Function.apply found in ${rel}`
        );
      }
    }
  });

  it('verifies AOT protobufjs compiler covers all 31 OR-Tools protobuf schemas cleanly in strict mode', async () => {
    const entries = await compileProtobufAotEntries();
    // 31 protobuf Types * up to 6 methods (some may deduplicate or share keys)
    assert.ok(entries.length >= 150, `Expected >= 150 compiled protobuf entries, got ${entries.length}`);

    const solverWorkerFile = collectFilesRecursive(DIST_DIR).find((f) =>
      /[\\/]solver\.worker-[^\\/]+\.js$/.test(f)
    );
    assert.ok(solverWorkerFile, 'Built solver.worker bundle must exist in dist/assets/');
    const workerSource = fs.readFileSync(solverWorkerFile, 'utf8');

    for (const entry of entries) {
      // Compile each generated function inside an isolated strict-mode VM script to ensure syntax safety.
      const code = `"use strict"; (${entry.source});`;
      assert.doesNotThrow(() => new vm.Script(code), `Invalid JS syntax in ${entry.typeName}.${entry.methodName}`);
      assert.ok(
        workerSource.includes(entry.key),
        `Built solver.worker bundle missing AOT key ${entry.key} for ${entry.typeName}.${entry.methodName}`
      );
    }
  });

  it('verifies AMIS portal integration remains strictly read-only (zero POST/PUT/DELETE/PATCH)', () => {
    const amisFiles = collectFilesRecursive(SRC_AMIS_DIR).filter((f) => f.endsWith('.ts'));
    assert.ok(amisFiles.length >= 4);
    for (const filePath of amisFiles) {
      const source = fs.readFileSync(filePath, 'utf8');
      assert.equal(
        /method\s*:\s*['"`](?:POST|PUT|DELETE|PATCH)['"`]/i.test(source),
        false,
        `Mutating HTTP method found in ${path.basename(filePath)}`
      );
    }
  });
});
