/** Where the panel lives: under the sidebar's tabs (default), as a sidebar tab, or a pane right of the preview. */
export type Placement = 'tab' | 'below' | 'right';
export const PLACEMENTS: { id: Placement; label: string }[] = [
  { id: 'below', label: 'Sidebar, below the tabs' },
  { id: 'tab', label: 'Sidebar tab' },
  { id: 'right', label: 'Right of the preview' },
];
export const isPlacement = (v: unknown): v is Placement => v === 'tab' || v === 'below' || v === 'right';
