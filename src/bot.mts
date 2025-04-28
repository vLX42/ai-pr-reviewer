import './fetch-polyfill'

import {info, setFailed, warning} from '@actions/core'
import {RunnableSequence} from '@langchain/core/runnables'
import {AzureChatOpenAI} from '@langchain/openai'
import {BaseMemory} from '@langchain/core/memory'
import {AIMessage, HumanMessage, BaseMessage} from '@langchain/core/messages'

import {ChatPromptTemplate, MessagesPlaceholder} from '@langchain/core/prompts'
import {OpenAIOptions, Options} from './options.mjs'
// import { HumanMessage, AIMessage } from "@langchain/core/messages";
// import { RunnableConfig } from "@langchain/core/runnables";

export class SimpleMemory extends BaseMemory {
  private history: BaseMessage[] = []

  get memoryKeys(): string[] {
    return ['history']
  }

  async loadMemoryVariables(
    _: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return {history: this.history}
  }

  async saveContext(
    input: Record<string, unknown>,
    output: Record<string, unknown>
  ): Promise<void> {
    if (input.input) {
      this.history.push(new HumanMessage(input.input as string))
    }
    if (output.output) {
      this.history.push(new AIMessage(output.output as string))
    }
  }

  async clear(): Promise<void> {
    this.history = []
  }
}

export interface Ids {
  parentMessageId?: string
  conversationId?: string
}

export class Bot {
  private readonly model: AzureChatOpenAI | null = null
  private readonly chain: RunnableSequence<
    {input: string},
    {output: string}
  > | null = null
  private readonly memory: SimpleMemory | null = null
  private readonly options: Options

  constructor(options: Options, openaiOptions: OpenAIOptions) {
    this.options = options

    if (
      process.env.AZURE_OPENAI_API_KEY &&
      process.env.AZURE_OPENAI_API_VERSION &&
      process.env.AZURE_OPENAI_API_INSTANCE_NAME &&
      process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME
    ) {
      const currentDate = new Date().toISOString().split('T')[0]
      const systemMessage = `${options.systemMessage}
Knowledge cutoff: ${openaiOptions.tokenLimits.knowledgeCutOff}
Current date: ${currentDate}

IMPORTANT: Entire response must be in the language with ISO code: ${options.language}
      `

      const chatPrompt = ChatPromptTemplate.fromMessages([
        ['system', systemMessage],
        new MessagesPlaceholder('history'),
        ['human', '{input}']
      ])

      this.model = new AzureChatOpenAI({
        temperature: options.openaiModelTemperature,
        azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
        azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION,
        azureOpenAIApiInstanceName: process.env.AZURE_OPENAI_API_INSTANCE_NAME,
        azureOpenAIApiDeploymentName:
          process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME,
        timeout: options.openaiTimeoutMS,
        maxRetries: options.openaiRetries
      })

      this.memory = new SimpleMemory()

      this.chain = RunnableSequence.from([
        {
          input: (input: {input: string}) => input.input,
          memory: this.memory
        },
        chatPrompt,
        this.model,
        {
          output: async (response: any) => {
            if (response?.content) {
              return response.content
            }
            return ''
          }
        }
      ])
    } else {
      const err =
        'Unable to initialize the OpenAI API, AZURE_OPENAI_API_* environment variables are not available.'
      throw new Error(err)
    }
  }

  chat = async (message: string): Promise<string> => {
    try {
      return await this.chat_(message)
    } catch {
      return ''
    }
  }

  private readonly chat_ = async (message: string): Promise<string> => {
    const start = Date.now()
    if (!message) {
      return ''
    }

    if (!this.chain || !this.memory) {
      setFailed('The OpenAI API or memory is not initialized')
      return ''
    }

    try {
      // Load history from memory
      const memoryVariables = await this.memory.loadMemoryVariables({})
      const inputWithMemory = {input: message, ...memoryVariables}

      // Send to chain
      const result = await this.chain.invoke(inputWithMemory)

      // Save interaction back into memory
      await this.memory.saveContext({input: message}, {output: result.output})

      const end = Date.now()
      info(
        `openai sendMessage (including retries) response time: ${end - start} ms`
      )

      let responseText = result?.output ?? ''
      if (responseText.startsWith('with ')) {
        responseText = responseText.substring(5)
      }

      if (this.options.debug) {
        info(`openai responses: ${responseText}`)
      }

      return responseText
    } catch (e: unknown) {
      warning(`Failed to send message to openai: ${e}`)
      return ''
    }
  }
}
