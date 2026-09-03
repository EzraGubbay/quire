'use client';

import type { HighlightKind } from '@ezragubbay/folio';
import { type GraphEdge, type GraphNode, type NodeType, NoteGraph } from '@ezragubbay/folio';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { GraphData } from '@/lib/graph';
import s from './graph.module.css';

interface SimNode extends SimulationNodeDatum {
  id: string;
}

/** Maps Quire's entity kinds onto the design system's four node shapes. */
const shape: Record<string, NodeType> = {
  document: 'paper',
  note: 'note',
  source: 'source',
  annotation: 'idea',
  run: 'source',
};
/** Quire's annotation types onto the design system's highlight kinds until it ships note/insight/idea. */
const hue: Record<string, HighlightKind> = {
  note: 'claim',
  insight: 'result',
  idea: 'method',
  question: 'question',
  todo: 'todo',
};

export function GraphView({
  data,
  width = 960,
  height = 560,
  legend = true,
}: {
  data: GraphData;
  width?: number;
  height?: number;
  legend?: boolean;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<Set<string>>(new Set(['document', 'note', 'source', 'annotation']));
  const filtered = useMemo(() => {
    const nodes = data.nodes.filter((n) => filter.has(n.kind));
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: data.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  }, [data, filter]);
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());

  useEffect(() => {
    const nodes: SimNode[] = filtered.nodes.map((n, i) => ({
      id: n.id,
      x: width / 2 + Math.cos(i) * 80,
      y: height / 2 + Math.sin(i) * 80,
    }));
    const edges: SimulationLinkDatum<SimNode>[] = filtered.edges.map((e) => ({
      source: e.from,
      target: e.to,
    }));
    const sim = forceSimulation(nodes)
      .force(
        'link',
        forceLink<SimNode, SimulationLinkDatum<SimNode>>(edges)
          .id((d) => d.id)
          .distance(90)
          .strength(0.6),
      )
      .force('charge', forceManyBody().strength(-260))
      .force('collide', forceCollide(34))
      .force('center', forceCenter(width / 2, height / 2))
      .stop();
    const ticks = Math.min(300, 60 + nodes.length * 4);
    for (let i = 0; i < ticks; i++) sim.tick();
    const pad = 40;
    setPositions(
      new Map(
        nodes.map((n) => [
          n.id,
          {
            x: Math.max(pad, Math.min(width - pad, n.x ?? 0)),
            y: Math.max(pad, Math.min(height - pad, n.y ?? 0)),
          },
        ]),
      ),
    );
  }, [filtered, width, height]);

  const nodes: GraphNode[] = filtered.nodes.map((n) => {
    const p = positions.get(n.id) ?? { x: width / 2, y: height / 2 };
    return {
      id: n.id,
      label: n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label,
      type: shape[n.kind] ?? 'note',
      kind: hue[n.hue] ?? 'claim',
      x: p.x,
      y: p.y,
    };
  });
  const edges: GraphEdge[] = filtered.edges.map((e) => ({ from: e.from, to: e.to }));
  const hrefs = new Map(data.nodes.map((n) => [n.id, n.href]));

  return (
    <div className={s.wrap}>
      {legend && (
        <div className={s.filters} role="group" aria-label="Show">
          {(
            [
              ['document', 'Documents'],
              ['note', 'Notes'],
              ['source', 'Sources'],
              ['annotation', 'Ideas & insights'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={s.filter}
              data-active={filter.has(k)}
              aria-pressed={filter.has(k)}
              onClick={() =>
                setFilter((f) => {
                  const next = new Set(f);
                  if (next.has(k)) next.delete(k);
                  else next.add(k);
                  return next;
                })
              }
            >
              {label}
            </button>
          ))}
          <span className={s.count}>
            {filtered.nodes.length} nodes · {filtered.edges.length} links
          </span>
        </div>
      )}
      {nodes.length === 0 ? (
        <p className={s.empty}>
          Nothing to draw yet. Notes, documents, and Idea or Insight annotations appear here; [[wiki links]]
          connect them.
        </p>
      ) : (
        <NoteGraph
          nodes={nodes}
          edges={edges}
          width={width}
          height={height}
          legend={legend}
          onSelect={(id) => router.push(hrefs.get(id) ?? '#')}
        />
      )}
    </div>
  );
}
