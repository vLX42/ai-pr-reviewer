"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/main.mts
var import_core7 = require("@actions/core");

// src/fetch-polyfill.js
var import_node_fetch = __toESM(require("node-fetch"));
if (!globalThis.fetch) {
  globalThis.fetch = import_node_fetch.default;
  globalThis.Headers = import_node_fetch.Headers;
  globalThis.Request = import_node_fetch.Request;
  globalThis.Response = import_node_fetch.Response;
}

// src/bot.mts
var import_core = require("@actions/core");
var import_runnables = require("@langchain/core/runnables");
var import_openai = require("@langchain/openai");
var import_memory = require("@langchain/core/memory");
var import_prompts = require("@langchain/core/prompts");
var SimpleMemory = class extends import_memory.BaseMemory {
  get memoryKeys() {
    return ["history"];
  }
  history = [];
  constructor() {
    super();
  }
  async _call(input) {
    return this.loadMemoryVariables(input);
  }
  async invoke(input) {
    return this.loadMemoryVariables(input);
  }
  async loadMemoryVariables({}) {
    return { history: this.history };
  }
  async saveContext(input, output) {
    this.history.push({ input, output });
  }
  async clear() {
    this.history = [];
  }
};
var Bot = class {
  model = null;
  chain = null;
  memory = null;
  options;
  constructor(options, openaiOptions) {
    this.options = options;
    if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_API_VERSION && process.env.AZURE_OPENAI_API_INSTANCE_NAME && process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME) {
      const currentDate = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      const systemMessage = `${options.systemMessage}
Knowledge cutoff: ${openaiOptions.tokenLimits.knowledgeCutOff}
Current date: ${currentDate}

IMPORTANT: Entire response must be in the language with ISO code: ${options.language}
      `;
      const chatPrompt = import_prompts.ChatPromptTemplate.fromMessages([
        ["system", systemMessage],
        new import_prompts.MessagesPlaceholder("history"),
        ["human", "{input}"]
      ]);
      this.model = new import_openai.AzureChatOpenAI({
        temperature: options.openaiModelTemperature,
        azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
        azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION,
        azureOpenAIApiInstanceName: process.env.AZURE_OPENAI_API_INSTANCE_NAME,
        azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME,
        timeout: options.openaiTimeoutMS,
        maxRetries: options.openaiRetries
      });
      this.memory = new SimpleMemory();
      this.chain = import_runnables.RunnableSequence.from([
        (input) => input.input,
        // no memory here
        chatPrompt,
        this.model,
        {
          output: async (response) => {
            if (response?.content) {
              return response.content;
            }
            return "";
          }
        }
      ]);
    } else {
      const err = "Unable to initialize the OpenAI API, AZURE_OPENAI_API_* environment variables are not available.";
      throw new Error(err);
    }
  }
  chat = async (message) => {
    try {
      return await this.chat_(message);
    } catch {
      return "";
    }
  };
  chat_ = async (message) => {
    const start = Date.now();
    if (!message) {
      return "";
    }
    if (!this.chain || !this.memory) {
      (0, import_core.setFailed)("The OpenAI API or memory is not initialized");
      return "";
    }
    try {
      const memoryVariables = await this.memory.loadMemoryVariables({});
      const inputWithMemory = { input: message, ...memoryVariables };
      const result = await this.chain.invoke(inputWithMemory);
      await this.memory.saveContext({ input: message }, { output: result.output });
      const end = Date.now();
      (0, import_core.info)(
        `openai sendMessage (including retries) response time: ${end - start} ms`
      );
      let responseText = result?.output ?? "";
      if (responseText.startsWith("with ")) {
        responseText = responseText.substring(5);
      }
      if (this.options.debug) {
        (0, import_core.info)(`openai responses: ${responseText}`);
      }
      return responseText;
    } catch (e) {
      (0, import_core.warning)(`Failed to send message to openai: ${e}`);
      return "";
    }
  };
};

// src/options.mts
var import_core2 = require("@actions/core");
var import_minimatch = require("minimatch");

// src/limits.mts
var TokenLimits = class {
  maxTokens;
  requestTokens;
  responseTokens;
  knowledgeCutOff;
  constructor(model = "gpt-4o") {
    this.knowledgeCutOff = "2021-09-01";
    if (model === "gpt-4o-32k") {
      this.maxTokens = 32600;
      this.responseTokens = 4e3;
    } else if (model === "gpt-4o-16k") {
      this.maxTokens = 16300;
      this.responseTokens = 3e3;
    } else if (model === "gpt-4o") {
      this.maxTokens = 8e3;
      this.responseTokens = 2e3;
    } else {
      this.maxTokens = 4e3;
      this.responseTokens = 1e3;
    }
    this.requestTokens = this.maxTokens - this.responseTokens - 100;
  }
  string() {
    return `max_tokens=${this.maxTokens}, request_tokens=${this.requestTokens}, response_tokens=${this.responseTokens}`;
  }
};

// src/options.mts
var Options = class {
  debug;
  disableReview;
  disableReleaseNotes;
  maxFiles;
  reviewSimpleChanges;
  reviewCommentLGTM;
  pathFilters;
  systemMessage;
  openaiLightModel;
  openaiHeavyModel;
  openaiModelTemperature;
  openaiRetries;
  openaiTimeoutMS;
  openaiConcurrencyLimit;
  githubConcurrencyLimit;
  lightTokenLimits;
  heavyTokenLimits;
  language;
  constructor(debug, disableReview, disableReleaseNotes, maxFiles = "0", reviewSimpleChanges = false, reviewCommentLGTM = false, pathFilters = null, systemMessage = "", openaiLightModel = "gpt-4o", openaiHeavyModel = "gpt-4o", openaiModelTemperature = "0.0", openaiRetries = "3", openaiTimeoutMS = "120000", openaiConcurrencyLimit = "6", githubConcurrencyLimit = "6", language = "en-US") {
    this.debug = debug;
    this.disableReview = disableReview;
    this.disableReleaseNotes = disableReleaseNotes;
    this.maxFiles = parseInt(maxFiles);
    this.reviewSimpleChanges = reviewSimpleChanges;
    this.reviewCommentLGTM = reviewCommentLGTM;
    this.pathFilters = new PathFilter(pathFilters);
    this.systemMessage = systemMessage;
    this.openaiLightModel = openaiLightModel;
    this.openaiHeavyModel = openaiHeavyModel;
    this.openaiModelTemperature = parseFloat(openaiModelTemperature);
    this.openaiRetries = parseInt(openaiRetries);
    this.openaiTimeoutMS = parseInt(openaiTimeoutMS);
    this.openaiConcurrencyLimit = parseInt(openaiConcurrencyLimit);
    this.githubConcurrencyLimit = parseInt(githubConcurrencyLimit);
    this.lightTokenLimits = new TokenLimits(openaiLightModel);
    this.heavyTokenLimits = new TokenLimits(openaiHeavyModel);
    this.language = language;
  }
  // print all options using core.info
  print() {
    (0, import_core2.info)(`debug: ${this.debug}`);
    (0, import_core2.info)(`disable_review: ${this.disableReview}`);
    (0, import_core2.info)(`disable_release_notes: ${this.disableReleaseNotes}`);
    (0, import_core2.info)(`max_files: ${this.maxFiles}`);
    (0, import_core2.info)(`review_simple_changes: ${this.reviewSimpleChanges}`);
    (0, import_core2.info)(`review_comment_lgtm: ${this.reviewCommentLGTM}`);
    (0, import_core2.info)(`path_filters: ${this.pathFilters}`);
    (0, import_core2.info)(`system_message: ${this.systemMessage}`);
    (0, import_core2.info)(`openai_light_model: ${this.openaiLightModel}`);
    (0, import_core2.info)(`openai_heavy_model: ${this.openaiHeavyModel}`);
    (0, import_core2.info)(`openai_model_temperature: ${this.openaiModelTemperature}`);
    (0, import_core2.info)(`openai_retries: ${this.openaiRetries}`);
    (0, import_core2.info)(`openai_timeout_ms: ${this.openaiTimeoutMS}`);
    (0, import_core2.info)(`openai_concurrency_limit: ${this.openaiConcurrencyLimit}`);
    (0, import_core2.info)(`github_concurrency_limit: ${this.githubConcurrencyLimit}`);
    (0, import_core2.info)(`summary_token_limits: ${this.lightTokenLimits.string()}`);
    (0, import_core2.info)(`review_token_limits: ${this.heavyTokenLimits.string()}`);
    (0, import_core2.info)(`language: ${this.language}`);
  }
  checkPath(path) {
    const ok = this.pathFilters.check(path);
    (0, import_core2.info)(`checking path: ${path} => ${ok}`);
    return ok;
  }
};
var PathFilter = class {
  rules;
  constructor(rules = null) {
    this.rules = [];
    if (rules != null) {
      for (const rule of rules) {
        const trimmed = rule?.trim();
        if (trimmed) {
          if (trimmed.startsWith("!")) {
            this.rules.push([trimmed.substring(1).trim(), true]);
          } else {
            this.rules.push([trimmed, false]);
          }
        }
      }
    }
  }
  check(path) {
    if (this.rules.length === 0) {
      return true;
    }
    let included = false;
    let excluded = false;
    let inclusionRuleExists = false;
    for (const [rule, exclude] of this.rules) {
      if ((0, import_minimatch.minimatch)(path, rule)) {
        if (exclude) {
          excluded = true;
        } else {
          included = true;
        }
      }
      if (!exclude) {
        inclusionRuleExists = true;
      }
    }
    return (!inclusionRuleExists || included) && !excluded;
  }
};
var OpenAIOptions = class {
  model;
  tokenLimits;
  constructor(model = "gpt-4o", tokenLimits = null) {
    this.model = model;
    if (tokenLimits != null) {
      this.tokenLimits = tokenLimits;
    } else {
      this.tokenLimits = new TokenLimits(model);
    }
  }
};

// src/prompts.mts
var Prompts = class {
  summarize;
  summarizeReleaseNotes;
  summarizeFileDiff = `## GitHub PR Title

\`$title\` 

## Description

\`\`\`
$description
\`\`\`

## Diff

\`\`\`diff
$file_diff
\`\`\`

## Instructions

I would like you to succinctly summarize the diff within 100 words.
If applicable, your summary should include a note about alterations 
to the signatures of exported functions, global data structures and 
variables, and any changes that might affect the external interface or 
behavior of the code.
`;
  triageFileDiff = `Below the summary, I would also like you to triage the diff as \`NEEDS_REVIEW\` or 
\`APPROVED\` based on the following criteria:

- If the diff involves any modifications to the logic or functionality, even if they 
  seem minor, triage it as \`NEEDS_REVIEW\`. This includes changes to control structures, 
  function calls, or variable assignments that might impact the behavior of the code.
- If the diff only contains very minor changes that don't affect the code logic, such as 
  fixing typos, formatting, or renaming variables for clarity, triage it as \`APPROVED\`.

Please evaluate the diff thoroughly and take into account factors such as the number of 
lines changed, the potential impact on the overall system, and the likelihood of 
introducing new bugs or security vulnerabilities. 
When in doubt, always err on the side of caution and triage the diff as \`NEEDS_REVIEW\`.

You must strictly follow the format below for triaging the diff:
[TRIAGE]: <NEEDS_REVIEW or APPROVED>

Important:
- In your summary do not mention that the file needs a through review or caution about
  potential issues.
- Do not provide any reasoning why you triaged the diff as \`NEEDS_REVIEW\` or \`APPROVED\`.
- Do not mention that these changes affect the logic or functionality of the code in 
  the summary. You must only use the triage status format above to indicate that.
`;
  summarizeChangesets = `Provided below are changesets in this pull request. Changesets 
are in chronlogical order and new changesets are appended to the
end of the list. The format consists of filename(s) and the summary 
of changes for those files. There is a separator between each changeset.
Your task is to deduplicate and group together files with
related/similar changes into a single changeset. Respond with the updated 
changesets using the same format as the input. 

$raw_summary
`;
  summarizePrefix = `Here is the summary of changes you have generated for files:
      \`\`\`
      $raw_summary
      \`\`\`

`;
  summarizeShort = `Your task is to provide a concise summary of the changes. This 
summary will be used as a prompt while reviewing each file and must be very clear for 
the AI bot to understand. 

Instructions:

- Focus on summarizing only the changes in the PR and stick to the facts.
- Do not provide any instructions to the bot on how to perform the review.
- Do not mention that files need a through review or caution about potential issues.
- Do not mention that these changes affect the logic or functionality of the code.
- The summary should not exceed 500 words.
`;
  reviewFileDiff = `## GitHub PR Title

\`$title\` 

## Description

\`\`\`
$description
\`\`\`

## Summary of changes

\`\`\`
$short_summary
\`\`\`

## IMPORTANT Instructions

Input: New hunks annotated with line numbers and old hunks (replaced code). Hunks represent incomplete code fragments.
Additional Context: PR title, description, summaries and comment chains.
Task: Review new hunks for substantive issues using provided context and respond with comments if necessary.
Output: Review comments in markdown with exact line number ranges in new hunks. Start and end line numbers must be within the same hunk. For single-line comments, start=end line number. Must use example response format below.
Use fenced code blocks using the relevant language identifier where applicable.
Don't annotate code snippets with line numbers. Format and indent code correctly.
Do not use \`suggestion\` code blocks.
For fixes, use \`diff\` code blocks, marking changes with \`+\` or \`-\`. The line number range for comments with fix snippets must exactly match the range to replace in the new hunk.

- Do NOT provide general feedback, summaries, explanations of changes, or praises 
  for making good additions. 
- Focus solely on offering specific, objective insights based on the 
  given context and refrain from making broad comments about potential impacts on 
  the system or question intentions behind the changes.

If there are no issues found on a line range, you MUST respond with the 
text \`LGTM!\` for that line range in the review section. 

## Example

### Example changes

---new_hunk---
\`\`\`
  z = x / y
    return z

20: def add(x, y):
21:     z = x + y
22:     retrn z
23: 
24: def multiply(x, y):
25:     return x * y

def subtract(x, y):
  z = x - y
\`\`\`
  
---old_hunk---
\`\`\`
  z = x / y
    return z

def add(x, y):
    return x + y

def subtract(x, y):
    z = x - y
\`\`\`

---comment_chains---
\`\`\`
Please review this change.
\`\`\`

---end_change_section---

### Example response

22-22:
There's a syntax error in the add function.
\`\`\`diff
-    retrn z
+    return z
\`\`\`
---
24-25:
LGTM!
---

## Changes made to \`$filename\` for your review

$patches
`;
  comment = `A comment was made on a GitHub PR review for a 
diff hunk on a file - \`$filename\`. I would like you to follow 
the instructions in that comment. 

## GitHub PR Title

\`$title\`

## Description

\`\`\`
$description
\`\`\`

## Summary generated by the AI bot

\`\`\`
$short_summary
\`\`\`

## Entire diff

\`\`\`diff
$file_diff
\`\`\`

## Diff being commented on

\`\`\`diff
$diff
\`\`\`

## Instructions

Please reply directly to the new comment (instead of suggesting 
a reply) and your reply will be posted as-is.

If the comment contains instructions/requests for you, please comply. 
For example, if the comment is asking you to generate documentation 
comments on the code, in your reply please generate the required code.

In your reply, please make sure to begin the reply by tagging the user 
with "@user".

## Comment format

\`user: comment\`

## Comment chain (including the new comment)

\`\`\`
$comment_chain
\`\`\`

## The comment/request that you need to directly reply to

\`\`\`
$comment
\`\`\`
`;
  constructor(summarize = "", summarizeReleaseNotes = "") {
    this.summarize = summarize;
    this.summarizeReleaseNotes = summarizeReleaseNotes;
  }
  renderSummarizeFileDiff(inputs, reviewSimpleChanges) {
    let prompt = this.summarizeFileDiff;
    if (reviewSimpleChanges === false) {
      prompt += this.triageFileDiff;
    }
    return inputs.render(prompt);
  }
  renderSummarizeChangesets(inputs) {
    return inputs.render(this.summarizeChangesets);
  }
  renderSummarize(inputs) {
    const prompt = this.summarizePrefix + this.summarize;
    return inputs.render(prompt);
  }
  renderSummarizeShort(inputs) {
    const prompt = this.summarizePrefix + this.summarizeShort;
    return inputs.render(prompt);
  }
  renderSummarizeReleaseNotes(inputs) {
    const prompt = this.summarizePrefix + this.summarizeReleaseNotes;
    return inputs.render(prompt);
  }
  renderComment(inputs) {
    return inputs.render(this.comment);
  }
  renderReviewFileDiff(inputs) {
    return inputs.render(this.reviewFileDiff);
  }
};

// src/review.mts
var import_core5 = require("@actions/core");
var import_github2 = require("@actions/github");
var import_p_limit = __toESM(require("p-limit"), 1);

// src/commenter.mts
var import_core4 = require("@actions/core");
var import_github = require("@actions/github");

// src/octokit.mts
var import_core3 = require("@actions/core");
var import_action = require("@octokit/action");
var import_plugin_retry = require("@octokit/plugin-retry");
var import_plugin_throttling = require("@octokit/plugin-throttling");
var token = (0, import_core3.getInput)("token") || process.env.GITHUB_TOKEN;
var RetryAndThrottlingOctokit = import_action.Octokit.plugin(import_plugin_throttling.throttling, import_plugin_retry.retry);
var octokit = new RetryAndThrottlingOctokit({
  auth: `token ${token}`,
  throttle: {
    onRateLimit: (retryAfter, options, _o, retryCount) => {
      (0, import_core3.warning)(
        `Request quota exhausted for request ${options.method} ${options.url}
Retry after: ${retryAfter} seconds
Retry count: ${retryCount}
`
      );
      if (retryCount <= 3) {
        (0, import_core3.warning)(`Retrying after ${retryAfter} seconds!`);
        return true;
      }
    },
    onSecondaryRateLimit: (retryAfter, options) => {
      (0, import_core3.warning)(
        `SecondaryRateLimit detected for request ${options.method} ${options.url} ; retry after ${retryAfter} seconds`
      );
      if (options.method === "POST" && options.url.match(/\/repos\/.*\/.*\/pulls\/.*\/reviews/)) {
        return false;
      }
      return true;
    }
  }
});

// src/commenter.mts
var repo = import_github.context.repo;
var COMMENT_GREETING = `${(0, import_core4.getInput)("bot_icon")}   CodeSailor`;
var COMMENT_TAG = "<!-- This is an auto-generated comment by OSS CodeSailor -->";
var COMMENT_REPLY_TAG = "<!-- This is an auto-generated reply by OSS CodeSailor -->";
var SUMMARIZE_TAG = "<!-- This is an auto-generated comment: summarize by OSS CodeSailor -->";
var IN_PROGRESS_START_TAG = "<!-- This is an auto-generated comment: summarize review in progress by OSS CodeSailor -->";
var IN_PROGRESS_END_TAG = "<!-- end of auto-generated comment: summarize review in progress by OSS CodeSailor -->";
var DESCRIPTION_START_TAG = "<!-- This is an auto-generated comment: release notes by OSS CodeSailor -->";
var DESCRIPTION_END_TAG = "<!-- end of auto-generated comment: release notes by OSS CodeSailor -->";
var RAW_SUMMARY_START_TAG = `<!-- This is an auto-generated comment: raw summary by OSS CodeSailor -->
<!--
`;
var RAW_SUMMARY_END_TAG = `-->
<!-- end of auto-generated comment: raw summary by OSS CodeSailor -->`;
var SHORT_SUMMARY_START_TAG = `<!-- This is an auto-generated comment: short summary by OSS CodeSailor -->
<!--
`;
var SHORT_SUMMARY_END_TAG = `-->
<!-- end of auto-generated comment: short summary by OSS CodeSailor -->`;
var COMMIT_ID_START_TAG = "<!-- commit_ids_reviewed_start -->";
var COMMIT_ID_END_TAG = "<!-- commit_ids_reviewed_end -->";
var Commenter = class {
  /**
   * @param mode Can be "create", "replace". Default is "replace".
   */
  async comment(message, tag, mode) {
    let target;
    if (import_github.context.payload.pull_request != null) {
      target = import_github.context.payload.pull_request.number;
    } else if (import_github.context.payload.issue != null) {
      target = import_github.context.payload.issue.number;
    } else {
      (0, import_core4.warning)(
        "Skipped: context.payload.pull_request and context.payload.issue are both null"
      );
      return;
    }
    if (!tag) {
      tag = COMMENT_TAG;
    }
    const body = `${COMMENT_GREETING}

${message}

${tag}`;
    if (mode === "create") {
      await this.create(body, target);
    } else if (mode === "replace") {
      await this.replace(body, tag, target);
    } else {
      (0, import_core4.warning)(`Unknown mode: ${mode}, use "replace" instead`);
      await this.replace(body, tag, target);
    }
  }
  getContentWithinTags(content, startTag, endTag) {
    const start = content.indexOf(startTag);
    const end = content.indexOf(endTag);
    if (start >= 0 && end >= 0) {
      return content.slice(start + startTag.length, end);
    }
    return "";
  }
  removeContentWithinTags(content, startTag, endTag) {
    const start = content.indexOf(startTag);
    const end = content.lastIndexOf(endTag);
    if (start >= 0 && end >= 0) {
      return content.slice(0, start) + content.slice(end + endTag.length);
    }
    return content;
  }
  getRawSummary(summary) {
    return this.getContentWithinTags(
      summary,
      RAW_SUMMARY_START_TAG,
      RAW_SUMMARY_END_TAG
    );
  }
  getShortSummary(summary) {
    return this.getContentWithinTags(
      summary,
      SHORT_SUMMARY_START_TAG,
      SHORT_SUMMARY_END_TAG
    );
  }
  getDescription(description) {
    return this.removeContentWithinTags(
      description,
      DESCRIPTION_START_TAG,
      DESCRIPTION_END_TAG
    );
  }
  getReleaseNotes(description) {
    const releaseNotes = this.getContentWithinTags(
      description,
      DESCRIPTION_START_TAG,
      DESCRIPTION_END_TAG
    );
    return releaseNotes.replace(/(^|\n)> .*/g, "");
  }
  async updateDescription(pullNumber, message) {
    try {
      const pr = await octokit.pulls.get({
        owner: repo.owner,
        repo: repo.repo,
        // eslint-disable-next-line camelcase
        pull_number: pullNumber
      });
      let body = "";
      if (pr.data.body) {
        body = pr.data.body;
      }
      const description = this.getDescription(body);
      const messageClean = this.removeContentWithinTags(
        message,
        DESCRIPTION_START_TAG,
        DESCRIPTION_END_TAG
      );
      const newDescription = `${description}
${DESCRIPTION_START_TAG}
${messageClean}
${DESCRIPTION_END_TAG}`;
      await octokit.pulls.update({
        owner: repo.owner,
        repo: repo.repo,
        // eslint-disable-next-line camelcase
        pull_number: pullNumber,
        body: newDescription
      });
    } catch (e) {
      (0, import_core4.warning)(
        `Failed to get PR: ${e}, skipping adding release notes to description.`
      );
    }
  }
  reviewCommentsBuffer = [];
  async bufferReviewComment(path, startLine, endLine, message) {
    message = `${COMMENT_GREETING}

${message}

${COMMENT_TAG}`;
    this.reviewCommentsBuffer.push({
      path,
      startLine,
      endLine,
      message
    });
  }
  async deletePendingReview(pullNumber) {
    try {
      const reviews = await octokit.pulls.listReviews({
        owner: repo.owner,
        repo: repo.repo,
        // eslint-disable-next-line camelcase
        pull_number: pullNumber
      });
      const pendingReview = reviews.data.find(
        (review) => review.state === "PENDING"
      );
      if (pendingReview) {
        (0, import_core4.info)(
          `Deleting pending review for PR #${pullNumber} id: ${pendingReview.id}`
        );
        try {
          await octokit.pulls.deletePendingReview({
            owner: repo.owner,
            repo: repo.repo,
            // eslint-disable-next-line camelcase
            pull_number: pullNumber,
            // eslint-disable-next-line camelcase
            review_id: pendingReview.id
          });
        } catch (e) {
          (0, import_core4.warning)(`Failed to delete pending review: ${e}`);
        }
      }
    } catch (e) {
      (0, import_core4.warning)(`Failed to list reviews: ${e}`);
    }
  }
  async submitReview(pullNumber, commitId, statusMsg) {
    const body = `${COMMENT_GREETING}

${statusMsg}
`;
    if (this.reviewCommentsBuffer.length === 0) {
      (0, import_core4.info)(`Submitting empty review for PR #${pullNumber}`);
      try {
        await octokit.pulls.createReview({
          owner: repo.owner,
          repo: repo.repo,
          // eslint-disable-next-line camelcase
          pull_number: pullNumber,
          // eslint-disable-next-line camelcase
          commit_id: commitId,
          event: "COMMENT",
          body
        });
      } catch (e) {
        (0, import_core4.warning)(`Failed to submit empty review: ${e}`);
      }
      return;
    }
    for (const comment of this.reviewCommentsBuffer) {
      const comments = await this.getCommentsAtRange(
        pullNumber,
        comment.path,
        comment.startLine,
        comment.endLine
      );
      for (const c of comments) {
        if (c.body.includes(COMMENT_TAG)) {
          (0, import_core4.info)(
            `Deleting review comment for ${comment.path}:${comment.startLine}-${comment.endLine}: ${comment.message}`
          );
          try {
            await octokit.pulls.deleteReviewComment({
              owner: repo.owner,
              repo: repo.repo,
              // eslint-disable-next-line camelcase
              comment_id: c.id
            });
          } catch (e) {
            (0, import_core4.warning)(`Failed to delete review comment: ${e}`);
          }
        }
      }
    }
    await this.deletePendingReview(pullNumber);
    const generateCommentData = (comment) => {
      const commentData = {
        path: comment.path,
        body: comment.message,
        line: comment.endLine
      };
      if (comment.startLine !== comment.endLine) {
        commentData.start_line = comment.startLine;
        commentData.start_side = "RIGHT";
      }
      return commentData;
    };
    try {
      const review = await octokit.pulls.createReview({
        owner: repo.owner,
        repo: repo.repo,
        // eslint-disable-next-line camelcase
        pull_number: pullNumber,
        // eslint-disable-next-line camelcase
        commit_id: commitId,
        comments: this.reviewCommentsBuffer.map(
          (comment) => generateCommentData(comment)
        )
      });
      (0, import_core4.info)(
        `Submitting review for PR #${pullNumber}, total comments: ${this.reviewCommentsBuffer.length}, review id: ${review.data.id}`
      );
      await octokit.pulls.submitReview({
        owner: repo.owner,
        repo: repo.repo,
        // eslint-disable-next-line camelcase
        pull_number: pullNumber,
        // eslint-disable-next-line camelcase
        review_id: review.data.id,
        event: "COMMENT",
        body
      });
    } catch (e) {
      (0, import_core4.warning)(
        `Failed to create review: ${e}. Falling back to individual comments.`
      );
      await this.deletePendingReview(pullNumber);
      let commentCounter = 0;
      for (const comment of this.reviewCommentsBuffer) {
        (0, import_core4.info)(
          `Creating new review comment for ${comment.path}:${comment.startLine}-${comment.endLine}: ${comment.message}`
        );
        const commentData = {
          owner: repo.owner,
          repo: repo.repo,
          // eslint-disable-next-line camelcase
          pull_number: pullNumber,
          // eslint-disable-next-line camelcase
          commit_id: commitId,
          ...generateCommentData(comment)
        };
        try {
          await octokit.pulls.createReviewComment(commentData);
        } catch (ee) {
          (0, import_core4.warning)(`Failed to create review comment: ${ee}`);
        }
        commentCounter++;
        (0, import_core4.info)(
          `Comment ${commentCounter}/${this.reviewCommentsBuffer.length} posted`
        );
      }
    }
  }
  async reviewCommentReply(pullNumber, topLevelComment, message) {
    const reply = `${COMMENT_GREETING}

${message}

${COMMENT_REPLY_TAG}
`;
    try {
      await octokit.pulls.createReplyForReviewComment({
        owner: repo.owner,
        repo: repo.repo,
        // eslint-disable-next-line camelcase
        pull_number: pullNumber,
        body: reply,
        // eslint-disable-next-line camelcase
        comment_id: topLevelComment.id
      });
    } catch (error2) {
      (0, import_core4.warning)(`Failed to reply to the top-level comment ${error2}`);
      try {
        await octokit.pulls.createReplyForReviewComment({
          owner: repo.owner,
          repo: repo.repo,
          // eslint-disable-next-line camelcase
          pull_number: pullNumber,
          body: `Could not post the reply to the top-level comment due to the following error: ${error2}`,
          // eslint-disable-next-line camelcase
          comment_id: topLevelComment.id
        });
      } catch (e) {
        (0, import_core4.warning)(`Failed to reply to the top-level comment ${e}`);
      }
    }
    try {
      if (topLevelComment.body.includes(COMMENT_TAG)) {
        const newBody = topLevelComment.body.replace(
          COMMENT_TAG,
          COMMENT_REPLY_TAG
        );
        await octokit.pulls.updateReviewComment({
          owner: repo.owner,
          repo: repo.repo,
          // eslint-disable-next-line camelcase
          comment_id: topLevelComment.id,
          body: newBody
        });
      }
    } catch (error2) {
      (0, import_core4.warning)(`Failed to update the top-level comment ${error2}`);
    }
  }
  async getCommentsWithinRange(pullNumber, path, startLine, endLine) {
    const comments = await this.listReviewComments(pullNumber);
    return comments.filter(
      (comment) => comment.path === path && comment.body !== "" && (comment.start_line !== void 0 && comment.start_line >= startLine && comment.line <= endLine || startLine === endLine && comment.line === endLine)
    );
  }
  async getCommentsAtRange(pullNumber, path, startLine, endLine) {
    const comments = await this.listReviewComments(pullNumber);
    return comments.filter(
      (comment) => comment.path === path && comment.body !== "" && (comment.start_line !== void 0 && comment.start_line === startLine && comment.line === endLine || startLine === endLine && comment.line === endLine)
    );
  }
  async getCommentChainsWithinRange(pullNumber, path, startLine, endLine, tag = "") {
    const existingComments = await this.getCommentsWithinRange(
      pullNumber,
      path,
      startLine,
      endLine
    );
    const topLevelComments = [];
    for (const comment of existingComments) {
      if (!comment.in_reply_to_id) {
        topLevelComments.push(comment);
      }
    }
    let allChains = "";
    let chainNum = 0;
    for (const topLevelComment of topLevelComments) {
      const chain = await this.composeCommentChain(
        existingComments,
        topLevelComment
      );
      if (chain && chain.includes(tag)) {
        chainNum += 1;
        allChains += `Conversation Chain ${chainNum}:
${chain}
---
`;
      }
    }
    return allChains;
  }
  async composeCommentChain(reviewComments, topLevelComment) {
    const conversationChain = reviewComments.filter((cmt) => cmt.in_reply_to_id === topLevelComment.id).map((cmt) => `${cmt.user.login}: ${cmt.body}`);
    conversationChain.unshift(
      `${topLevelComment.user.login}: ${topLevelComment.body}`
    );
    return conversationChain.join("\n---\n");
  }
  async getCommentChain(pullNumber, comment) {
    try {
      const reviewComments = await this.listReviewComments(pullNumber);
      const topLevelComment = await this.getTopLevelComment(
        reviewComments,
        comment
      );
      const chain = await this.composeCommentChain(
        reviewComments,
        topLevelComment
      );
      return { chain, topLevelComment };
    } catch (e) {
      (0, import_core4.warning)(`Failed to get conversation chain: ${e}`);
      return {
        chain: "",
        topLevelComment: null
      };
    }
  }
  async getTopLevelComment(reviewComments, comment) {
    let topLevelComment = comment;
    while (topLevelComment.in_reply_to_id) {
      const parentComment = reviewComments.find(
        (cmt) => cmt.id === topLevelComment.in_reply_to_id
      );
      if (parentComment) {
        topLevelComment = parentComment;
      } else {
        break;
      }
    }
    return topLevelComment;
  }
  reviewCommentsCache = {};
  async listReviewComments(target) {
    if (this.reviewCommentsCache[target]) {
      return this.reviewCommentsCache[target];
    }
    const allComments = [];
    let page = 1;
    try {
      for (; ; ) {
        const { data: comments } = await octokit.pulls.listReviewComments({
          owner: repo.owner,
          repo: repo.repo,
          // eslint-disable-next-line camelcase
          pull_number: target,
          page,
          // eslint-disable-next-line camelcase
          per_page: 100
        });
        allComments.push(...comments);
        page++;
        if (!comments || comments.length < 100) {
          break;
        }
      }
      this.reviewCommentsCache[target] = allComments;
      return allComments;
    } catch (e) {
      (0, import_core4.warning)(`Failed to list review comments: ${e}`);
      return allComments;
    }
  }
  async create(body, target) {
    try {
      const response = await octokit.issues.createComment({
        owner: repo.owner,
        repo: repo.repo,
        // eslint-disable-next-line camelcase
        issue_number: target,
        body
      });
      if (this.issueCommentsCache[target]) {
        this.issueCommentsCache[target].push(response.data);
      } else {
        this.issueCommentsCache[target] = [response.data];
      }
    } catch (e) {
      (0, import_core4.warning)(`Failed to create comment: ${e}`);
    }
  }
  async replace(body, tag, target) {
    try {
      const cmt = await this.findCommentWithTag(tag, target);
      if (cmt) {
        await octokit.issues.updateComment({
          owner: repo.owner,
          repo: repo.repo,
          // eslint-disable-next-line camelcase
          comment_id: cmt.id,
          body
        });
      } else {
        await this.create(body, target);
      }
    } catch (e) {
      (0, import_core4.warning)(`Failed to replace comment: ${e}`);
    }
  }
  async findCommentWithTag(tag, target) {
    try {
      const comments = await this.listComments(target);
      for (const cmt of comments) {
        if (cmt.body && cmt.body.includes(tag)) {
          return cmt;
        }
      }
      return null;
    } catch (e) {
      (0, import_core4.warning)(`Failed to find comment with tag: ${e}`);
      return null;
    }
  }
  issueCommentsCache = {};
  async listComments(target) {
    if (this.issueCommentsCache[target]) {
      return this.issueCommentsCache[target];
    }
    const allComments = [];
    let page = 1;
    try {
      for (; ; ) {
        const { data: comments } = await octokit.issues.listComments({
          owner: repo.owner,
          repo: repo.repo,
          // eslint-disable-next-line camelcase
          issue_number: target,
          page,
          // eslint-disable-next-line camelcase
          per_page: 100
        });
        allComments.push(...comments);
        page++;
        if (!comments || comments.length < 100) {
          break;
        }
      }
      this.issueCommentsCache[target] = allComments;
      return allComments;
    } catch (e) {
      (0, import_core4.warning)(`Failed to list comments: ${e}`);
      return allComments;
    }
  }
  // function that takes a comment body and returns the list of commit ids that have been reviewed
  // commit ids are comments between the commit_ids_reviewed_start and commit_ids_reviewed_end markers
  // <!-- [commit_id] -->
  getReviewedCommitIds(commentBody) {
    const start = commentBody.indexOf(COMMIT_ID_START_TAG);
    const end = commentBody.indexOf(COMMIT_ID_END_TAG);
    if (start === -1 || end === -1) {
      return [];
    }
    const ids = commentBody.substring(start + COMMIT_ID_START_TAG.length, end);
    return ids.split("<!--").map((id) => id.replace("-->", "").trim()).filter((id) => id !== "");
  }
  // get review commit ids comment block from the body as a string
  // including markers
  getReviewedCommitIdsBlock(commentBody) {
    const start = commentBody.indexOf(COMMIT_ID_START_TAG);
    const end = commentBody.indexOf(COMMIT_ID_END_TAG);
    if (start === -1 || end === -1) {
      return "";
    }
    return commentBody.substring(start, end + COMMIT_ID_END_TAG.length);
  }
  // add a commit id to the list of reviewed commit ids
  // if the marker doesn't exist, add it
  addReviewedCommitId(commentBody, commitId) {
    const start = commentBody.indexOf(COMMIT_ID_START_TAG);
    const end = commentBody.indexOf(COMMIT_ID_END_TAG);
    if (start === -1 || end === -1) {
      return `${commentBody}
${COMMIT_ID_START_TAG}
<!-- ${commitId} -->
${COMMIT_ID_END_TAG}`;
    }
    const ids = commentBody.substring(start + COMMIT_ID_START_TAG.length, end);
    return `${commentBody.substring(
      0,
      start + COMMIT_ID_START_TAG.length
    )}${ids}<!-- ${commitId} -->
${commentBody.substring(end)}`;
  }
  // given a list of commit ids provide the highest commit id that has been reviewed
  getHighestReviewedCommitId(commitIds, reviewedCommitIds) {
    for (let i = commitIds.length - 1; i >= 0; i--) {
      if (reviewedCommitIds.includes(commitIds[i])) {
        return commitIds[i];
      }
    }
    return "";
  }
  async getAllCommitIds() {
    const allCommits = [];
    let page = 1;
    let commits;
    if (import_github.context && import_github.context.payload && import_github.context.payload.pull_request != null) {
      do {
        commits = await octokit.pulls.listCommits({
          owner: repo.owner,
          repo: repo.repo,
          // eslint-disable-next-line camelcase
          pull_number: import_github.context.payload.pull_request.number,
          // eslint-disable-next-line camelcase
          per_page: 100,
          page
        });
        allCommits.push(...commits.data.map((commit) => commit.sha));
        page++;
      } while (commits.data.length > 0);
    }
    return allCommits;
  }
  // add in-progress status to the comment body
  addInProgressStatus(commentBody, statusMsg) {
    const start = commentBody.indexOf(IN_PROGRESS_START_TAG);
    const end = commentBody.indexOf(IN_PROGRESS_END_TAG);
    if (start === -1 || end === -1) {
      return `${IN_PROGRESS_START_TAG}

Currently reviewing new changes in this PR...

${statusMsg}

${IN_PROGRESS_END_TAG}

---

${commentBody}`;
    }
    return commentBody;
  }
  // remove in-progress status from the comment body
  removeInProgressStatus(commentBody) {
    const start = commentBody.indexOf(IN_PROGRESS_START_TAG);
    const end = commentBody.indexOf(IN_PROGRESS_END_TAG);
    if (start !== -1 && end !== -1) {
      return commentBody.substring(0, start) + commentBody.substring(end + IN_PROGRESS_END_TAG.length);
    }
    return commentBody;
  }
};

// src/inputs.mts
var Inputs = class _Inputs {
  systemMessage;
  title;
  description;
  rawSummary;
  shortSummary;
  filename;
  fileContent;
  fileDiff;
  patches;
  diff;
  commentChain;
  comment;
  constructor(systemMessage = "", title = "no title provided", description = "no description provided", rawSummary = "", shortSummary = "", filename = "", fileContent = "file contents cannot be provided", fileDiff = "file diff cannot be provided", patches = "", diff = "no diff", commentChain = "no other comments on this patch", comment = "no comment provided") {
    this.systemMessage = systemMessage;
    this.title = title;
    this.description = description;
    this.rawSummary = rawSummary;
    this.shortSummary = shortSummary;
    this.filename = filename;
    this.fileContent = fileContent;
    this.fileDiff = fileDiff;
    this.patches = patches;
    this.diff = diff;
    this.commentChain = commentChain;
    this.comment = comment;
  }
  clone() {
    return new _Inputs(
      this.systemMessage,
      this.title,
      this.description,
      this.rawSummary,
      this.shortSummary,
      this.filename,
      this.fileContent,
      this.fileDiff,
      this.patches,
      this.diff,
      this.commentChain,
      this.comment
    );
  }
  render(content) {
    if (!content) {
      return "";
    }
    if (this.systemMessage) {
      content = content.replace("$system_message", this.systemMessage);
    }
    if (this.title) {
      content = content.replace("$title", this.title);
    }
    if (this.description) {
      content = content.replace("$description", this.description);
    }
    if (this.rawSummary) {
      content = content.replace("$raw_summary", this.rawSummary);
    }
    if (this.shortSummary) {
      content = content.replace("$short_summary", this.shortSummary);
    }
    if (this.filename) {
      content = content.replace("$filename", this.filename);
    }
    if (this.fileContent) {
      content = content.replace("$file_content", this.fileContent);
    }
    if (this.fileDiff) {
      content = content.replace("$file_diff", this.fileDiff);
    }
    if (this.patches) {
      content = content.replace("$patches", this.patches);
    }
    if (this.diff) {
      content = content.replace("$diff", this.diff);
    }
    if (this.commentChain) {
      content = content.replace("$comment_chain", this.commentChain);
    }
    if (this.comment) {
      content = content.replace("$comment", this.comment);
    }
    return content;
  }
};

// src/tokenizer.mts
var import_tiktoken = require("@dqbd/tiktoken");
var tokenizer = (0, import_tiktoken.get_encoding)("cl100k_base");
function encode(input) {
  return tokenizer.encode(input);
}
function getTokenCount(input) {
  input = input.replace(/<\|endoftext\|>/g, "");
  return encode(input).length;
}

// src/review.mts
var context2 = import_github2.context;
var repo2 = context2.repo;
var ignoreKeyword = "@codesailorai: ignore";
var codeReview = async (lightBot, heavyBot, options, prompts) => {
  const commenter = new Commenter();
  const openaiConcurrencyLimit = (0, import_p_limit.default)(options.openaiConcurrencyLimit);
  const githubConcurrencyLimit = (0, import_p_limit.default)(options.githubConcurrencyLimit);
  if (context2.eventName !== "pull_request" && context2.eventName !== "pull_request_target") {
    (0, import_core5.warning)(
      `Skipped: current event is ${context2.eventName}, only support pull_request event`
    );
    return;
  }
  if (context2.payload.pull_request == null) {
    (0, import_core5.warning)("Skipped: context.payload.pull_request is null");
    return;
  }
  const inputs = new Inputs();
  inputs.title = context2.payload.pull_request.title;
  if (context2.payload.pull_request.body != null) {
    inputs.description = commenter.getDescription(
      context2.payload.pull_request.body
    );
  }
  if (inputs.description.includes(ignoreKeyword)) {
    (0, import_core5.info)("Skipped: description contains ignore_keyword");
    return;
  }
  inputs.systemMessage = options.systemMessage;
  const existingSummarizeCmt = await commenter.findCommentWithTag(
    SUMMARIZE_TAG,
    context2.payload.pull_request.number
  );
  let existingCommitIdsBlock = "";
  let existingSummarizeCmtBody = "";
  if (existingSummarizeCmt != null) {
    existingSummarizeCmtBody = existingSummarizeCmt.body;
    inputs.rawSummary = commenter.getRawSummary(existingSummarizeCmtBody);
    inputs.shortSummary = commenter.getShortSummary(existingSummarizeCmtBody);
    existingCommitIdsBlock = commenter.getReviewedCommitIdsBlock(
      existingSummarizeCmtBody
    );
  }
  const allCommitIds = await commenter.getAllCommitIds();
  let highestReviewedCommitId = "";
  if (existingCommitIdsBlock !== "") {
    highestReviewedCommitId = commenter.getHighestReviewedCommitId(
      allCommitIds,
      commenter.getReviewedCommitIds(existingCommitIdsBlock)
    );
  }
  if (highestReviewedCommitId === "" || highestReviewedCommitId === context2.payload.pull_request.head.sha) {
    (0, import_core5.info)(
      `Will review from the base commit: ${context2.payload.pull_request.base.sha}`
    );
    highestReviewedCommitId = context2.payload.pull_request.base.sha;
  } else {
    (0, import_core5.info)(`Will review from commit: ${highestReviewedCommitId}`);
  }
  const incrementalDiff = await octokit.repos.compareCommits({
    owner: repo2.owner,
    repo: repo2.repo,
    base: highestReviewedCommitId,
    head: context2.payload.pull_request.head.sha
  });
  const targetBranchDiff = await octokit.repos.compareCommits({
    owner: repo2.owner,
    repo: repo2.repo,
    base: context2.payload.pull_request.base.sha,
    head: context2.payload.pull_request.head.sha
  });
  const incrementalFiles = incrementalDiff.data.files;
  const targetBranchFiles = targetBranchDiff.data.files;
  if (incrementalFiles == null || targetBranchFiles == null) {
    (0, import_core5.warning)("Skipped: files data is missing");
    return;
  }
  const files = targetBranchFiles.filter(
    (targetBranchFile) => incrementalFiles.some(
      (incrementalFile) => incrementalFile.filename === targetBranchFile.filename
    )
  );
  if (files.length === 0) {
    (0, import_core5.warning)("Skipped: files is null");
    return;
  }
  const filterSelectedFiles = [];
  const filterIgnoredFiles = [];
  for (const file of files) {
    if (!options.checkPath(file.filename)) {
      (0, import_core5.info)(`skip for excluded path: ${file.filename}`);
      filterIgnoredFiles.push(file);
    } else {
      filterSelectedFiles.push(file);
    }
  }
  if (filterSelectedFiles.length === 0) {
    (0, import_core5.warning)("Skipped: filterSelectedFiles is null");
    return;
  }
  const commits = incrementalDiff.data.commits;
  if (commits.length === 0) {
    (0, import_core5.warning)("Skipped: commits is null");
    return;
  }
  const filteredFiles = await Promise.all(
    filterSelectedFiles.map(
      (file) => githubConcurrencyLimit(async () => {
        let fileContent = "";
        if (context2.payload.pull_request == null) {
          (0, import_core5.warning)("Skipped: context.payload.pull_request is null");
          return null;
        }
        try {
          const contents = await octokit.repos.getContent({
            owner: repo2.owner,
            repo: repo2.repo,
            path: file.filename,
            ref: context2.payload.pull_request.base.sha
          });
          if (contents.data != null) {
            if (!Array.isArray(contents.data)) {
              if (contents.data.type === "file" && contents.data.content != null) {
                fileContent = Buffer.from(
                  contents.data.content,
                  "base64"
                ).toString();
              }
            }
          }
        } catch (e) {
          (0, import_core5.warning)(
            `Failed to get file contents: ${e}. This is OK if it's a new file.`
          );
        }
        let fileDiff = "";
        if (file.patch != null) {
          fileDiff = file.patch;
        }
        const patches = [];
        for (const patch of splitPatch(file.patch)) {
          const patchLines = patchStartEndLine(patch);
          if (patchLines == null) {
            continue;
          }
          const hunks = parsePatch(patch);
          if (hunks == null) {
            continue;
          }
          const hunksStr = `
---new_hunk---
\`\`\`
${hunks.newHunk}
\`\`\`

---old_hunk---
\`\`\`
${hunks.oldHunk}
\`\`\`
`;
          patches.push([
            patchLines.newHunk.startLine,
            patchLines.newHunk.endLine,
            hunksStr
          ]);
        }
        if (patches.length > 0) {
          return [file.filename, fileContent, fileDiff, patches];
        } else {
          return null;
        }
      })
    )
  );
  const filesAndChanges = filteredFiles.filter((file) => file !== null);
  if (filesAndChanges.length === 0) {
    (0, import_core5.error)("Skipped: no files to review");
    return;
  }
  let statusMsg = `<details>
<summary>Commits</summary>
Files that changed from the base of the PR and between ${highestReviewedCommitId} and ${context2.payload.pull_request.head.sha} commits.
</details>
${filesAndChanges.length > 0 ? `
<details>
<summary>Files selected (${filesAndChanges.length})</summary>

* ${filesAndChanges.map(([filename, , , patches]) => `${filename} (${patches.length})`).join("\n* ")}
</details>
` : ""}
${filterIgnoredFiles.length > 0 ? `
<details>
<summary>Files ignored due to filter (${filterIgnoredFiles.length})</summary>

* ${filterIgnoredFiles.map((file) => file.filename).join("\n* ")}

</details>
` : ""}
`;
  const inProgressSummarizeCmt = commenter.addInProgressStatus(
    existingSummarizeCmtBody,
    statusMsg
  );
  await commenter.comment(`${inProgressSummarizeCmt}`, SUMMARIZE_TAG, "replace");
  const summariesFailed = [];
  const doSummary = async (filename, fileContent, fileDiff) => {
    (0, import_core5.info)(`summarize: ${filename}`);
    const ins = inputs.clone();
    if (fileDiff.length === 0) {
      (0, import_core5.warning)(`summarize: file_diff is empty, skip ${filename}`);
      summariesFailed.push(`${filename} (empty diff)`);
      return null;
    }
    ins.filename = filename;
    ins.fileDiff = fileDiff;
    const summarizePrompt = prompts.renderSummarizeFileDiff(
      ins,
      options.reviewSimpleChanges
    );
    const tokens = getTokenCount(summarizePrompt);
    if (tokens > options.lightTokenLimits.requestTokens) {
      (0, import_core5.info)(`summarize: diff tokens exceeds limit, skip ${filename}`);
      summariesFailed.push(`${filename} (diff tokens exceeds limit)`);
      return null;
    }
    try {
      const summarizeResp = await lightBot.chat(summarizePrompt);
      if (summarizeResp === "") {
        (0, import_core5.info)("summarize: nothing obtained from openai");
        summariesFailed.push(`${filename} (nothing obtained from openai)`);
        return null;
      } else {
        if (options.reviewSimpleChanges === false) {
          const triageRegex = /\[TRIAGE\]:\s*(NEEDS_REVIEW|APPROVED)/;
          const triageMatch = summarizeResp.match(triageRegex);
          if (triageMatch != null) {
            const triage = triageMatch[1];
            const needsReview = triage === "NEEDS_REVIEW";
            const summary = summarizeResp.replace(triageRegex, "").trim();
            (0, import_core5.info)(`filename: ${filename}, triage: ${triage}`);
            return [filename, summary, needsReview];
          }
        }
        return [filename, summarizeResp, true];
      }
    } catch (e) {
      (0, import_core5.warning)(`summarize: error from openai: ${e}`);
      summariesFailed.push(`${filename} (error from openai: ${e})})`);
      return null;
    }
  };
  const summaryPromises = [];
  const skippedFiles = [];
  for (const [filename, fileContent, fileDiff] of filesAndChanges) {
    if (options.maxFiles <= 0 || summaryPromises.length < options.maxFiles) {
      summaryPromises.push(
        openaiConcurrencyLimit(
          async () => await doSummary(filename, fileContent, fileDiff)
        )
      );
    } else {
      skippedFiles.push(filename);
    }
  }
  const summaries = (await Promise.all(summaryPromises)).filter(
    (summary) => summary !== null
  );
  if (summaries.length > 0) {
    const batchSize = 10;
    for (let i = 0; i < summaries.length; i += batchSize) {
      const summariesBatch = summaries.slice(i, i + batchSize);
      for (const [filename, summary] of summariesBatch) {
        inputs.rawSummary += `---
${filename}: ${summary}
`;
      }
      const summarizeResp = await heavyBot.chat(
        prompts.renderSummarizeChangesets(inputs)
      );
      if (summarizeResp === "") {
        (0, import_core5.warning)("summarize: nothing obtained from openai");
      } else {
        inputs.rawSummary = summarizeResp;
      }
    }
  }
  const summarizeFinalResponse = await heavyBot.chat(
    prompts.renderSummarize(inputs)
  );
  if (summarizeFinalResponse === "") {
    (0, import_core5.info)("summarize: nothing obtained from openai");
  }
  if (options.disableReleaseNotes === false) {
    const releaseNotesResponse = await heavyBot.chat(
      prompts.renderSummarizeReleaseNotes(inputs)
    );
    if (releaseNotesResponse === "") {
      (0, import_core5.info)("release notes: nothing obtained from openai");
    } else {
      let message = "### Summary by CodeSailor\n\n";
      message += releaseNotesResponse;
      try {
        await commenter.updateDescription(
          context2.payload.pull_request.number,
          message
        );
      } catch (e) {
        (0, import_core5.warning)(`release notes: error from github: ${e.message}`);
      }
    }
  }
  const summarizeShortResponse = await heavyBot.chat(
    prompts.renderSummarizeShort(inputs)
  );
  inputs.shortSummary = summarizeShortResponse;
  let summarizeComment = `${summarizeFinalResponse}
${RAW_SUMMARY_START_TAG}
${inputs.rawSummary}
${RAW_SUMMARY_END_TAG}
${SHORT_SUMMARY_START_TAG}
${inputs.shortSummary}
${SHORT_SUMMARY_END_TAG}

`;
  statusMsg += `
${skippedFiles.length > 0 ? `
<details>
<summary>Files not processed due to max files limit (${skippedFiles.length})</summary>

* ${skippedFiles.join("\n* ")}

</details>
` : ""}
${summariesFailed.length > 0 ? `
<details>
<summary>Files not summarized due to errors (${summariesFailed.length})</summary>

* ${summariesFailed.join("\n* ")}

</details>
` : ""}
`;
  if (!options.disableReview) {
    const filesAndChangesReview = filesAndChanges.filter(([filename]) => {
      const needsReview = summaries.find(
        ([summaryFilename]) => summaryFilename === filename
      )?.[2] ?? true;
      return needsReview;
    });
    const reviewsSkipped = filesAndChanges.filter(
      ([filename]) => !filesAndChangesReview.some(
        ([reviewFilename]) => reviewFilename === filename
      )
    ).map(([filename]) => filename);
    const reviewsFailed = [];
    let lgtmCount = 0;
    let reviewCount = 0;
    const doReview = async (filename, fileContent, patches) => {
      (0, import_core5.info)(`reviewing ${filename}`);
      const ins = inputs.clone();
      ins.filename = filename;
      let tokens = getTokenCount(prompts.renderReviewFileDiff(ins));
      let patchesToPack = 0;
      for (const [, , patch] of patches) {
        const patchTokens = getTokenCount(patch);
        if (tokens + patchTokens > options.heavyTokenLimits.requestTokens) {
          (0, import_core5.info)(
            `only packing ${patchesToPack} / ${patches.length} patches, tokens: ${tokens} / ${options.heavyTokenLimits.requestTokens}`
          );
          break;
        }
        tokens += patchTokens;
        patchesToPack += 1;
      }
      let patchesPacked = 0;
      for (const [startLine, endLine, patch] of patches) {
        if (context2.payload.pull_request == null) {
          (0, import_core5.warning)("No pull request found, skipping.");
          continue;
        }
        if (patchesPacked >= patchesToPack) {
          (0, import_core5.info)(
            `unable to pack more patches into this request, packed: ${patchesPacked}, total patches: ${patches.length}, skipping.`
          );
          if (options.debug) {
            (0, import_core5.info)(`prompt so far: ${prompts.renderReviewFileDiff(ins)}`);
          }
          break;
        }
        patchesPacked += 1;
        let commentChain = "";
        try {
          const allChains = await commenter.getCommentChainsWithinRange(
            context2.payload.pull_request.number,
            filename,
            startLine,
            endLine,
            COMMENT_REPLY_TAG
          );
          if (allChains.length > 0) {
            (0, import_core5.info)(`Found comment chains: ${allChains} for ${filename}`);
            commentChain = allChains;
          }
        } catch (e) {
          (0, import_core5.warning)(
            `Failed to get comments: ${e}, skipping. backtrace: ${e.stack}`
          );
        }
        const commentChainTokens = getTokenCount(commentChain);
        if (tokens + commentChainTokens > options.heavyTokenLimits.requestTokens) {
          commentChain = "";
        } else {
          tokens += commentChainTokens;
        }
        ins.patches += `
${patch}
`;
        if (commentChain !== "") {
          ins.patches += `
---comment_chains---
\`\`\`
${commentChain}
\`\`\`
`;
        }
        ins.patches += `
---end_change_section---
`;
      }
      if (patchesPacked > 0) {
        try {
          const response = await heavyBot.chat(
            prompts.renderReviewFileDiff(ins)
          );
          if (response === "") {
            (0, import_core5.info)("review: nothing obtained from openai");
            reviewsFailed.push(`${filename} (no response)`);
            return;
          }
          const reviews = parseReview(response, patches, options.debug);
          for (const review of reviews) {
            if (!options.reviewCommentLGTM && (review.comment.includes("LGTM") || review.comment.includes("looks good to me"))) {
              lgtmCount += 1;
              continue;
            }
            if (context2.payload.pull_request == null) {
              (0, import_core5.warning)("No pull request found, skipping.");
              continue;
            }
            try {
              reviewCount += 1;
              await commenter.bufferReviewComment(
                filename,
                review.startLine,
                review.endLine,
                `${review.comment}`
              );
            } catch (e) {
              reviewsFailed.push(`${filename} comment failed (${e})`);
            }
          }
        } catch (e) {
          (0, import_core5.warning)(
            `Failed to review: ${e}, skipping. backtrace: ${e.stack}`
          );
          reviewsFailed.push(`${filename} (${e})`);
        }
      } else {
        reviewsSkipped.push(`${filename} (diff too large)`);
      }
    };
    const reviewPromises = [];
    for (const [filename, fileContent, , patches] of filesAndChangesReview) {
      if (options.maxFiles <= 0 || reviewPromises.length < options.maxFiles) {
        reviewPromises.push(
          openaiConcurrencyLimit(async () => {
            await doReview(filename, fileContent, patches);
          })
        );
      } else {
        skippedFiles.push(filename);
      }
    }
    await Promise.all(reviewPromises);
    statusMsg += `
${reviewsFailed.length > 0 ? `<details>
<summary>Files not reviewed due to errors (${reviewsFailed.length})</summary>

* ${reviewsFailed.join("\n* ")}

</details>
` : ""}
${reviewsSkipped.length > 0 ? `<details>
<summary>Files skipped from review due to trivial changes (${reviewsSkipped.length})</summary>

* ${reviewsSkipped.join("\n* ")}

</details>
` : ""}
<details>
<summary>Review comments generated (${reviewCount + lgtmCount})</summary>

* Review: ${reviewCount}
* LGTM: ${lgtmCount}

</details>

---

<details>
<summary>Tips</summary>

### Chat with <img src="https://avatars.githubusercontent.com/in/347564?s=41&u=fad245b8b4c7254fe63dd4dcd4d662ace122757e&v=4" alt="Image description" width="20" height="20">  CodeSailor Bot (\`@codesailorai\`)
- Reply on review comments left by this bot to ask follow-up questions. A review comment is a comment on a diff or a file.
- Invite the bot into a review comment chain by tagging \`@codesailorai\` in a reply.

### Code suggestions
- The bot may make code suggestions, but please review them carefully before committing since the line number ranges may be misaligned. 
- You can edit the comment made by the bot and manually tweak the suggestion if it is slightly off.

### Pausing incremental reviews
- Add \`@codesailorai: ignore\` anywhere in the PR description to pause further reviews from the bot.

</details>
`;
    summarizeComment += `
${commenter.addReviewedCommitId(
      existingCommitIdsBlock,
      context2.payload.pull_request.head.sha
    )}`;
    await commenter.submitReview(
      context2.payload.pull_request.number,
      commits[commits.length - 1].sha,
      statusMsg
    );
  }
  await commenter.comment(`${summarizeComment}`, SUMMARIZE_TAG, "replace");
};
var splitPatch = (patch) => {
  if (patch == null) {
    return [];
  }
  const pattern = /(^@@ -(\d+),(\d+) \+(\d+),(\d+) @@).*$/gm;
  const result = [];
  let last = -1;
  let match;
  while ((match = pattern.exec(patch)) !== null) {
    if (last === -1) {
      last = match.index;
    } else {
      result.push(patch.substring(last, match.index));
      last = match.index;
    }
  }
  if (last !== -1) {
    result.push(patch.substring(last));
  }
  return result;
};
var patchStartEndLine = (patch) => {
  const pattern = /(^@@ -(\d+),(\d+) \+(\d+),(\d+) @@)/gm;
  const match = pattern.exec(patch);
  if (match != null) {
    const oldBegin = parseInt(match[2]);
    const oldDiff = parseInt(match[3]);
    const newBegin = parseInt(match[4]);
    const newDiff = parseInt(match[5]);
    return {
      oldHunk: {
        startLine: oldBegin,
        endLine: oldBegin + oldDiff - 1
      },
      newHunk: {
        startLine: newBegin,
        endLine: newBegin + newDiff - 1
      }
    };
  } else {
    return null;
  }
};
var parsePatch = (patch) => {
  const hunkInfo = patchStartEndLine(patch);
  if (hunkInfo == null) {
    return null;
  }
  const oldHunkLines = [];
  const newHunkLines = [];
  let newLine = hunkInfo.newHunk.startLine;
  const lines = patch.split("\n").slice(1);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  const skipStart = 3;
  const skipEnd = 3;
  let currentLine = 0;
  const removalOnly = !lines.some((line) => line.startsWith("+"));
  for (const line of lines) {
    currentLine++;
    if (line.startsWith("-")) {
      oldHunkLines.push(`${line.substring(1)}`);
    } else if (line.startsWith("+")) {
      newHunkLines.push(`${newLine}: ${line.substring(1)}`);
      newLine++;
    } else {
      oldHunkLines.push(`${line}`);
      if (removalOnly || currentLine > skipStart && currentLine <= lines.length - skipEnd) {
        newHunkLines.push(`${newLine}: ${line}`);
      } else {
        newHunkLines.push(`${line}`);
      }
      newLine++;
    }
  }
  return {
    oldHunk: oldHunkLines.join("\n"),
    newHunk: newHunkLines.join("\n")
  };
};
function parseReview(response, patches, debug = false) {
  const reviews = [];
  response = sanitizeResponse(response.trim());
  const lines = response.split("\n");
  const lineNumberRangeRegex = /(?:^|\s)(\d+)-(\d+):\s*$/;
  const commentSeparator = "---";
  let currentStartLine = null;
  let currentEndLine = null;
  let currentComment = "";
  function storeReview() {
    if (currentStartLine !== null && currentEndLine !== null) {
      const review = {
        startLine: currentStartLine,
        endLine: currentEndLine,
        comment: currentComment
      };
      let withinPatch = false;
      let bestPatchStartLine = -1;
      let bestPatchEndLine = -1;
      let maxIntersection = 0;
      for (const [startLine, endLine] of patches) {
        const intersectionStart = Math.max(review.startLine, startLine);
        const intersectionEnd = Math.min(review.endLine, endLine);
        const intersectionLength = Math.max(
          0,
          intersectionEnd - intersectionStart + 1
        );
        if (intersectionLength > maxIntersection) {
          maxIntersection = intersectionLength;
          bestPatchStartLine = startLine;
          bestPatchEndLine = endLine;
          withinPatch = intersectionLength === review.endLine - review.startLine + 1;
        }
        if (withinPatch) break;
      }
      if (!withinPatch) {
        if (bestPatchStartLine !== -1 && bestPatchEndLine !== -1) {
          review.comment = `> Note: This review was outside of the patch, so it was mapped to the patch with the greatest overlap. Original lines [${review.startLine}-${review.endLine}]

${review.comment}`;
          review.startLine = bestPatchStartLine;
          review.endLine = bestPatchEndLine;
        } else {
          review.comment = `> Note: This review was outside of the patch, but no patch was found that overlapped with it. Original lines [${review.startLine}-${review.endLine}]

${review.comment}`;
          review.startLine = patches[0][0];
          review.endLine = patches[0][1];
        }
      }
      reviews.push(review);
      (0, import_core5.info)(
        `Stored comment for line range ${currentStartLine}-${currentEndLine}: ${currentComment.trim()}`
      );
    }
  }
  function sanitizeCodeBlock(comment, codeBlockLabel) {
    const codeBlockStart = `\`\`\`${codeBlockLabel}`;
    const codeBlockEnd = "```";
    const lineNumberRegex = /^ *(\d+): /gm;
    let codeBlockStartIndex = comment.indexOf(codeBlockStart);
    while (codeBlockStartIndex !== -1) {
      const codeBlockEndIndex = comment.indexOf(
        codeBlockEnd,
        codeBlockStartIndex + codeBlockStart.length
      );
      if (codeBlockEndIndex === -1) break;
      const codeBlock = comment.substring(
        codeBlockStartIndex + codeBlockStart.length,
        codeBlockEndIndex
      );
      const sanitizedBlock = codeBlock.replace(lineNumberRegex, "");
      comment = comment.slice(0, codeBlockStartIndex + codeBlockStart.length) + sanitizedBlock + comment.slice(codeBlockEndIndex);
      codeBlockStartIndex = comment.indexOf(
        codeBlockStart,
        codeBlockStartIndex + codeBlockStart.length + sanitizedBlock.length + codeBlockEnd.length
      );
    }
    return comment;
  }
  function sanitizeResponse(comment) {
    comment = sanitizeCodeBlock(comment, "suggestion");
    comment = sanitizeCodeBlock(comment, "diff");
    return comment;
  }
  for (const line of lines) {
    const lineNumberRangeMatch = line.match(lineNumberRangeRegex);
    if (lineNumberRangeMatch != null) {
      storeReview();
      currentStartLine = parseInt(lineNumberRangeMatch[1], 10);
      currentEndLine = parseInt(lineNumberRangeMatch[2], 10);
      currentComment = "";
      if (debug) {
        (0, import_core5.info)(`Found line number range: ${currentStartLine}-${currentEndLine}`);
      }
      continue;
    }
    if (line.trim() === commentSeparator) {
      storeReview();
      currentStartLine = null;
      currentEndLine = null;
      currentComment = "";
      if (debug) {
        (0, import_core5.info)("Found comment separator");
      }
      continue;
    }
    if (currentStartLine !== null && currentEndLine !== null) {
      currentComment += `${line}
`;
    }
  }
  storeReview();
  return reviews;
}

// src/review-comment.mts
var import_core6 = require("@actions/core");
var import_github3 = require("@actions/github");
var context3 = import_github3.context;
var repo3 = context3.repo;
var ASK_BOT = "@codesailorai";
var handleReviewComment = async (heavyBot, options, prompts) => {
  const commenter = new Commenter();
  const inputs = new Inputs();
  if (context3.eventName !== "pull_request_review_comment") {
    (0, import_core6.warning)(
      `Skipped: ${context3.eventName} is not a pull_request_review_comment event`
    );
    return;
  }
  if (!context3.payload) {
    (0, import_core6.warning)(`Skipped: ${context3.eventName} event is missing payload`);
    return;
  }
  const comment = context3.payload.comment;
  if (comment == null) {
    (0, import_core6.warning)(`Skipped: ${context3.eventName} event is missing comment`);
    return;
  }
  if (context3.payload.pull_request == null || context3.payload.repository == null) {
    (0, import_core6.warning)(`Skipped: ${context3.eventName} event is missing pull_request`);
    return;
  }
  inputs.title = context3.payload.pull_request.title;
  if (context3.payload.pull_request.body) {
    inputs.description = commenter.getDescription(
      context3.payload.pull_request.body
    );
  }
  if (context3.payload.action !== "created") {
    (0, import_core6.warning)(`Skipped: ${context3.eventName} event is not created`);
    return;
  }
  if (!comment.body.includes(COMMENT_TAG) && !comment.body.includes(COMMENT_REPLY_TAG)) {
    const pullNumber = context3.payload.pull_request.number;
    inputs.comment = `${comment.user.login}: ${comment.body}`;
    inputs.diff = comment.diff_hunk;
    inputs.filename = comment.path;
    const { chain: commentChain, topLevelComment } = await commenter.getCommentChain(pullNumber, comment);
    if (!topLevelComment) {
      (0, import_core6.warning)("Failed to find the top-level comment to reply to");
      return;
    }
    inputs.commentChain = commentChain;
    if (commentChain.includes(COMMENT_TAG) || commentChain.includes(COMMENT_REPLY_TAG) || comment.body.includes(ASK_BOT)) {
      let fileDiff = "";
      try {
        const diffAll = await octokit.repos.compareCommits({
          owner: repo3.owner,
          repo: repo3.repo,
          base: context3.payload.pull_request.base.sha,
          head: context3.payload.pull_request.head.sha
        });
        if (diffAll.data) {
          const files = diffAll.data.files;
          if (files != null) {
            const file = files.find(
              (f) => f.filename === comment.path
            );
            if (file != null && file.patch) {
              fileDiff = file.patch;
            }
          }
        }
      } catch (error2) {
        (0, import_core6.warning)(`Failed to get file diff: ${error2}, skipping.`);
      }
      if (inputs.diff.length === 0) {
        if (fileDiff.length > 0) {
          inputs.diff = fileDiff;
          fileDiff = "";
        } else {
          await commenter.reviewCommentReply(
            pullNumber,
            topLevelComment,
            "Cannot reply to this comment as diff could not be found."
          );
          return;
        }
      }
      let tokens = getTokenCount(prompts.renderComment(inputs));
      if (tokens > options.heavyTokenLimits.requestTokens) {
        await commenter.reviewCommentReply(
          pullNumber,
          topLevelComment,
          "Cannot reply to this comment as diff being commented is too large and exceeds the token limit."
        );
        return;
      }
      if (fileDiff.length > 0) {
        const fileDiffCount = prompts.comment.split("$file_diff").length - 1;
        const fileDiffTokens = getTokenCount(fileDiff);
        if (fileDiffCount > 0 && tokens + fileDiffTokens * fileDiffCount <= options.heavyTokenLimits.requestTokens) {
          tokens += fileDiffTokens * fileDiffCount;
          inputs.fileDiff = fileDiff;
        }
      }
      const summary = await commenter.findCommentWithTag(
        SUMMARIZE_TAG,
        pullNumber
      );
      if (summary) {
        const shortSummary = commenter.getShortSummary(summary.body);
        const shortSummaryTokens = getTokenCount(shortSummary);
        if (tokens + shortSummaryTokens <= options.heavyTokenLimits.requestTokens) {
          tokens += shortSummaryTokens;
          inputs.shortSummary = shortSummary;
        }
      }
      const reply = await heavyBot.chat(prompts.renderComment(inputs));
      await commenter.reviewCommentReply(pullNumber, topLevelComment, reply);
    }
  } else {
    (0, import_core6.info)(`Skipped: ${context3.eventName} event is from the bot itself`);
  }
};

// src/main.mts
async function run() {
  const options = new Options(
    (0, import_core7.getBooleanInput)("debug"),
    (0, import_core7.getBooleanInput)("disable_review"),
    (0, import_core7.getBooleanInput)("disable_release_notes"),
    (0, import_core7.getInput)("max_files"),
    (0, import_core7.getBooleanInput)("review_simple_changes"),
    (0, import_core7.getBooleanInput)("review_comment_lgtm"),
    (0, import_core7.getMultilineInput)("path_filters"),
    (0, import_core7.getInput)("system_message"),
    (0, import_core7.getInput)("openai_light_model"),
    (0, import_core7.getInput)("openai_heavy_model"),
    (0, import_core7.getInput)("openai_model_temperature"),
    (0, import_core7.getInput)("openai_retries"),
    (0, import_core7.getInput)("openai_timeout_ms"),
    (0, import_core7.getInput)("openai_concurrency_limit"),
    (0, import_core7.getInput)("github_concurrency_limit"),
    (0, import_core7.getInput)("language")
  );
  options.print();
  const prompts = new Prompts(
    (0, import_core7.getInput)("summarize"),
    (0, import_core7.getInput)("summarize_release_notes")
  );
  let lightBot = null;
  try {
    lightBot = new Bot(
      options,
      new OpenAIOptions(options.openaiLightModel, options.lightTokenLimits)
    );
  } catch (e) {
    (0, import_core7.warning)(
      `Skipped: failed to create summary bot, please check your openai_api_key: ${e}, backtrace: ${e.stack}`
    );
    return;
  }
  let heavyBot = null;
  try {
    heavyBot = new Bot(
      options,
      new OpenAIOptions(options.openaiHeavyModel, options.heavyTokenLimits)
    );
  } catch (e) {
    (0, import_core7.warning)(
      `Skipped: failed to create review bot, please check your openai_api_key: ${e}, backtrace: ${e.stack}`
    );
    return;
  }
  try {
    if (process.env.GITHUB_EVENT_NAME === "pull_request" || process.env.GITHUB_EVENT_NAME === "pull_request_target") {
      await codeReview(lightBot, heavyBot, options, prompts);
    } else if (process.env.GITHUB_EVENT_NAME === "pull_request_review_comment") {
      await handleReviewComment(heavyBot, options, prompts);
    } else {
      (0, import_core7.warning)("Skipped: this action only works on push events or pull_request");
    }
  } catch (e) {
    if (e instanceof Error) {
      (0, import_core7.setFailed)(`Failed to run: ${e.message}, backtrace: ${e.stack}`);
    } else {
      (0, import_core7.setFailed)(`Failed to run: ${e}, backtrace: ${e.stack}`);
    }
  }
}
process.on("unhandledRejection", (reason, p) => {
  (0, import_core7.warning)(`Unhandled Rejection at Promise: ${reason}, promise is ${p}`);
}).on("uncaughtException", (e) => {
  (0, import_core7.warning)(`Uncaught Exception thrown: ${e}, backtrace: ${e.stack}`);
});
async function main() {
  await run();
}
main();
