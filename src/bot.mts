import { RunnableSequence, RunnableMap } from '@langchain/core/runnables';
import { AzureChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { BaseMemory } from '@langchain/core/memory';
import { AIMessage, HumanMessage, BaseMessage } from '@langchain/core/messages';
import { info, setFailed, warning } from '@actions/core';
import { Options, OpenAIOptions } from './options.mjs';
import './fetch-polyfill';

export class SimpleMemory extends BaseMemory {
  private history: BaseMessage[] = [];

  get memoryKeys(): string[] {
    return ['history'];
  }

  async loadMemoryVariables(_: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { history: this.history };
  }

  async saveContext(input: Record<string, unknown>, output: Record<string, unknown>): Promise<void> {
    if (input.input) this.history.push(new HumanMessage(input.input as string));
    if (output.output) this.history.push(new AIMessage(output.output as string));
  }

  async clear(): Promise<void> {
    this.history = [];
  }
}

export interface Ids {
  parentMessageId?: string;
  conversationId?: string;
}

export class Bot {
  private readonly model: AzureChatOpenAI;
  private readonly chain: RunnableSequence<{ input: string }, { output: string }>;
  private readonly memory: SimpleMemory;
  private readonly options: Options;

  constructor(options: Options, openaiOptions: OpenAIOptions) {
    this.options = options;

    if (
      process.env.AZURE_OPENAI_API_KEY &&
      process.env.AZURE_OPENAI_API_VERSION &&
      process.env.AZURE_OPENAI_API_INSTANCE_NAME &&
      process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME
    ) {
      const currentDate = new Date().toISOString().split('T')[0];
      const systemMessage = `${options.systemMessage}
Knowledge cutoff: ${openaiOptions.tokenLimits.knowledgeCutOff}
Current date: ${currentDate}

IMPORTANT: Entire response must be in the language with ISO code: ${options.language}
      `;

      const chatPrompt = ChatPromptTemplate.fromMessages([
        ['system', systemMessage],
        new MessagesPlaceholder('history'),
        ['human', '{input}'],
      ]);

      this.model = new AzureChatOpenAI({
        temperature: options.openaiModelTemperature,
        azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
        azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION,
        azureOpenAIApiInstanceName: process.env.AZURE_OPENAI_API_INSTANCE_NAME,
        azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME,
        timeout: options.openaiTimeoutMS,
        maxRetries: options.openaiRetries,
      });

      this.memory = new SimpleMemory();

      const inputRunnable = RunnableMap.from({
        input: (input: { input: string }) => input.input,
        history: async () => this.memory.loadMemoryVariables({}).then(v => v.history),
      });

      this.chain = RunnableSequence.from([
        inputRunnable,
        chatPrompt,
        this.model,
        {
          output: async (response: any) => {
            if (response?.content) {
              return response.content;
            }
            return '';
          },
        },
      ]);
    } else {
      throw new Error('Unable to initialize the OpenAI API, AZURE_OPENAI_API_* environment variables are not available.');
    }
  }

  chat = async (message: string): Promise<string> => {
    try {
      return await this.chat_(message);
    } catch {
      return '';
    }
  };

  private readonly chat_ = async (message: string): Promise<string> => {
    const start = Date.now();
    if (!message) {
      return '';
    }

    if (!this.chain) {
      setFailed('The OpenAI API is not initialized');
      return '';
    }

    try {
      const result = await this.chain.invoke({ input: message });

      await this.memory.saveContext({ input: message }, { output: result.output });

      const end = Date.now();
      info(`openai sendMessage (including retries) response time: ${end - start} ms`);

      let responseText = result?.output ?? '';
      if (responseText.startsWith('with ')) {
        responseText = responseText.substring(5);
      }

      if (this.options.debug) {
        info(`openai responses: ${responseText}`);
      }

      return responseText;
    } catch (e: unknown) {
      warning(`Failed to send message to openai: ${e}`);
      return '';
    }
  };
}
