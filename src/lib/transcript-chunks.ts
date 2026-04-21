import crypto from "crypto";
import { db } from "@/lib/db";
import { generateEmbeddings } from "@/lib/embeddings";

const TRANSCRIPT_CHUNK_TARGET_CHARS = 2_400;
const TRANSCRIPT_CHUNK_OVERLAP_CHARS = 350;
const TRANSCRIPT_CHUNK_MIN_CHARS = 300;
const EMBEDDING_BATCH_SIZE = 48;
const MAX_CHUNK_KEYWORDS = 12;

const KEYWORD_STOPWORDS = new Set([
  "about",
  "actually",
  "again",
  "also",
  "because",
  "being",
  "class",
  "course",
  "does",
  "doing",
  "going",
  "have",
  "here",
  "just",
  "kind",
  "know",
  "lecture",
  "like",
  "mean",
  "much",
  "okay",
  "really",
  "right",
  "said",
  "same",
  "should",
  "something",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "thing",
  "think",
  "this",
  "those",
  "want",
  "we're",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "you're",
]);

const REVIEW_RX = /\b(exam|quiz|midterm|final|test|review|practice exam|practice quiz)\b/i;
const WORKED_EXAMPLE_RX = /\b(example|practice problem|worked problem|walkthrough|calculate|calculation|solving|let's solve|let's do)\b/i;
const FORMULA_RX = /\b(equation|formula|equals|proportional|derivative|integral|log|ln|delta|rate law|constant|units?)\b|[=∝Δ]/i;
const DEFINITION_RX = /\b(defined as|definition|is called|we call|refers to|means that|terminology)\b/i;
const CLARIFICATION_RX = /\b(not the same|confusing|common mistake|to be clear|clarif|don't confuse|important distinction|the reason why)\b/i;
const EMPHASIS_RX = /\b(important|key|remember|focus on|pay attention|notice that|big idea|main point|emphasize|high yield)\b/i;

export type TranscriptEvidenceType =
  | "content"
  | "worked_example"
  | "review"
  | "clarification"
  | "formula"
  | "definition";

export interface TranscriptChunkMetadata {
  evidenceType: TranscriptEvidenceType;
  signals: string[];
  keywords: string[];
  importance: number;
}

export interface TranscriptChunk {
  chunkIndex: number;
  charStart: number;
  charEnd: number;
  text: string;
  tokenEstimate: number;
  metadata: TranscriptChunkMetadata;
}

interface TranscriptChunkIndexInput {
  materialId: string;
  courseId: string;
  text: string;
  contentHash: string;
}

let chunkIndexQueue: Promise<unknown> = Promise.resolve();

function enqueueChunkIndex<T>(job: () => Promise<T>): Promise<T> {
  const next = chunkIndexQueue.then(job, job);
  chunkIndexQueue = next.catch(() => undefined);
  return next;
}

function normalizeTranscriptText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function chooseChunkEnd(text: string, start: number): number {
  const hardEnd = Math.min(start + TRANSCRIPT_CHUNK_TARGET_CHARS, text.length);
  if (hardEnd >= text.length) return text.length;

  const minEnd = Math.min(
    hardEnd,
    start + Math.floor(TRANSCRIPT_CHUNK_TARGET_CHARS * 0.6),
  );
  const window = text.slice(minEnd, hardEnd);
  const sentenceBreak = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
    window.lastIndexOf("\n\n"),
    window.lastIndexOf("\n"),
  );
  if (sentenceBreak >= 0) return minEnd + sentenceBreak + 1;

  const spaceBreak = text.lastIndexOf(" ", hardEnd);
  if (spaceBreak > minEnd) return spaceBreak;

  return hardEnd;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function tokenizeKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+\-' ]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !KEYWORD_STOPWORDS.has(token));
}

function extractKeywords(text: string): string[] {
  const counts = new Map<string, number>();
  for (const token of tokenizeKeywords(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_CHUNK_KEYWORDS)
    .map(([token]) => token);
}

export function analyzeTranscriptChunk(text: string): TranscriptChunkMetadata {
  const signals: string[] = [];
  let evidenceType: TranscriptEvidenceType = "content";
  let importance = 0;

  if (REVIEW_RX.test(text)) {
    signals.push("review");
    evidenceType = "review";
    importance += 10;
  }
  if (WORKED_EXAMPLE_RX.test(text)) {
    signals.push("worked_example");
    if (evidenceType === "content") evidenceType = "worked_example";
    importance += 8;
  }
  if (FORMULA_RX.test(text)) {
    signals.push("formula");
    if (evidenceType === "content") evidenceType = "formula";
    importance += 6;
  }
  if (DEFINITION_RX.test(text)) {
    signals.push("definition");
    if (evidenceType === "content") evidenceType = "definition";
    importance += 5;
  }
  if (CLARIFICATION_RX.test(text)) {
    signals.push("clarification");
    if (evidenceType === "content") evidenceType = "clarification";
    importance += 5;
  }
  if (EMPHASIS_RX.test(text)) {
    signals.push("instructor_emphasis");
    importance += 7;
  }

  const keywords = extractKeywords(text);
  if (keywords.length >= 8) importance += 1;

  return {
    evidenceType,
    signals: dedupe(signals),
    keywords,
    importance,
  };
}

export function buildTranscriptChunks(rawText: string): TranscriptChunk[] {
  const text = normalizeTranscriptText(rawText);
  if (text.length === 0) return [];

  const chunks: TranscriptChunk[] = [];
  let start = 0;

  while (start < text.length) {
    const end = chooseChunkEnd(text, start);
    const chunkText = text.slice(start, end).trim();
    if (chunkText.length >= TRANSCRIPT_CHUNK_MIN_CHARS || chunks.length === 0) {
      const metadata = analyzeTranscriptChunk(chunkText);
      chunks.push({
        chunkIndex: chunks.length,
        charStart: start,
        charEnd: end,
        text: chunkText,
        tokenEstimate: Math.ceil(chunkText.length / 4),
        metadata,
      });
    }

    if (end >= text.length) break;
    const nextStart = Math.max(0, end - TRANSCRIPT_CHUNK_OVERLAP_CHARS);
    start = nextStart > start ? nextStart : end;
  }

  return chunks;
}

async function getChunkIndexState(materialId: string, contentHash: string): Promise<{
  total: number;
  embedded: number;
}> {
  const rows = await db.$queryRaw<{ total: number; embedded: number }[]>`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded
    FROM "CourseMaterialChunk"
    WHERE "materialId" = ${materialId}
      AND "contentHash" = ${contentHash}
  `;
  return rows[0] ?? { total: 0, embedded: 0 };
}

async function updateChunkEmbedding(chunkId: string, embedding: number[]): Promise<void> {
  await db.$executeRaw`
    UPDATE "CourseMaterialChunk"
    SET embedding = ${JSON.stringify(embedding)}::vector
    WHERE id = ${chunkId}
  `;
}

export async function rebuildTranscriptChunks({
  materialId,
  courseId,
  text,
  contentHash,
}: TranscriptChunkIndexInput): Promise<{ chunks: number }> {
  const chunks = buildTranscriptChunks(text);

  await db.courseMaterialChunk.deleteMany({ where: { materialId } });
  if (chunks.length === 0) return { chunks: 0 };

  const rows = chunks.map((chunk) => ({
    id: crypto.randomUUID(),
    materialId,
    courseId,
    chunkIndex: chunk.chunkIndex,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    text: chunk.text,
    contentHash,
    tokenEstimate: chunk.tokenEstimate,
    evidenceType: chunk.metadata.evidenceType,
    signals: chunk.metadata.signals,
    keywords: chunk.metadata.keywords,
    importance: chunk.metadata.importance,
  }));

  await db.courseMaterialChunk.createMany({ data: rows });

  for (let index = 0; index < rows.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = rows.slice(index, index + EMBEDDING_BATCH_SIZE);
    const embeddings = await generateEmbeddings(batch.map((chunk) => chunk.text));
    await Promise.all(
      batch.map((chunk, batchIndex) => updateChunkEmbedding(chunk.id, embeddings[batchIndex]))
    );
  }

  return { chunks: rows.length };
}

export async function ensureTranscriptChunks(input: TranscriptChunkIndexInput): Promise<{ chunks: number; rebuilt: boolean }> {
  return enqueueChunkIndex(async () => {
    const expectedChunks = buildTranscriptChunks(input.text).length;
    const state = await getChunkIndexState(input.materialId, input.contentHash);

    if (expectedChunks > 0 && state.total === expectedChunks && state.embedded === expectedChunks) {
      return { chunks: expectedChunks, rebuilt: false };
    }

    const result = await rebuildTranscriptChunks(input);
    return { chunks: result.chunks, rebuilt: true };
  });
}
