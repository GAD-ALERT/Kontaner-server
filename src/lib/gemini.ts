import {
  GoogleGenerativeAI,
  TaskType,
  type Part,
} from '@google/generative-ai';
import { env } from '../env.js';

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

/* =========================================================
   Model handles
   - GEMINI_VISION_MODEL: multimodal — accepts an image + prompt,
     returns structured JSON. Best speed/cost/quality for tagging.
   - GEMINI_EMBEDDING_MODEL: vectors for natural-language search.
   ========================================================= */
const visionModel = genAI.getGenerativeModel({
  model: env.GEMINI_VISION_MODEL,
  generationConfig: {
    responseMimeType: 'application/json',
    temperature: 0.3,
    topP: 0.9,
  },
});

const embeddingModel = genAI.getGenerativeModel({
  model: env.GEMINI_EMBEDDING_MODEL,
});

/* =========================================================
   Prompt: image → { tags[], insight, dominantMood }
   Kept short so latency stays under 2s at flash tier.
   ========================================================= */
const TAG_PROMPT = `
You are Kontaner, a Ghana-focused creative-asset AI. Given an image,
respond with strict JSON in this exact shape (no extra keys, no comments):

{
  "tags": string[],          // 5–8 short tags. Prefer proper nouns for
                             // places/cultures ("Kente Fabric", "Accra")
                             // over generic terms ("photo", "image").
  "insight": string,         // 1–2 sentence description a designer would
                             // paste into a caption. Do not restate the tags.
  "dominantMood": string     // one word: "vibrant" | "serene" | "gritty" |
                             // "editorial" | "documentary" | "playful" | …
}

Do not include markdown, code fences, or preamble. Only the JSON object.
`.trim();

export interface TagAndDescribeResult {
  tags: string[];
  insight: string;
  dominantMood: string;
}

/**
 * Sends an image to Gemini and returns structured tags + insight.
 * Falls back to a filename-derived guess if the model call fails so
 * the upload flow never breaks completely.
 */
export async function tagAndDescribeImage(
  imageBuffer: Buffer,
  mimeType: string,
  fallbackTitle = 'Untitled asset',
): Promise<TagAndDescribeResult> {
  const imagePart: Part = {
    inlineData: {
      data: imageBuffer.toString('base64'),
      mimeType,
    },
  };

  try {
    const result = await visionModel.generateContent([
      { text: TAG_PROMPT },
      imagePart,
    ]);
    const text = result.response.text().trim();
    const parsed = JSON.parse(text) as Partial<TagAndDescribeResult>;

    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter((t): t is string => typeof t === 'string').slice(0, 8)
      : [];
    const insight = typeof parsed.insight === 'string' ? parsed.insight : '';
    const dominantMood =
      typeof parsed.dominantMood === 'string' ? parsed.dominantMood : 'editorial';

    if (tags.length === 0) {
      // Model returned an empty list — synthesise a plausible tag from filename
      tags.push(...fallbackTagsFromTitle(fallbackTitle));
    }

    return { tags, insight, dominantMood };
  } catch (err) {
    console.warn('[gemini] tagAndDescribeImage failed, using fallback:', err);
    return {
      tags: fallbackTagsFromTitle(fallbackTitle),
      insight: `A new upload titled "${fallbackTitle}". Auto-tagging is temporarily unavailable — you can add tags manually.`,
      dominantMood: 'editorial',
    };
  }
}

/* =========================================================
   Embeddings for NL search (Day 4 upgrades /assets/search).
   Returned as a plain number[] so it stores cleanly as JSONB.
   ========================================================= */

/**
 * Which side of the retrieval pair a text belongs to. Gemini's embedding
 * model produces sharper matches when the stored asset and the search query
 * are embedded with different task types, so callers must be explicit:
 *   - 'document' → the catalogue text we persist (default)
 *   - 'query'    → the user's search string at query time
 */
export type EmbedTask = 'document' | 'query';

const TASK_TYPE: Record<EmbedTask, TaskType> = {
  document: TaskType.RETRIEVAL_DOCUMENT,
  query: TaskType.RETRIEVAL_QUERY,
};

export async function embedText(
  text: string,
  task: EmbedTask = 'document',
): Promise<number[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const result = await embeddingModel.embedContent({
    content: { role: 'user', parts: [{ text: trimmed }] },
    taskType: TASK_TYPE[task],
  });
  return result.embedding.values ?? [];
}

/** Batch embed — one API call per string but parallelised. */
export async function embedTexts(
  texts: string[],
  task: EmbedTask = 'document',
): Promise<number[][]> {
  return Promise.all(texts.map((t) => embedText(t, task)));
}

/* =========================================================
   Helpers
   ========================================================= */

function fallbackTagsFromTitle(title: string): string[] {
  const cleaned = title
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_\-]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^\d+$/.test(w))
    .slice(0, 5);
  return cleaned.length > 0 ? cleaned : ['upload'];
}
