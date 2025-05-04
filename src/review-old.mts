/****************************************************************************************
 *  codeReview.mts – GitHub Action entry-point for CodeSailor automated PR reviews
 *  ------------------------------------------------------------------------------------
 *  • Collects PR metadata
 *  • Calculates the incremental diff since the last reviewed commit
 *  • Summarises and (optionally) reviews changes via OpenAI
 *  • Writes summaries + inline review comments back to GitHub
 *
 *  NOTE: External behaviour / exported types are preserved – only internal naming
 *        and comments have been improved for readability.
 ****************************************************************************************/

import {error, info, warning} from '@actions/core'

import {context as githubContext} from '@actions/github'
import pLimit from 'p-limit'

import {type Bot} from './bot.mjs'
import {
  Commenter,
  COMMENT_REPLY_TAG,
  RAW_SUMMARY_END_TAG,
  RAW_SUMMARY_START_TAG,
  SHORT_SUMMARY_END_TAG,
  SHORT_SUMMARY_START_TAG,
  SUMMARIZE_TAG
} from './commenter.mjs'
import {Inputs} from './inputs.mjs'
import {octokit} from './octokit.mjs'
import {type Options} from './options.mjs'
import {type Prompts} from './prompts.mjs'
import {getTokenCount} from './tokenizer.mjs'

// -------------------------------------------------------------------------------------
//  CONSTANTS & CONTEXT
// -------------------------------------------------------------------------------------

// GitHub context & repo coordinates

const ghCtx = githubContext
const {owner: repoOwner, repo: repoName} = ghCtx.repo

/** Keyword that allows users to suppress further bot reviews */
const IGNORE_KEYWORD = '@codesailorai: ignore'

// -------------------------------------------------------------------------------------
//  MAIN ENTRYPOINT
// -------------------------------------------------------------------------------------

export const codeReview = async (
  lightBot: Bot,
  heavyBot: Bot,
  options: Options,
  prompts: Prompts
): Promise<void> => {
  const commenter = new Commenter()

  // Concurrency limiters for external API calls
  const openaiLimiter = pLimit(options.openaiConcurrencyLimit)
  const githubLimiter = pLimit(options.githubConcurrencyLimit)

  // -------------------------------------------------------------------------
  //  0. Validate that we are running on a PR-related event
  // -------------------------------------------------------------------------
  if (
    ghCtx.eventName !== 'pull_request' &&
    ghCtx.eventName !== 'pull_request_target'
  ) {
    warning(
      `Skipped – current event is ${ghCtx.eventName}; this action only supports pull_request events`
    )
    return
  }
  if (!ghCtx.payload.pull_request) {
    warning('Skipped – context.payload.pull_request is null')
    return
  }

  const pr = ghCtx.payload.pull_request

  // -------------------------------------------------------------------------
  //  1. Collect PR metadata → Inputs
  // -------------------------------------------------------------------------
  const inputs = new Inputs()
  inputs.title = pr.title
  if (pr.body) {
    inputs.description = commenter.getDescription(pr.body)
  }

  // Abort if the user explicitly asked us to ignore this PR
  if (inputs.description.includes(IGNORE_KEYWORD)) {
    info('Skipped – PR description contains ignore keyword')
    return
  }

  // GPT-4o currently ignores system messages unless we embed them
  inputs.systemMessage = options.systemMessage

  // -------------------------------------------------------------------------
  //  2. Recover last summary comment (if any) to continue incremental review
  // -------------------------------------------------------------------------
  const previousSummaryComment = await commenter.findCommentWithTag(
    SUMMARIZE_TAG,
    pr.number
  )

  let previousCommitBlock = ''
  if (previousSummaryComment) {
    const body = previousSummaryComment.body
    inputs.rawSummary = commenter.getRawSummary(body)
    inputs.shortSummary = commenter.getShortSummary(body)
    previousCommitBlock = commenter.getReviewedCommitIdsBlock(body)
  }

  // -------------------------------------------------------------------------
  //  3. Work out which commit to diff against (base or last reviewed)
  // -------------------------------------------------------------------------
  const allCommitIds = await commenter.getAllCommitIds()

  let reviewStartSha = ''
  if (previousCommitBlock) {
    reviewStartSha = commenter.getHighestReviewedCommitId(
      allCommitIds,
      commenter.getReviewedCommitIds(previousCommitBlock)
    )
  }

  const headSha = pr.head.sha
  if (!reviewStartSha || reviewStartSha === headSha) {
    // either first run OR PR was force-pushed / reset
    reviewStartSha = pr.base.sha
    info(`Will review from the base commit: ${reviewStartSha}`)
  } else {
    info(`Will review from commit: ${reviewStartSha}`)
  }

  // -------------------------------------------------------------------------
  //  4. Fetch diffs from GitHub (incremental + full against base branch)
  // -------------------------------------------------------------------------
  const [incrementalDiff, fullDiff] = await Promise.all([
    octokit.repos.compareCommits({
      owner: repoOwner,
      repo: repoName,
      base: reviewStartSha,
      head: headSha
    }),
    octokit.repos.compareCommits({
      owner: repoOwner,
      repo: repoName,
      base: pr.base.sha,
      head: headSha
    })
  ])

  const incrementalFiles = incrementalDiff.data.files ?? []
  const fullBranchFiles = fullDiff.data.files ?? []

  // Keep only files that appear in the incremental diff
  const changedFiles = fullBranchFiles.filter(f =>
    incrementalFiles.some(i => i.filename === f.filename)
  )
  if (changedFiles.length === 0) {
    warning('Skipped – no changed files to review')
    return
  }

  // -------------------------------------------------------------------------
  //  5. Apply user path filters
  // -------------------------------------------------------------------------
  const selectedFiles: typeof changedFiles = []
  const ignoredFiles: typeof changedFiles = []

  for (const file of changedFiles) {
    if (options.checkPath(file.filename)) {
      selectedFiles.push(file)
    } else {
      info(`Path excluded: ${file.filename}`)
      ignoredFiles.push(file)
    }
  }
  if (selectedFiles.length === 0) {
    warning('Skipped – nothing left after path filtering')
    return
  }

  // -------------------------------------------------------------------------
  //  6. Fetch file contents @ base commit + parse patches into hunks
  // -------------------------------------------------------------------------
  const filesAndPatches = (
    await Promise.all(
      selectedFiles.map(file =>
        githubLimiter(async () => {
          // (a) Base-branch file content – may be empty if new file
          let baseContent = ''
          try {
            const res = await octokit.repos.getContent({
              owner: repoOwner,
              repo: repoName,
              path: file.filename,
              ref: pr.base.sha
            })
            if (
              !Array.isArray(res.data) &&
              res.data.type === 'file' &&
              res.data.content
            ) {
              baseContent = Buffer.from(res.data.content, 'base64').toString()
            }
          } catch {
            // ignore – file may be new
          }

          // (b) Split unified diff into hunks → [start,end,hunkText][]
          const patches: Array<[number, number, string]> = []
          if (file.patch) {
            for (const part of splitPatch(file.patch)) {
              const locs = patchStartEndLine(part)
              const hunks = parsePatch(part)
              if (locs && hunks) {
                const hunkText = `
---new_hunk---
\`\`\`
${hunks.newHunk}
\`\`\`

---old_hunk---
\`\`\`
${hunks.oldHunk}
\`\`\`
`
                patches.push([
                  locs.newHunk.startLine,
                  locs.newHunk.endLine,
                  hunkText
                ])
              }
            }
          }
          return patches.length
            ? ([file.filename, baseContent, file.patch ?? '', patches] as [
                string,
                string,
                string,
                Array<[number, number, string]>
              ])
            : null
        })
      )
    )
  ).filter(Boolean) as Array<
    [string, string, string, Array<[number, number, string]>]
  >

  if (filesAndPatches.length === 0) {
    error('Skipped – extracted 0 reviewable patches')
    return
  }

  // -------------------------------------------------------------------------
  //  7. Build initial status message (+ show ignored files)
  // -------------------------------------------------------------------------
  const commits = incrementalDiff.data.commits ?? []
  let statusMsg = `<details>
<summary>Commits</summary>
Files changed between <code>${reviewStartSha}</code> and <code>${headSha}</code>.
</details>

<details>
<summary>Files selected (${filesAndPatches.length})</summary>

* ${filesAndPatches
    .map(([filename, , , patches]) => `${filename} (${patches.length} hunks)`)
    .join('\n* ')}
</details>
`

  if (ignoredFiles.length) {
    statusMsg += `
<details>
<summary>Files ignored by path filter (${ignoredFiles.length})</summary>

* ${ignoredFiles.map(f => f.filename).join('\n* ')}

</details>
`
  }

  // -------------------------------------------------------------------------
  //  8. Post / update "in-progress" summary comment
  // -------------------------------------------------------------------------
  const inProgressComment = commenter.addInProgressStatus(
    previousSummaryComment?.body ?? '',
    statusMsg
  )
  await commenter.comment(inProgressComment, SUMMARIZE_TAG, 'replace')

  // -------------------------------------------------------------------------
  //  9. Generate file-level summaries (light model)
  // -------------------------------------------------------------------------
  const summariesFailed: string[] = []
  const summarizeFile = async (
    filename: string,
    fileContent: string,
    fileDiff: string
  ): Promise<[string, string, boolean] | null> => {
    info(`Summarising: ${filename}`)

    if (!fileDiff) {
      summariesFailed.push(`${filename} (empty diff)`)
      warning(`Empty diff – skipping ${filename}`)
      return null
    }

    const ins = inputs.clone()
    ins.filename = filename
    ins.fileDiff = fileDiff

    const prompt = prompts.renderSummarizeFileDiff(
      ins,
      options.reviewSimpleChanges
    )
    if (getTokenCount(prompt) > options.lightTokenLimits.requestTokens) {
      summariesFailed.push(`${filename} (diff tokens exceed limit)`)
      info(`Skipping ${filename} – diff exceeds token budget`)
      return null
    }

    try {
      const resp = await lightBot.chat(prompt)
      if (!resp) {
        summariesFailed.push(`${filename} (no response)`)
        return null
      }

      // Detect triage classification if simple-changes mode is off
      if (!options.reviewSimpleChanges) {
        const match = resp.match(/\[TRIAGE\]:\s*(NEEDS_REVIEW|APPROVED)/)
        if (match) {
          const needsReview = match[1] === 'NEEDS_REVIEW'
          const summaryText = resp.replace(/\[TRIAGE\]:.*$/m, '').trim()
          return [filename, summaryText, needsReview]
        }
      }
      return [filename, resp, true]
    } catch (e: any) {
      summariesFailed.push(`${filename} (error: ${e as string})`)
      warning(`Summarize error for ${filename}: ${e}`)
      return null
    }
  }

  // Fire off summaries in parallel under the OpenAI limiter
  const summaryPromises: Array<Promise<[string, string, boolean] | null>> = []
  const skippedDueToMaxFiles: string[] = []

  for (const [filename, fileContent, fileDiff] of filesAndPatches) {
    if (options.maxFiles <= 0 || summaryPromises.length < options.maxFiles) {
      summaryPromises.push(
        openaiLimiter(() => summarizeFile(filename, fileContent, fileDiff))
      )
    } else {
      skippedDueToMaxFiles.push(filename)
    }
  }

  const summaries = (await Promise.all(summaryPromises)).filter(
    Boolean
  ) as Array<[string, string, boolean]>

  // -------------------------------------------------------------------------
  // 10. Merge individual summaries → rawSummary (heavy model)
  // -------------------------------------------------------------------------
  if (summaries.length) {
    // Concatenate file-level summaries
    inputs.rawSummary = summaries
      .map(([fn, sm]) => `---\n${fn}: ${sm}`)
      .join('\n')

    // Batch every ~10 files to keep prompt small
    const batchSize = 10
    for (let i = 0; i < summaries.length; i += batchSize) {
      const slice = summaries.slice(i, i + batchSize)
      inputs.rawSummary = slice
        .map(([fn, sm]) => `---\n${fn}: ${sm}`)
        .join('\n')
      const combined = await heavyBot.chat(
        prompts.renderSummarizeChangesets(inputs)
      )
      if (combined) inputs.rawSummary = combined
    }
  }

  // -------------------------------------------------------------------------
  // 11. Generate final + short summaries (heavy model)
  // -------------------------------------------------------------------------
  const finalSummaryResp = await heavyBot.chat(prompts.renderSummarize(inputs))
  if (!finalSummaryResp) {
    info('No final summary was returned from OpenAI')
  }

  inputs.shortSummary = await heavyBot.chat(
    prompts.renderSummarizeShort(inputs)
  )

  // -------------------------------------------------------------------------
  // 12. (Optional) Release notes → update PR description
  // -------------------------------------------------------------------------
  if (!options.disableReleaseNotes) {
    const releaseNotesResp = await heavyBot.chat(
      prompts.renderSummarizeReleaseNotes(inputs)
    )
    if (releaseNotesResp) {
      try {
        await commenter.updateDescription(
          pr.number,
          `### Summary by CodeSailor\n\n${releaseNotesResp}`
        )
      } catch (e: any) {
        warning(`Release notes update failed: ${e.message as string}`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // 13. Build summary comment body (incl. raw + short summaries)
  // -------------------------------------------------------------------------
  let summaryComment = `${finalSummaryResp}

${RAW_SUMMARY_START_TAG}
${inputs.rawSummary}
${RAW_SUMMARY_END_TAG}
${SHORT_SUMMARY_START_TAG}
${inputs.shortSummary}
${SHORT_SUMMARY_END_TAG}
`

  // -------------------------------------------------------------------------
  // Append latest reviewed SHA block
  // -------------------------------------------------------------------------
  summaryComment += `\n${commenter.addReviewedCommitId(
    previousCommitBlock,
    headSha
  )}`

  // -------------------------------------------------------------------------
  // 14. (Optional) Perform detailed reviews on “needs review” files
  // -------------------------------------------------------------------------
  if (!options.disableReview) {
    const needsReviewFiles = filesAndPatches.filter(([fn]) => {
      const flag = summaries.find(([sFn]) => sFn === fn)?.[2] ?? true
      return flag
    })

    // const skippedAsTrivial = filesAndPatches
    //   .filter(([fn]) => !needsReviewFiles.some(([rf]) => rf === fn))
    //   .map(([fn]) => fn)

    const reviewsFailed: string[] = []
    const reviewsSkipped: string[] = []
    let lgtmCount = 0
    let reviewCount = 0

    const reviewFile = async (
      filename: string,
      fileContent: string,
      patches: Array<[number, number, string]>
    ): Promise<void> => {
      info(`Reviewing: ${filename}`)

      const ins = inputs.clone()
      ins.filename = filename

      // ------------- Pack as many patches as will fit in token budget
      let promptTokens = getTokenCount(prompts.renderReviewFileDiff(ins))
      let patchesToPack = 0
      for (const [, , patchStr] of patches) {
        const patchTokens = getTokenCount(patchStr)
        if (
          promptTokens + patchTokens >
          options.heavyTokenLimits.requestTokens
        ) {
          break
        }
        promptTokens += patchTokens
        patchesToPack++
      }

      if (patchesToPack === 0) {
        reviewsSkipped.push(`${filename} (diff too large)`)
        return
      }

      // Build prompt with selected patches + any existing discussion threads
      let packed = 0
      for (const [startLine, endLine, patch] of patches) {
        if (packed >= patchesToPack) break
        packed++

        ins.patches += `\n${patch}\n`

        // Include discussion context where possible
        try {
          const chains = await commenter.getCommentChainsWithinRange(
            pr.number,
            filename,
            startLine,
            endLine,
            COMMENT_REPLY_TAG
          )
          if (chains) {
            if (
              getTokenCount(ins.patches + chains) <
              options.heavyTokenLimits.requestTokens
            ) {
              ins.patches += `
---comment_chains---
\`\`\`
${chains}
\`\`\`
`
            }
          }
        } catch (e: any) {
          warning(`Failed fetching comment chains for ${filename}: ${e}`)
        }

        ins.patches += '\n---end_change_section---\n'
      }

      // ------------- Call model
      try {
        const resp = await heavyBot.chat(prompts.renderReviewFileDiff(ins))
        if (!resp) {
          reviewsFailed.push(`${filename} (no response)`)
          return
        }

        const parsedReviews = parseReview(resp, patches, options.debug)

        for (const review of parsedReviews) {
          // Filter LGTM / approval-only comments if configured
          if (
            !options.reviewCommentLGTM &&
            /\\bLGTM\\b|looks good to me/i.test(review.comment)
          ) {
            lgtmCount++
            continue
          }

          try {
            reviewCount++
            await commenter.bufferReviewComment(
              filename,
              review.startLine,
              review.endLine,
              review.comment
            )
          } catch (e: any) {
            reviewsFailed.push(`${filename} comment failed (${e as string})`)
          }
        }
      } catch (e: any) {
        reviewsFailed.push(`${filename} (${e as string})`)
        warning(`Review error for ${filename}: ${e}`)
      }
    }

    // Fire reviews in parallel
    const reviewPromises = []
    for (const [fn, content, , patches] of needsReviewFiles) {
      if (options.maxFiles <= 0 || reviewPromises.length < options.maxFiles) {
        reviewPromises.push(
          openaiLimiter(() => reviewFile(fn, content, patches))
        )
      } else {
        skippedDueToMaxFiles.push(fn)
      }
    }
    await Promise.all(reviewPromises)

    // ------------- Update status message with review statistics
    if (reviewsFailed.length) {
      statusMsg += `
<details>
<summary>Files not reviewed due to errors (${reviewsFailed.length})</summary>

* ${reviewsFailed.join('\n* ')}

</details>
`
    }
    if (reviewsSkipped.length) {
      statusMsg += `
<details>
<summary>Trivial files skipped (${reviewsSkipped.length})</summary>

* ${reviewsSkipped.join('\n* ')}

</details>
`
    }

    statusMsg += `
<details>
<summary>Review comments generated (${reviewCount + lgtmCount})</summary>

* Review: ${reviewCount}
* LGTM: ${lgtmCount}

</details>
`

    // ----------------- Post the collected review comments
    await commenter.submitReview(
      pr.number,
      commits[commits.length - 1].sha,
      statusMsg
    )
  } // disableReview

  // -------------------------------------------------------------------------
  // 15. Post / update the final summary comment
  // -------------------------------------------------------------------------
  await commenter.comment(summaryComment, SUMMARIZE_TAG, 'replace')
}

// =====================================================================================
//  INTERNAL HELPERS – patch parsing & review-response parsing
// =====================================================================================

/** Split a unified diff into individual hunk strings */
const splitPatch = (patch?: string | null): string[] => {
  if (!patch) return []
  const pattern = /(^@@ -\\d+,\\d+ \\+\\d+,\\d+ @@).*$/gm
  const result: string[] = []
  let last = -1
  let match: RegExpExecArray | null
  while ((match = pattern.exec(patch))) {
    if (last === -1) {
      last = match.index
    } else {
      result.push(patch.substring(last, match.index))
      last = match.index
    }
  }
  if (last !== -1) result.push(patch.substring(last))
  return result
}

/** Extract start / end line numbers for the old+new hunks */
const patchStartEndLine = (
  patch: string
): {
  oldHunk: {startLine: number; endLine: number}
  newHunk: {startLine: number; endLine: number}
} | null => {
  const match = /^@@ -(\\d+),(\\d+) \\+(\\d+),(\\d+) @@/m.exec(patch)
  if (!match) return null
  const [, oldBegin, oldLen, newBegin, newLen] = match.map(Number)
  return {
    oldHunk: {
      startLine: oldBegin,
      endLine: oldBegin + oldLen - 1
    },
    newHunk: {
      startLine: newBegin,
      endLine: newBegin + newLen - 1
    }
  }
}

/** Turn a unified-diff hunk into “oldHunk” / “newHunk” pretty strings */
const parsePatch = (
  patch: string
): {oldHunk: string; newHunk: string} | null => {
  const hunkInfo = patchStartEndLine(patch)
  if (!hunkInfo) return null

  const oldLines: string[] = []
  const newLines: string[] = []
  let newLineNo = hunkInfo.newHunk.startLine

  const lines = patch.split('\n').slice(1) // skip the @@ header
  if (lines[lines.length - 1] === '') lines.pop() // trim final blank

  for (const raw of lines) {
    if (raw.startsWith('-')) {
      oldLines.push(raw.substring(1))
    } else if (raw.startsWith('+')) {
      newLines.push(`${newLineNo}: ${raw.substring(1)}`)
      newLineNo++
    } else {
      oldLines.push(raw)
      newLines.push(`${newLineNo}: ${raw}`)
      newLineNo++
    }
  }

  return {
    oldHunk: oldLines.join('\n'),
    newHunk: newLines.join('\n')
  }
}

// -------------------------------------------------------------------------------------
//  parseReview – convert LLM review output → array of Review objects
// -------------------------------------------------------------------------------------
interface Review {
  startLine: number
  endLine: number
  comment: string
}

function parseReview(
  response: string,
  patches: Array<[number, number, string]>,
  debug = false
): Review[] {
  response = sanitizeResponse(response.trim())

  const reviews: Review[] = []
  const rangeRegex = /^(\\d+)-(\\d+):\\s*$/ // “12-18:” at line start
  const sepToken = '---'

  let currentStart: number | null = null
  let currentEnd: number | null = null
  let currentComment = ''

  const flush = () => {
    if (currentStart === null || currentEnd === null) return

    let adjustedStart = currentStart
    let adjustedEnd = currentEnd
    let prefix = ''

    // ensure the requested range lies within at least one patch
    let insidePatch = false
    for (const [pStart, pEnd] of patches) {
      if (currentStart >= pStart && currentEnd <= pEnd) {
        insidePatch = true
        break
      }
    }
    if (!insidePatch) {
      // pick patch with max overlap
      let bestOverlap = 0
      for (const [pStart, pEnd] of patches) {
        const overlap = Math.max(
          0,
          Math.min(currentEnd, pEnd) - Math.max(currentStart, pStart) + 1
        )
        if (overlap > bestOverlap) {
          bestOverlap = overlap
          adjustedStart = pStart
          adjustedEnd = pEnd
        }
      }
      prefix = `> Note: original range [${currentStart}-${currentEnd}] mapped to patch lines [${adjustedStart}-${adjustedEnd}]\n\n`
    }

    reviews.push({
      startLine: adjustedStart,
      endLine: adjustedEnd,
      comment: prefix + currentComment.trim()
    })

    if (debug) {
      info(`Stored review ${adjustedStart}-${adjustedEnd}`)
    }
  }

  for (const line of response.split('\n')) {
    const rangeMatch = line.match(rangeRegex)
    if (rangeMatch) {
      flush()
      currentStart = parseInt(rangeMatch[1], 10)
      currentEnd = parseInt(rangeMatch[2], 10)
      currentComment = ''
      continue
    }

    if (line.trim() === sepToken) {
      flush()
      currentStart = currentEnd = null
      currentComment = ''
      continue
    }

    if (currentStart !== null) {
      currentComment += `${line}\n`
    }
  }
  flush()
  return reviews
}

/** Remove “n: ” line-number prefixes inside fenced code blocks */
function sanitizeResponse(text: string): string {
  const stripLineNums = (comment: string, label: string): string => {
    const codeStart = `\`\`\`${label}`
    const codeEnd = '```'
    let idx = comment.indexOf(codeStart)
    while (idx !== -1) {
      const endIdx = comment.indexOf(codeEnd, idx + codeStart.length)
      if (endIdx === -1) break
      const block = comment.slice(idx + codeStart.length, endIdx)
      const cleaned = block.replace(/^ *(\\d+): /gm, '')
      comment =
        comment.slice(0, idx + codeStart.length) +
        cleaned +
        comment.slice(endIdx)
      idx = comment.indexOf(codeStart, idx + codeStart.length + cleaned.length)
    }
    return comment
  }

  text = stripLineNums(text, 'suggestion')
  text = stripLineNums(text, 'diff')
  return text
}
