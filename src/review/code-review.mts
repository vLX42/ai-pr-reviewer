/****************************************************************************************
 *  code-review.mts – GitHub Action entry-point for CodeSailor automated PR reviews
 *  • orchestration only – helper utilities live in patch-utils.mts & review-parser.mts
 ****************************************************************************************/

import {error, info, warning} from '@actions/core'
import {context as githubContext} from '@actions/github'
import pLimit from 'p-limit'

import {type Bot} from '../bot.mjs'
import {
  Commenter,
  COMMENT_REPLY_TAG,
  RAW_SUMMARY_END_TAG,
  RAW_SUMMARY_START_TAG,
  SHORT_SUMMARY_END_TAG,
  SHORT_SUMMARY_START_TAG,
  SUMMARIZE_TAG
} from '../commenter.mjs'
import {Inputs} from '../inputs.mjs'
import {octokit} from '../octokit.mjs'
import {type Options} from '../options.mjs'
import {type Prompts} from '../prompts.mjs'
import {getTokenCount} from '../tokenizer.mjs'

import {splitPatch, patchStartEndLine, parsePatch} from './patch-utils.mjs'
import {parseReview} from './review-parser.mjs'

// -------------------------------------------------------------------------------------
//  CONSTANTS & CONTEXT
// -------------------------------------------------------------------------------------

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

  // Concurrency limiters
  const openaiLimiter = pLimit(options.openaiConcurrencyLimit)
  const githubLimiter = pLimit(options.githubConcurrencyLimit)

  // -------------------------------------------------------------------------
  //  0. Validate event type
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
  if (pr.body) inputs.description = commenter.getDescription(pr.body)

  if (inputs.description.includes(IGNORE_KEYWORD)) {
    info('Skipped – PR description contains ignore keyword')
    return
  }

  inputs.systemMessage = options.systemMessage

  // -------------------------------------------------------------------------
  //  2. Recover last summary comment (if any)
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
  //  3. Decide diff start SHA (base vs last reviewed)
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
    reviewStartSha = pr.base.sha
    info(`Will review from the base commit: ${reviewStartSha}`)
  } else {
    info(`Will review from commit: ${reviewStartSha}`)
  }

  // -------------------------------------------------------------------------
  //  4. Fetch incremental + full diffs
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

  const changedFiles = fullBranchFiles.filter(f =>
    incrementalFiles.some(i => i.filename === f.filename)
  )
  if (!changedFiles.length) {
    warning('Skipped – no changed files to review')
    return
  }

  // -------------------------------------------------------------------------
  //  5. Path filtering
  // -------------------------------------------------------------------------
  const selectedFiles: typeof changedFiles = []
  const ignoredFiles: typeof changedFiles = []

  for (const file of changedFiles) {
    if (options.checkPath(file.filename)) selectedFiles.push(file)
    else {
      info(`Path excluded: ${file.filename}`)
      ignoredFiles.push(file)
    }
  }
  if (!selectedFiles.length) {
    warning('Skipped – nothing left after path filtering')
    return
  }

  // -------------------------------------------------------------------------
  //  6. Fetch base‑branch & head contents + parse patches
  // -------------------------------------------------------------------------
  const filesAndPatches = (
    await Promise.all(
      selectedFiles.map(file =>
        githubLimiter(async () => {
          let baseContent = ''
          let headContent = ''

          /* ----- base (pre‑PR) file ----- */
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
            /* file is new in PR – ignore */
          }

          /* ----- head (current) file ----- */
          try {
            const resHead = await octokit.repos.getContent({
              owner: repoOwner,
              repo: repoName,
              path: file.filename,
              ref: headSha
            })
            if (
              !Array.isArray(resHead.data) &&
              resHead.data.type === 'file' &&
              resHead.data.content
            ) {
              headContent = Buffer.from(
                resHead.data.content,
                'base64'
              ).toString()
            }
          } catch {
            /* file deleted – ignore */
          }

          const patches: Array<[number, number, string]> = []
          if (file.patch) {
            for (const part of splitPatch(file.patch)) {
              const locs = patchStartEndLine(part)
              const hunks = parsePatch(part)
              if (locs && hunks) {
                patches.push([
                  locs.newHunk.startLine,
                  locs.newHunk.endLine,
                  `
---new_hunk---
\`\`\`
${hunks.newHunk}
\`\`\`

---old_hunk---
\`\`\`
${hunks.oldHunk}
\`\`\`
`
                ])
              }
            }
          }

          return patches.length
            ? ([
                file.filename,
                baseContent,
                headContent,
                file.patch ?? '',
                patches
              ] as [
                string, // filename
                string, // baseContent
                string, // headContent
                string, // patch (raw)
                Array<[number, number, string]>
              ])
            : null
        })
      )
    )
  ).filter(Boolean) as Array<
    [string, string, string, string, Array<[number, number, string]>]
  >

  if (!filesAndPatches.length) {
    error('Skipped – extracted 0 reviewable patches')
    return
  }

  // -------------------------------------------------------------------------
  //  7. Initial status comment
  // -------------------------------------------------------------------------
  const commits = incrementalDiff.data.commits ?? []
  let statusMsg = `<details>
<summary>Commits</summary>
Files changed between <code>${reviewStartSha}</code> and <code>${headSha}</code>.
</details>

<details>
<summary>Files selected (${filesAndPatches.length})</summary>

* ${filesAndPatches
    .map(([filename, , , , patches]) => `${filename} (${patches.length} hunks)`)
    .join('\n* ')}
</details>`

  if (ignoredFiles.length) {
    statusMsg += `
<details>
<summary>Files ignored by path filter (${ignoredFiles.length})</summary>

* ${ignoredFiles.map(f => f.filename).join('\n* ')}

</details>`
  }

  // -------------------------------------------------------------------------
  //  8. Post / update "in‑progress" summary comment
  // -------------------------------------------------------------------------
  const inProgressComment = commenter.addInProgressStatus(
    previousSummaryComment?.body ?? '',
    statusMsg
  )
  await commenter.comment(inProgressComment, SUMMARIZE_TAG, 'replace')

  // -------------------------------------------------------------------------
  //  9. Generate file‑level summaries (light model)
  // -------------------------------------------------------------------------
  const summariesFailed: string[] = []
  const summarizeFile = async (
    filename: string,
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

      if (!options.reviewSimpleChanges) {
        const m = resp.match(/\[TRIAGE\]:\s*(NEEDS_REVIEW|APPROVED)/)
        if (m) {
          const needsReview = m[1] === 'NEEDS_REVIEW'
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

  const summaryPromises: Array<Promise<[string, string, boolean] | null>> = []
  const skippedDueToMaxFiles: string[] = []

  for (const [filename, , , fileDiff] of filesAndPatches) {
    if (options.maxFiles <= 0 || summaryPromises.length < options.maxFiles) {
      summaryPromises.push(
        openaiLimiter(() => summarizeFile(filename, fileDiff))
      )
    } else {
      skippedDueToMaxFiles.push(filename)
    }
  }

  const summaries = (await Promise.all(summaryPromises)).filter(
    Boolean
  ) as Array<[string, string, boolean]>

  // -------------------------------------------------------------------------
  // 10. Merge summaries → rawSummary (heavy model)
  // -------------------------------------------------------------------------
  if (summaries.length) {
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
  // 11. Final + short summaries (heavy model)
  // -------------------------------------------------------------------------
  const finalSummaryResp = await heavyBot.chat(prompts.renderSummarize(inputs))
  if (!finalSummaryResp) info('No final summary was returned from OpenAI')

  inputs.shortSummary = await heavyBot.chat(
    prompts.renderSummarizeShort(inputs)
  )

  // -------------------------------------------------------------------------
  // 12. Release‑notes → update PR description
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
        warning(`Release‑notes update failed: ${e.message as string}`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // 13. Build summary comment body
  // -------------------------------------------------------------------------
  let summaryComment = `${finalSummaryResp}

${RAW_SUMMARY_START_TAG}
${inputs.rawSummary}
${RAW_SUMMARY_END_TAG}
${SHORT_SUMMARY_START_TAG}
${inputs.shortSummary}
${SHORT_SUMMARY_END_TAG}
`

  summaryComment += `\n${commenter.addReviewedCommitId(previousCommitBlock, headSha)}`

  // -------------------------------------------------------------------------
  // 14. Detailed reviews on "needs review" files
  // -------------------------------------------------------------------------
  if (!options.disableReview) {
    const needsReviewFiles = filesAndPatches.filter(([fn]) => {
      const flag = summaries.find(([sFn]) => sFn === fn)?.[2] ?? true
      return flag
    })

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
      ins.fileContent = fileContent
      ins.patches = ''

      // Base prompt token count with full file
      let promptTokens = getTokenCount(prompts.renderReviewFileDiff(ins))
      if (promptTokens > options.heavyTokenLimits.requestTokens) {
        reviewsSkipped.push(`${filename} (file too large)`) // full file alone exceeds budget
        return
      }

      // Decide how many patches fit
      let patchesToPack = 0
      for (const [, , patchStr] of patches) {
        const patchTokens = getTokenCount(patchStr)
        if (promptTokens + patchTokens > options.heavyTokenLimits.requestTokens)
          break
        promptTokens += patchTokens
        patchesToPack++
      }

      if (!patchesToPack) {
        reviewsSkipped.push(`${filename} (diff too large)`) // no room after file
        return
      }

      // Pack patches & possible comment chains
      let packed = 0
      for (const [startLine, endLine, patch] of patches) {
        if (packed >= patchesToPack) break
        packed++

        ins.patches += `\n${patch}\n`

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

      try {
        const resp = await heavyBot.chat(prompts.renderReviewFileDiff(ins))
        if (!resp) {
          reviewsFailed.push(`${filename} (no response)`)
          return
        }

        const parsedReviews = parseReview(resp, patches, options.debug)

        for (const review of parsedReviews) {
          if (
            !options.reviewCommentLGTM &&
            /\bLGTM\b|looks good to me/i.test(review.comment)
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

    const reviewPromises: Promise<void>[] = []
    for (const [fn, , headContent, , patches] of needsReviewFiles) {
      if (options.maxFiles <= 0 || reviewPromises.length < options.maxFiles) {
        reviewPromises.push(
          openaiLimiter(() => reviewFile(fn, headContent, patches))
        )
      } else {
        skippedDueToMaxFiles.push(fn)
      }
    }
    await Promise.all(reviewPromises)

    if (reviewsFailed.length) {
      statusMsg += `
<details>
<summary>Files not reviewed due to errors (${reviewsFailed.length})</summary>

* ${reviewsFailed.join('\n* ')}

</details>`
    }
    if (reviewsSkipped.length) {
      statusMsg += `
<details>
<summary>Trivial files skipped (${reviewsSkipped.length})</summary>

* ${reviewsSkipped.join('\n* ')}

</details>`
    }

    statusMsg += `
<details>
<summary>Review comments generated (${reviewCount + lgtmCount})</summary>

* Review: ${reviewCount}
* LGTM: ${lgtmCount}

</details>`

    await commenter.submitReview(
      pr.number,
      commits[commits.length - 1].sha,
      statusMsg
    )
  }

  // -------------------------------------------------------------------------
  // 15. Post / update the final summary comment
  // -------------------------------------------------------------------------
  await commenter.comment(summaryComment, SUMMARIZE_TAG, 'replace')
}
