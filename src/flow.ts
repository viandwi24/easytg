/**
 * The flow of a bot as a Mermaid diagram: its pages and dialogues, the
 * /commands and menu buttons that open them, and the buttons, redirects and
 * dialogue starts seen while it ran.
 */

/** How one screen leads to another. */
export type FlowEdgeKind = 'button' | 'redirect' | 'dialogue' | 'command' | 'menu';

export interface FlowEdge {
  from: string;
  to: string;
  kind: FlowEdgeKind;
  /** A button's label, a /command. */
  label?: string;
}

export interface FlowchartOptions {
  /** `LR` (left to right, default) or `TD` (top down). */
  direction?: 'LR' | 'TD';
  /** Include what was seen while the bot ran (buttons, redirects). Default true; false: only commands and the menu. */
  observed?: boolean;
}

/** Edges seen while the bot ran, deduplicated. */
export class FlowRecorder {
  private readonly edges = new Map<string, FlowEdge>();

  record(edge: FlowEdge) {
    if (edge.from === edge.to) return; // nav.self, pagination: the same screen
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.label ?? ''}`;
    if (!this.edges.has(key)) this.edges.set(key, edge);
  }

  get all(): FlowEdge[] {
    return [...this.edges.values()];
  }
}

const quote = (text: string) => `"${text.replace(/"/g, '#quot;').replace(/\n/g, ' ')}"`;

/** A Mermaid `flowchart`: paste it into GitHub Markdown, mermaid.live, or your docs. */
export function toMermaid(input: { pages: string[]; dialogues: string[]; edges: FlowEdge[]; direction?: 'LR' | 'TD' }): string {
  const ids = new Map<string, string>();
  const lines = [`flowchart ${input.direction ?? 'LR'}`];
  const node = (key: string, shape: (label: string) => string, label: string) => {
    if (ids.has(key)) return ids.get(key)!;
    const id = `n${ids.size}`;
    ids.set(key, id);
    lines.push(`  ${id}${shape(quote(label))}`);
    return id;
  };
  let missing = false;
  const screen = (id: string) => {
    if (input.dialogues.includes(id)) return node(`screen:${id}`, (l) => `([${l}])`, `📝 ${id}`);
    if (input.pages.includes(id)) return node(`screen:${id}`, (l) => `[${l}]`, id);
    // Linked to, but never registered: pressing its button fails.
    missing = true;
    return node(`screen:${id}`, (l) => `[${l}]:::missing`, `⚠️ ${id} (not registered)`);
  };

  for (const id of input.pages) screen(id);
  for (const id of input.dialogues) screen(id);
  for (const edge of input.edges) {
    const from =
      edge.kind === 'command'
        ? node(`command:${edge.from}`, (l) => `[/${l}/]`, edge.from)
        : edge.kind === 'menu'
          ? node(`menu:${edge.from}`, (l) => `>${l}]`, edge.from)
          : screen(edge.from);
    const to = screen(edge.to);
    const label = edge.kind === 'button' && edge.label ? `|${quote(edge.label)}|` : edge.kind === 'redirect' ? '|redirect|' : '';
    const arrow = edge.kind === 'redirect' ? '-.->' : edge.kind === 'dialogue' ? '==>' : '-->';
    lines.push(`  ${from} ${arrow}${label} ${to}`);
  }
  if (missing) lines.push('  classDef missing stroke:#e5484d,stroke-width:2px,stroke-dasharray:4');
  return lines.join('\n');
}

/** A link that opens the diagram in the Mermaid Live Editor. */
export function mermaidLiveUrl(diagram: string): string {
  const json = JSON.stringify({ code: diagram, mermaid: { theme: 'default' } });
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `https://mermaid.live/edit#base64:${btoa(binary)}`;
}
