// @ts-check
// Render a graph JSON object into an agent/human-readable markdown map.
// Kept intentionally compact: counts, module DI tree, routes, tables.

function section(title) {
  return `\n## ${title}\n`;
}

export function toMarkdown(graph) {
  const { counts, nodes, edges, gitSha, generatedAt } = graph;
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const lines = [];

  lines.push('# rcab code graph');
  lines.push('');
  lines.push(`Generated ${generatedAt} @ ${gitSha}. **Do not hand-edit** — run \`pnpm code:graph\`.`);
  lines.push('');
  lines.push(
    `Nodes: ${counts.nodes} (${Object.entries(counts.byNodeKind).map(([k, v]) => `${v} ${k}`).join(', ')}). ` +
      `Edges: ${counts.edges} (${Object.entries(counts.byEdgeKind).map(([k, v]) => `${v} ${k}`).join(', ')}).`,
  );
  lines.push('');
  lines.push('> Known v1 limit: import edges are syntactic (per-file), so barrel re-exports may under-resolve.');

  // --- Module DI tree ---
  const modules = nodes.filter((n) => n.kind === 'module').sort((a, b) => a.name.localeCompare(b.name));
  if (modules.length) {
    lines.push(section(`NestJS modules (${modules.length})`));
    for (const m of modules) {
      const deps = edges
        .filter((e) => e.from === m.id && e.kind === 'di-import')
        .map((e) => nodesById.get(e.to)?.name ?? e.to)
        .sort();
      lines.push(`- **${m.name}** \`${m.path}\`${deps.length ? ` → ${deps.join(', ')}` : ''}`);
    }
  }

  // --- Routes ---
  const routes = nodes.filter((n) => n.kind === 'route').sort((a, b) => a.name.localeCompare(b.name));
  if (routes.length) {
    lines.push(section(`HTTP routes (${routes.length})`));
    for (const r of routes) {
      lines.push(`- \`${r.meta.method} ${r.meta.path}\` → ${r.meta.controller}.${r.meta.handler} \`${r.path}\``);
    }
  }

  // --- Tables ---
  const tables = nodes.filter((n) => n.kind === 'table').sort((a, b) => a.name.localeCompare(b.name));
  if (tables.length) {
    lines.push(section(`DB tables (${tables.length})`));
    for (const t of tables) {
      const fks = edges
        .filter((e) => e.from === t.id && e.kind === 'fk')
        .map((e) => `${nodesById.get(e.to)?.name ?? e.to}`)
        .sort();
      lines.push(`- **${t.name}** (\`${t.meta.pgName}\`)${fks.length ? ` → ${fks.join(', ')}` : ''}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
