// @ts-check
// Tiny in-memory graph accumulator. Nodes are unique by id; edges are unique by
// (from|to|kind). Extractors push into one shared instance during the file walk.

export class Graph {
  constructor() {
    /** @type {Map<string, any>} */
    this.nodes = new Map();
    /** @type {Map<string, any>} */
    this.edges = new Map();
  }

  /** Add or merge a node. Later meta shallow-merges over earlier. */
  addNode(node) {
    const existing = this.nodes.get(node.id);
    if (existing) {
      existing.meta = { ...existing.meta, ...node.meta };
      // keep the richest kind: a bare 'file' can be upgraded to 'module' etc.
      if (existing.kind === 'file' && node.kind && node.kind !== 'file') existing.kind = node.kind;
      return existing;
    }
    const created = { meta: {}, ...node };
    this.nodes.set(node.id, created);
    return created;
  }

  addEdge(from, to, kind, meta = {}) {
    const key = `${from}\t${to}\t${kind}`;
    const existing = this.edges.get(key);
    if (existing) {
      existing.meta = { ...existing.meta, ...meta };
      return existing;
    }
    const edge = { from, to, kind, meta };
    this.edges.set(key, edge);
    return edge;
  }

  /** Serialize to the committed artifact shape. Deterministic ordering. */
  toJSON({ gitSha, generatedAt }) {
    const nodes = [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
    const edges = [...this.edges.values()].sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
    );
    const byNodeKind = {};
    for (const n of nodes) byNodeKind[n.kind] = (byNodeKind[n.kind] ?? 0) + 1;
    const byEdgeKind = {};
    for (const e of edges) byEdgeKind[e.kind] = (byEdgeKind[e.kind] ?? 0) + 1;
    return {
      version: 1,
      generatedAt,
      gitSha,
      counts: { nodes: nodes.length, edges: edges.length, byNodeKind, byEdgeKind },
      nodes,
      edges,
    };
  }
}
