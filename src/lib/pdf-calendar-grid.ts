/**
 * pdf-calendar-grid.ts — Cell-aware calendar grid extraction from PDF text items.
 *
 * Pure function, no framework/pdfjs dependencies. Takes simplified text items
 * (x, y, w, str) and returns a three-way analysis:
 *   "grid"      → cell-aware TSV output ready for AI extraction
 *   "grid-like" → structural signals present but not enough to extract cells
 *   "not-grid"  → no calendar grid signals detected
 *
 * The caller (offscreen.js) uses the result to choose a fallback tier:
 *   grid      → use cell-aware output
 *   grid-like → skip two-column heuristic, use line-aware assembleLines
 *   not-grid  → normal path (two-column detection + assembleLines)
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface PdfTextItem {
  x: number;
  y: number;
  w: number;
  str: string;
}

export type GridAnalysis =
  | { kind: "grid"; text: string; columnCount: number; rowBandCount: number; confidence: number }
  | { kind: "grid-like"; confidence: number }
  | { kind: "not-grid"; confidence: number };

interface Row {
  y: number; // representative Y for this row (average or first item)
  items: PdfTextItem[];
}

interface ColumnCluster {
  center: number;
  left: number;
  right: number;
}

interface RowBand {
  dateRowIndex: number;
  rows: Row[]; // includes the date-header row + content rows below it
}

// ── Date pattern detection ───────────────────────────────────────────────────

const DATE_PATTERN =
  /^(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sun|Mon|Tue|Wed|Thu|Fri|Sat))$/i;

function isDateLike(str: string): boolean {
  return DATE_PATTERN.test(str.trim());
}

// ── Main entry point ─────────────────────────────────────────────────────────

export function analyzeCalendarGrid(items: PdfTextItem[]): GridAnalysis {
  if (items.length < 10) return { kind: "not-grid", confidence: 0 };

  // Step 1: Build rows from Y coordinates
  const rows = buildRows(items);
  if (rows.length < 3) return { kind: "not-grid", confidence: 0 };

  // Step 2: Identify date-header candidate rows
  const dateRowIndices = findDateHeaderRows(rows);

  if (dateRowIndices.length === 0) return { kind: "not-grid", confidence: 0 };

  // Step 3: Derive column boundaries from the page's own structure
  const columns = detectColumns(rows, dateRowIndices);
  if (!columns || columns.length < 3) {
    // Some date rows exist but no consistent column structure
    if (dateRowIndices.length >= 1) return { kind: "grid-like", confidence: 0.25 };
    return { kind: "not-grid", confidence: 0 };
  }

  // Step 4: Score structural consistency
  const confidence = scoreConfidence(rows, dateRowIndices, columns);

  // Single date-header row: cap confidence (can only reach grid-like)
  const cappedConfidence = dateRowIndices.length === 1
    ? Math.min(confidence, 0.45)
    : confidence;

  if (cappedConfidence < 0.25) return { kind: "not-grid", confidence: cappedConfidence };

  if (cappedConfidence < 0.5) return { kind: "grid-like", confidence: cappedConfidence };

  // Step 5-6: Build row bands and assemble cells
  const bands = buildRowBands(rows, dateRowIndices);
  const text = assembleCells(bands, columns);

  if (!text) return { kind: "grid-like", confidence: cappedConfidence };

  return {
    kind: "grid",
    text,
    columnCount: columns.length,
    rowBandCount: bands.length,
    confidence: cappedConfidence,
  };
}

// ── Step 1: Build rows from Y coordinates ────────────────────────────────────

function buildRows(items: PdfTextItem[]): Row[] {
  if (items.length === 0) return [];

  // Compute typical line height from Y-gap distribution
  const ys = [...new Set(items.map((it) => it.y))].sort((a, b) => b - a); // descending
  const gaps: number[] = [];
  for (let i = 1; i < ys.length; i++) {
    const gap = Math.abs(ys[i - 1] - ys[i]);
    if (gap > 0.5 && gap < 100) gaps.push(gap); // filter noise and page-level jumps
  }
  if (gaps.length === 0) return [{ y: items[0].y, items }];

  gaps.sort((a, b) => a - b);
  const typicalLineHeight = gaps[Math.floor(gaps.length * 0.3)] ?? gaps[0]; // ~30th percentile
  const rowTolerance = typicalLineHeight * 0.5;

  // Group items into rows: items within rowTolerance of each other
  const sorted = [...items].sort((a, b) => b.y - a.y); // top to bottom
  const rows: Row[] = [];
  let currentRow: PdfTextItem[] = [sorted[0]];
  let currentY = sorted[0].y;

  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].y - currentY) <= rowTolerance) {
      currentRow.push(sorted[i]);
    } else {
      rows.push({ y: currentY, items: currentRow.sort((a, b) => a.x - b.x) });
      currentRow = [sorted[i]];
      currentY = sorted[i].y;
    }
  }
  rows.push({ y: currentY, items: currentRow.sort((a, b) => a.x - b.x) });

  return rows;
}

// ── Step 2: Find date-header candidate rows ──────────────────────────────────

function findDateHeaderRows(rows: Row[]): number[] {
  const indices: number[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.items.length < 3) continue; // need at least 3 items to be a header

    const dateCount = row.items.filter((it) => isDateLike(it.str)).length;
    const dateRatio = dateCount / row.items.length;

    // > 40% date-like tokens (relative to row density)
    if (dateRatio > 0.4 && dateCount >= 3) {
      indices.push(i);
    }
  }

  return indices;
}

// ── Step 3: Detect column boundaries ─────────────────────────────────────────

function detectColumns(rows: Row[], dateRowIndices: number[]): ColumnCluster[] | null {
  // Collect items from date-header rows
  const dateItems: PdfTextItem[] = [];
  for (const idx of dateRowIndices) {
    dateItems.push(...rows[idx].items);
  }

  if (dateItems.length < 4) return null;

  // Derive a merge radius from the page's own item widths.
  // Items in the same column across rows will have X positions within a small
  // tolerance of each other. Use the median item width as the merge radius —
  // two items whose X positions differ by less than one typical item width
  // are in the same column.
  const widths = dateItems.map((it) => it.w).filter((w) => w > 0);
  widths.sort((a, b) => a - b);
  const medianWidth = widths.length > 0
    ? widths[Math.floor(widths.length / 2)]
    : 30;
  const mergeRadius = medianWidth * 0.8;

  // Cluster X positions by proximity. For each item, find the nearest existing
  // cluster center. If within mergeRadius, add to that cluster. Otherwise start
  // a new cluster.
  const clusterXs: number[][] = [];

  for (const item of dateItems) {
    let merged = false;
    for (const cluster of clusterXs) {
      const center = cluster.reduce((a, b) => a + b, 0) / cluster.length;
      if (Math.abs(item.x - center) <= mergeRadius) {
        cluster.push(item.x);
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusterXs.push([item.x]);
    }
  }

  // Build ColumnCluster objects, sorted left to right
  const clusters: ColumnCluster[] = clusterXs
    .map((xs) => makeCluster(xs, dateItems))
    .sort((a, b) => a.center - b.center);

  if (clusters.length < 3) return null;

  return clusters;
}

function makeCluster(xPositions: number[], allItems: PdfTextItem[]): ColumnCluster {
  const center = xPositions.reduce((a, b) => a + b, 0) / xPositions.length;
  // Find the actual extent using items at these positions
  const matchingItems = allItems.filter((it) =>
    xPositions.some((x) => Math.abs(it.x - x) < 5),
  );
  const left = Math.min(...xPositions);
  const right = Math.max(
    ...matchingItems.map((it) => it.x + it.w),
    ...xPositions,
  );
  return { center, left, right };
}

// ── Step 4: Score structural consistency ─────────────────────────────────────

function scoreConfidence(
  rows: Row[],
  dateRowIndices: number[],
  columns: ColumnCluster[],
): number {
  // Signal 1: dateHeaderCount — are there enough date-header rows?
  // Score based on absolute count, not ratio to total rows.
  // Mixed-content pages (calendar at top, outline below) should still score high.
  // 0 → 0, 1 → 0.3, 2 → 0.6, 3+ → 1.0
  const dateHeaderCount = Math.min(dateRowIndices.length * 0.33, 1);

  // Signal 2: columnConsistency — do date-header rows agree on column count?
  const perRowCols: number[] = [];
  for (const idx of dateRowIndices) {
    const dateCount = rows[idx].items.filter((it) => isDateLike(it.str)).length;
    perRowCols.push(dateCount);
  }
  let columnConsistency = 1;
  if (perRowCols.length >= 2) {
    const mean = perRowCols.reduce((a, b) => a + b, 0) / perRowCols.length;
    const variance =
      perRowCols.reduce((a, b) => a + (b - mean) ** 2, 0) / perRowCols.length;
    const stddev = Math.sqrt(variance);
    columnConsistency = mean > 0 ? Math.max(0, 1 - stddev / mean) : 0;
  }

  // Signal 3: bandRegularity — is Y-spacing between date rows uniform?
  let bandRegularity = 0.5; // neutral default for 1 or 2 rows
  if (dateRowIndices.length >= 3) {
    const yGaps: number[] = [];
    for (let i = 1; i < dateRowIndices.length; i++) {
      yGaps.push(Math.abs(rows[dateRowIndices[i - 1]].y - rows[dateRowIndices[i]].y));
    }
    const mean = yGaps.reduce((a, b) => a + b, 0) / yGaps.length;
    const variance = yGaps.reduce((a, b) => a + (b - mean) ** 2, 0) / yGaps.length;
    const stddev = Math.sqrt(variance);
    bandRegularity = mean > 0 ? Math.max(0, 1 - stddev / mean) : 0;
  }

  // Signal 4: columnAlignment — do items align to detected column positions?
  let alignmentSum = 0;
  let alignmentCount = 0;
  const colWidth =
    columns.length >= 2
      ? (columns[columns.length - 1].center - columns[0].center) / (columns.length - 1)
      : 50;

  for (const idx of dateRowIndices) {
    for (const item of rows[idx].items) {
      const nearest = findNearestColumn(item.x, columns);
      if (nearest) {
        const offset = Math.abs(item.x - nearest.center);
        alignmentSum += Math.max(0, 1 - offset / colWidth);
        alignmentCount++;
      }
    }
  }
  const columnAlignment = alignmentCount > 0 ? alignmentSum / alignmentCount : 0;

  // Weighted combination (calibration values — tune against fixtures)
  return (
    0.3 * dateHeaderCount +
    0.3 * columnConsistency +
    0.2 * bandRegularity +
    0.2 * columnAlignment
  );
}

// ── Step 5: Build row bands ──────────────────────────────────────────────────

function buildRowBands(rows: Row[], dateRowIndices: number[]): RowBand[] {
  const bands: RowBand[] = [];

  for (let i = 0; i < dateRowIndices.length; i++) {
    const startIdx = dateRowIndices[i];
    const endIdx =
      i + 1 < dateRowIndices.length ? dateRowIndices[i + 1] : rows.length;

    // Only include rows that are part of the grid (not far below it)
    // Use a distance heuristic: content rows should be within 2x the typical
    // band spacing of the date-header row
    let maxY = rows[startIdx].y;
    let minY = rows[startIdx].y;
    if (i + 1 < dateRowIndices.length) {
      minY = rows[dateRowIndices[i + 1]].y;
    }
    const bandHeight = Math.abs(maxY - minY) || 60; // default if only one band

    const bandRows: Row[] = [];
    for (let j = startIdx; j < endIdx; j++) {
      // Include rows that are close enough to the date header (within the band)
      const dist = Math.abs(rows[startIdx].y - rows[j].y);
      if (dist <= bandHeight * 1.1) {
        bandRows.push(rows[j]);
      }
    }

    bands.push({ dateRowIndex: startIdx, rows: bandRows });
  }

  return bands;
}

// ── Step 6: Assemble cells ───────────────────────────────────────────────────

function assembleCells(bands: RowBand[], columns: ColumnCluster[]): string | null {
  if (bands.length === 0 || columns.length === 0) return null;

  const outputLines: string[] = [];

  for (const band of bands) {
    // Collect all items in this band
    const allItems = band.rows.flatMap((r) => r.items);

    // Assign each item to its nearest column
    const cellContents: string[][] = columns.map(() => []);

    for (const item of allItems) {
      const col = findNearestColumnIndex(item.x, columns);
      if (col >= 0) {
        cellContents[col].push(item.str);
      }
    }

    // Build TSV line: join cell contents with space within each cell, tabs between cells
    const cells = cellContents.map((parts) => parts.join(" ").trim());
    outputLines.push(cells.join("\t"));
  }

  const text = outputLines.join("\n");
  return text.trim() || null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findNearestColumn(
  x: number,
  columns: ColumnCluster[],
): ColumnCluster | null {
  if (columns.length === 0) return null;
  let nearest = columns[0];
  let minDist = Math.abs(x - columns[0].center);
  for (let i = 1; i < columns.length; i++) {
    const dist = Math.abs(x - columns[i].center);
    if (dist < minDist) {
      minDist = dist;
      nearest = columns[i];
    }
  }
  return nearest;
}

function findNearestColumnIndex(x: number, columns: ColumnCluster[]): number {
  if (columns.length === 0) return -1;
  let nearestIdx = 0;
  let minDist = Math.abs(x - columns[0].center);
  for (let i = 1; i < columns.length; i++) {
    const dist = Math.abs(x - columns[i].center);
    if (dist < minDist) {
      minDist = dist;
      nearestIdx = i;
    }
  }
  return nearestIdx;
}
