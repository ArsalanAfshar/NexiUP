export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:sockets') return { url: new URL('./sockets.mjs', import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}

// Cloudflare entry modules may not export scalar constants. Test-only instrumentation
// exposes private helpers without changing the deployable, single-file module.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (['worker.js','manager-worker.js','node-worker.js'].some(name => url === new URL('../'+name, import.meta.url).href)) {
    const source = String(result.source);
    const names = [...source.matchAll(/^(?:(?:async )?function|class|const) ([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
    return { ...result, source: source + '\nexport { ' + [...new Set(names)].join(', ') + ' };\n' };
  }
  return result;
}
