/****************************************************************************************
 *  review-parser.mts – convert LLM review output → GitHub inline comments
 ****************************************************************************************/

import {info} from '@actions/core'

export interface Review {
  startLine: number
  endLine: number
  comment: string
}

export function parseReview(
  response: string,
  patches: Array<[number, number, string]>,
  debug = false
): Review[] {
  response = sanitizeResponse(response.trim())

  const reviews: Review[] = []
  const rangeRe = /^(\d+)-(\d+):\s*$/
  const SEP = '---'

  let s: number | null = null
  let e: number | null = null
  let txt = ''

  const push = () => {
    if (s === null || e === null) return

    let adjS = s,
      adjE = e,
      prefix = ''
    const inPatch = patches.some(([ps, pe]) => s! >= ps && e! <= pe)

    if (!inPatch) {
      // pick patch with max overlap
      let best = 0
      for (const [ps, pe] of patches) {
        const ov = Math.max(0, Math.min(e!, pe) - Math.max(s!, ps) + 1)
        if (ov > best) {
          best = ov
          adjS = ps
          adjE = pe
        }
      }
      prefix = `> Note: original range [${s}-${e}] mapped to [${adjS}-${adjE}]\n\n`
    }

    reviews.push({
      startLine: adjS,
      endLine: adjE,
      comment: prefix + txt.trim()
    })
    if (debug) info(`Stored review ${adjS}-${adjE}`)
  }

  for (const line of response.split('\n')) {
    const m = line.match(rangeRe)
    if (m) {
      push()
      s = +m[1]
      e = +m[2]
      txt = ''
      continue
    }
    if (line.trim() === SEP) {
      push()
      s = e = null
      txt = ''
      continue
    }
    if (s !== null) txt += line + '\n'
  }
  push()
  return reviews
}

/** Strip “n: ” prefixes inside ```suggestion / ```diff blocks */
export function sanitizeResponse(text: string): string {
  const strip = (c: string, tag: string) => {
    const start = `\`\`\`${tag}`
    const end = '```'
    let idx = c.indexOf(start)
    while (idx !== -1) {
      const endIdx = c.indexOf(end, idx + start.length)
      if (endIdx === -1) break
      const blk = c.slice(idx + start.length, endIdx)
      const clean = blk.replace(/^ *(\d+): /gm, '')
      c = c.slice(0, idx + start.length) + clean + c.slice(endIdx)
      idx = c.indexOf(start, idx + start.length + clean.length)
    }
    return c
  }
  return strip(strip(text, 'suggestion'), 'diff')
}
