/** Types shared with the Worker (backend/src/sync.ts). Keep the two in step. */
export type ItemKind = 'link' | 'text' | 'image';
export type Entity = 'collections' | 'items';

export const UNCATEGORIZED_ID = 'uncategorized';

export interface Collection {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  hlc: string;
}

export interface Item {
  id: string;
  collection_id: string;
  subject: string;
  kind: ItemKind;
  /** URL for links, the text for text, a JPEG data URL for images. */
  content: string;
  tags: string[];
  notes: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  hlc: string;
}

export type Row = Collection | Item;

export interface PushOp {
  entity: Entity;
  row: Row;
}

export interface PullOp {
  seq: number;
  entity: Entity;
  row: Row;
}

export interface User {
  id: string;
  email: string;
  display_name: string;
}

export interface ClassifyResult {
  collectionId: string | null;
  tags: string[];
  notes: string;
}
