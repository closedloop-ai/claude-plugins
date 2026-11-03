/**
 * Precomputes ERD layouts with ELK so the HTML needs no layout library at runtime.
 * "full" lays out every table on one canvas; edges into hub tables are left out of
 * the layout (they are still drawn). "domains" lays out each domain on its own and
 * keeps whichever of left-to-right or top-down fits a screen better.
 */
import * as elkModule from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import type { Domain } from "./domains.js";
import type { ErdModel, Field } from "./model.js";

const ROW_H = 22;
const HEAD_H = 36;
const CHAR_W = 7.3;
const HEAD_CHAR_W = 8.6;
const PAD_X = 14;
const KEY_W = 26;
const GAP = 18;
const MAX_W = 460;
const FIT_W = 1300;
const FIT_H = 860;

// elk.bundled.js is CommonJS whose module.exports is the ELK constructor with a `default`
// property pointing back at itself; that self-reference is what its typings declare.
const ELK = elkModule.default.default;

export interface NodeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  width: number;
  height: number;
  nodes: Record<string, NodeBox>;
  direction?: "RIGHT" | "DOWN";
}

export interface DomainLayouts {
  domains: Domain[];
  layouts: Record<string, Layout>;
}

type Sizer = (name: string) => { w: number; h: number };

function typeLabel(f: Field): string {
  return f.type + (f.list ? "[]" : "") + (f.optional ? "?" : "");
}

function sizer(model: ErdModel, minW: number, headExtra: number): Sizer {
  const byName = new Map(model.models.map((m) => [m.name, m]));
  return (name) => {
    const m = byName.get(name);
    const cols = m ? m.fields.filter((f) => f.kind !== "relation") : [];
    let w = PAD_X * 2 + name.length * HEAD_CHAR_W + headExtra;
    for (const f of cols) {
      w = Math.max(w, PAD_X * 2 + KEY_W + (f.name.length + typeLabel(f).length) * CHAR_W + GAP);
    }
    return { w: Math.min(MAX_W, Math.max(minW, Math.ceil(w))), h: HEAD_H + cols.length * ROW_H + 8 };
  };
}

function toLayout(res: ElkNode): Layout {
  const nodes: Record<string, NodeBox> = Object.create(null);
  for (const c of res.children ?? []) {
    nodes[c.id] = { x: Math.round(c.x ?? 0), y: Math.round(c.y ?? 0), w: c.width ?? 0, h: c.height ?? 0 };
  }
  return { width: Math.round(res.width ?? 0), height: Math.round(res.height ?? 0), nodes };
}

function children(tables: string[], size: Sizer): ElkNode[] {
  return tables.map((t) => {
    const s = size(t);
    return { id: t, width: s.w, height: s.h };
  });
}

export async function fullLayout(model: ErdModel, hubs: ReadonlySet<string>): Promise<Layout> {
  const size = sizer(model, 180, 40);
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "48",
      "elk.layered.spacing.nodeNodeBetweenLayers": "140",
      "elk.spacing.componentComponent": "90",
      "elk.separateConnectedComponents": "true",
      "elk.aspectRatio": "1.6",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    },
    children: children(
      model.models.map((m) => m.name),
      size,
    ),
    edges: model.relations
      .filter((r) => r.parent !== r.child && !hubs.has(r.parent))
      .map((r, i) => ({ id: `e${i}`, sources: [r.parent], targets: [r.child] })),
  };
  return toLayout(await new ELK().layout(graph));
}

async function domainLayout(
  elk: InstanceType<typeof ELK>,
  model: ErdModel,
  size: Sizer,
  d: Domain,
  direction: "RIGHT" | "DOWN",
): Promise<Layout> {
  const members = new Set(d.tables);
  const graph: ElkNode = {
    id: d.id,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "120",
      "elk.spacing.componentComponent": "70",
      "elk.separateConnectedComponents": "true",
      "elk.aspectRatio": "1.7",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    },
    children: children(d.tables, size),
    edges: model.relations
      .filter((r) => r.parent !== r.child && members.has(r.parent) && members.has(r.child))
      .map((r, i) => ({ id: `e${i}`, sources: [r.parent], targets: [r.child] })),
  };
  return toLayout(await elk.layout(graph));
}

/** Domains that exist in the model, with any table the map leaves out appended as "Unsorted". */
export function placedDomains(model: ErdModel, domainMap: Domain[]): Domain[] {
  const names = new Set(model.models.map((m) => m.name));
  const assigned = new Set<string>();
  const out: Domain[] = [];
  for (const d of domainMap) {
    const tables = d.tables.filter((t) => names.has(t) && !assigned.has(t));
    for (const t of tables) assigned.add(t);
    if (tables.length) out.push({ id: d.id, name: d.name, tables });
  }
  const unsorted = model.models.map((m) => m.name).filter((n) => !assigned.has(n));
  if (unsorted.length) out.push({ id: "unsorted", name: "Unsorted", tables: unsorted });
  return out;
}

export async function domainLayouts(model: ErdModel, domainMap: Domain[]): Promise<DomainLayouts> {
  const elk = new ELK();
  const size = sizer(model, 190, 60);
  const domains = placedDomains(model, domainMap);
  const layouts: Record<string, Layout> = Object.create(null);
  const fit = (l: Layout): number => Math.min(FIT_W / l.width, FIT_H / l.height);
  for (const d of domains) {
    const right = await domainLayout(elk, model, size, d, "RIGHT");
    const down = await domainLayout(elk, model, size, d, "DOWN");
    const pick = fit(down) > fit(right) * 1.1 ? down : right;
    pick.direction = pick === down ? "DOWN" : "RIGHT";
    layouts[d.id] = pick;
  }
  return { domains, layouts };
}
