import type { AssetRow } from '../db/schema.js';

/**
 * Shape returned to the frontend — matches `Asset` in
 * frontend/src/types/asset.types.ts so no adapter is needed on the client.
 */
export interface PublicAsset {
  id: string;
  title: string;
  displayTitle: string;
  type: string;
  format: string;
  size: string;
  date: string;
  owner: string;
  visual: string;
  src: string | null;
  tags: string[];
  aiInsight: string | null;
  likes: number;
  downloads: number;
  premium: boolean;
}

export function toPublicAsset(row: AssetRow): PublicAsset {
  return {
    id: row.id,
    title: row.title,
    displayTitle: row.displayTitle,
    type: row.type,
    format: row.format,
    size: row.sizeLabel,
    date: row.date,
    owner: row.ownerLabel,
    visual: row.visual,
    src: row.src,
    tags: row.tags,
    aiInsight: row.aiInsight,
    likes: row.likes,
    downloads: row.downloads,
    premium: row.premium,
  };
}
