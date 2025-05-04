/****************************************************************************************
 *  patch-utils.mts – diff handling helpers
 ****************************************************************************************/

/** Split a unified diff into individual hunk strings */
export const splitPatch = (patch?: string | null): string[] => {
  if (!patch) return []
  const re = /(^@@ -\d+,\d+ \+\d+,\d+ @@).*$/gm
  const out: string[] = []
  let last = -1
  let m: RegExpExecArray | null
  while ((m = re.exec(patch))) {
    if (last === -1) last = m.index
    else {
      out.push(patch.substring(last, m.index))
      last = m.index
    }
  }
  if (last !== -1) out.push(patch.substring(last))
  return out
}

/** Extract start / end line numbers for the old + new hunks */
export const patchStartEndLine = (
  patch: string
): {
  oldHunk: {startLine: number; endLine: number}
  newHunk: {startLine: number; endLine: number}
} | null => {
  const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/m.exec(patch)
  if (!m) return null
  const [, oBeg, oLen, nBeg, nLen] = m.map(Number)
  return {
    oldHunk: {startLine: oBeg, endLine: oBeg + oLen - 1},
    newHunk: {startLine: nBeg, endLine: nBeg + nLen - 1}
  }
}

/** Turn a unified-diff hunk into “oldHunk” / “newHunk” strings */
export const parsePatch = (
  patch: string
): {oldHunk: string; newHunk: string} | null => {
  const info = patchStartEndLine(patch)
  if (!info) return null

  const oldLines: string[] = []
  const newLines: string[] = []
  let newNo = info.newHunk.startLine

  const lines = patch.split('\n').slice(1) // skip @@ header
  if (lines.at(-1) === '') lines.pop() // trim final blank

  for (const raw of lines) {
    if (raw.startsWith('-')) oldLines.push(raw.slice(1))
    else if (raw.startsWith('+')) {
      newLines.push(`${newNo}: ${raw.slice(1)}`)
      newNo++
    } else {
      oldLines.push(raw)
      newLines.push(`${newNo}: ${raw}`)
      newNo++
    }
  }
  return {oldHunk: oldLines.join('\n'), newHunk: newLines.join('\n')}
}
