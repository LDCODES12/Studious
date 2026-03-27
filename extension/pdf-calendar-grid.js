// src/lib/pdf-calendar-grid.ts
var DATE_PATTERN = /^(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sun|Mon|Tue|Wed|Thu|Fri|Sat))$/i;
function isDateLike(str) {
  return DATE_PATTERN.test(str.trim());
}
function analyzeCalendarGrid(items) {
  if (items.length < 10) return { kind: "not-grid", confidence: 0 };
  const rows = buildRows(items);
  if (rows.length < 3) return { kind: "not-grid", confidence: 0 };
  const dateRowIndices = findDateHeaderRows(rows);
  if (dateRowIndices.length === 0) return { kind: "not-grid", confidence: 0 };
  const columns = detectColumns(rows, dateRowIndices);
  if (!columns || columns.length < 3) {
    if (dateRowIndices.length >= 1) return { kind: "grid-like", confidence: 0.25 };
    return { kind: "not-grid", confidence: 0 };
  }
  const confidence = scoreConfidence(rows, dateRowIndices, columns);
  const cappedConfidence = dateRowIndices.length === 1 ? Math.min(confidence, 0.45) : confidence;
  if (cappedConfidence < 0.25) return { kind: "not-grid", confidence: cappedConfidence };
  if (cappedConfidence < 0.5) return { kind: "grid-like", confidence: cappedConfidence };
  const bands = buildRowBands(rows, dateRowIndices);
  const text = assembleCells(bands, columns);
  if (!text) return { kind: "grid-like", confidence: cappedConfidence };
  return {
    kind: "grid",
    text,
    columnCount: columns.length,
    rowBandCount: bands.length,
    confidence: cappedConfidence
  };
}
function buildRows(items) {
  if (items.length === 0) return [];
  const ys = [...new Set(items.map((it) => it.y))].sort((a, b) => b - a);
  const gaps = [];
  for (let i = 1; i < ys.length; i++) {
    const gap = Math.abs(ys[i - 1] - ys[i]);
    if (gap > 0.5 && gap < 100) gaps.push(gap);
  }
  if (gaps.length === 0) return [{ y: items[0].y, items }];
  gaps.sort((a, b) => a - b);
  const typicalLineHeight = gaps[Math.floor(gaps.length * 0.3)] ?? gaps[0];
  const rowTolerance = typicalLineHeight * 0.5;
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows = [];
  let currentRow = [sorted[0]];
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
function findDateHeaderRows(rows) {
  const indices = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.items.length < 3) continue;
    const dateCount = row.items.filter((it) => isDateLike(it.str)).length;
    const dateRatio = dateCount / row.items.length;
    if (dateRatio > 0.4 && dateCount >= 3) {
      indices.push(i);
    }
  }
  return indices;
}
function detectColumns(rows, dateRowIndices) {
  const dateItems = [];
  for (const idx of dateRowIndices) {
    dateItems.push(...rows[idx].items);
  }
  if (dateItems.length < 4) return null;
  const widths = dateItems.map((it) => it.w).filter((w) => w > 0);
  widths.sort((a, b) => a - b);
  const medianWidth = widths.length > 0 ? widths[Math.floor(widths.length / 2)] : 30;
  const mergeRadius = medianWidth * 0.8;
  const clusterXs = [];
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
  const clusters = clusterXs.map((xs) => makeCluster(xs, dateItems)).sort((a, b) => a.center - b.center);
  if (clusters.length < 3) return null;
  return clusters;
}
function makeCluster(xPositions, allItems) {
  const center = xPositions.reduce((a, b) => a + b, 0) / xPositions.length;
  const matchingItems = allItems.filter(
    (it) => xPositions.some((x) => Math.abs(it.x - x) < 5)
  );
  const left = Math.min(...xPositions);
  const right = Math.max(
    ...matchingItems.map((it) => it.x + it.w),
    ...xPositions
  );
  return { center, left, right };
}
function scoreConfidence(rows, dateRowIndices, columns) {
  const dateHeaderCount = Math.min(dateRowIndices.length * 0.33, 1);
  const perRowCols = [];
  for (const idx of dateRowIndices) {
    const dateCount = rows[idx].items.filter((it) => isDateLike(it.str)).length;
    perRowCols.push(dateCount);
  }
  let columnConsistency = 1;
  if (perRowCols.length >= 2) {
    const mean = perRowCols.reduce((a, b) => a + b, 0) / perRowCols.length;
    const variance = perRowCols.reduce((a, b) => a + (b - mean) ** 2, 0) / perRowCols.length;
    const stddev = Math.sqrt(variance);
    columnConsistency = mean > 0 ? Math.max(0, 1 - stddev / mean) : 0;
  }
  let bandRegularity = 0.5;
  if (dateRowIndices.length >= 3) {
    const yGaps = [];
    for (let i = 1; i < dateRowIndices.length; i++) {
      yGaps.push(Math.abs(rows[dateRowIndices[i - 1]].y - rows[dateRowIndices[i]].y));
    }
    const mean = yGaps.reduce((a, b) => a + b, 0) / yGaps.length;
    const variance = yGaps.reduce((a, b) => a + (b - mean) ** 2, 0) / yGaps.length;
    const stddev = Math.sqrt(variance);
    bandRegularity = mean > 0 ? Math.max(0, 1 - stddev / mean) : 0;
  }
  let alignmentSum = 0;
  let alignmentCount = 0;
  const colWidth = columns.length >= 2 ? (columns[columns.length - 1].center - columns[0].center) / (columns.length - 1) : 50;
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
  return 0.3 * dateHeaderCount + 0.3 * columnConsistency + 0.2 * bandRegularity + 0.2 * columnAlignment;
}
function buildRowBands(rows, dateRowIndices) {
  const bands = [];
  for (let i = 0; i < dateRowIndices.length; i++) {
    const startIdx = dateRowIndices[i];
    const endIdx = i + 1 < dateRowIndices.length ? dateRowIndices[i + 1] : rows.length;
    let maxY = rows[startIdx].y;
    let minY = rows[startIdx].y;
    if (i + 1 < dateRowIndices.length) {
      minY = rows[dateRowIndices[i + 1]].y;
    }
    const bandHeight = Math.abs(maxY - minY) || 60;
    const bandRows = [];
    for (let j = startIdx; j < endIdx; j++) {
      const dist = Math.abs(rows[startIdx].y - rows[j].y);
      if (dist <= bandHeight * 1.1) {
        bandRows.push(rows[j]);
      }
    }
    bands.push({ dateRowIndex: startIdx, rows: bandRows });
  }
  return bands;
}
function assembleCells(bands, columns) {
  if (bands.length === 0 || columns.length === 0) return null;
  const outputLines = [];
  for (const band of bands) {
    const allItems = band.rows.flatMap((r) => r.items);
    const cellContents = columns.map(() => []);
    for (const item of allItems) {
      const col = findNearestColumnIndex(item.x, columns);
      if (col >= 0) {
        cellContents[col].push(item.str);
      }
    }
    const cells = cellContents.map((parts) => parts.join(" ").trim());
    outputLines.push(cells.join("	"));
  }
  const text = outputLines.join("\n");
  return text.trim() || null;
}
function findNearestColumn(x, columns) {
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
function findNearestColumnIndex(x, columns) {
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
export {
  analyzeCalendarGrid
};
